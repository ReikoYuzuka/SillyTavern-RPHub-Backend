// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/store.js — data/ 目录读写、cardId 生成、index.json/marks.json 原子更新
//
// 布局（见 数据存储/README.md）：
//   data/
//   ├── index.json            cardId → 轻量元数据（接口查询入口）
//   ├── marks.json            手动标记（contentHash → 标记）
//   ├── raw/{cardId}/         blocks.json + original.json
//   ├── normalized/{cardId}.json
//   └── imports/{cardId}.json 导入记录
//
// 写入约定：upload 内串行；normalized/raw/imports 先写，最后原子替换 index.json。

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { errorIo } from './errors.js';

export const SCHEMA_VERSION = 2;

/** 进程内读缓存上限（LRU） */
const CACHE_LIMIT = 50;

export function computeContentHash(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 生成 cardId：c + 16 位十六进制。
 * 哈希输入 = 规范化前原始字节 sha256 前 8 字节 + 角色名 + 导入时间戳，
 * 保证同一张卡重复导入得到不同 cardId。
 */
export function generateCardId(buffer, characterName, importedAtIso) {
    const hash = createHash('sha256')
        .update(computeContentHash(buffer))
        .update(characterName || '')
        .update(importedAtIso)
        .digest('hex');
    return 'c' + hash.slice(0, 16);
}

export const CARD_ID_RE = /^c[0-9a-f]{16}$/;
export const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export function isValidCardId(id) {
    return typeof id === 'string' && CARD_ID_RE.test(id);
}

export function isValidContentHash(hash) {
    return typeof hash === 'string' && CONTENT_HASH_RE.test(hash);
}

/**
 * 异步原子写 JSON：写临时文件 + rename 替换。compact 序列化（省磁盘，机器数据无需 pretty）。
 */
async function atomicWriteJson(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
        await fsPromises.writeFile(tmpPath, JSON.stringify(data), 'utf8');
        await fsPromises.rename(tmpPath, filePath);
    } catch (err) {
        try {
            await fsPromises.unlink(tmpPath);
        } catch { /* ignore */ }
        throw errorIo(`写入文件失败：${filePath}`, { operation: filePath });
    }
}

export class Store {
    /**
     * @param {string} dataDir data/ 目录绝对路径
     */
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.rawDir = path.join(dataDir, 'raw');
        this.normalizedDir = path.join(dataDir, 'normalized');
        this.importsDir = path.join(dataDir, 'imports');
        this.indexPath = path.join(dataDir, 'index.json');
        this.marksPath = path.join(dataDir, 'marks.json');

        // 读缓存：
        // normalized 文件写入后不可变（cardId 每次导入唯一），Map 命中直接返回数据，不再重复 stat；
        // index 内存直接同步维护，避免每次重新从磁盘读取。
        this._normalizedCache = new Map(); // cardId -> data
        this._indexCache = null;           // { mtimeMs, size, data } | null

        // marks.json 并发更新锁（链式 Promise 互斥）
        this._marksMutex = Promise.resolve();

        // index.json 并发更新锁（F-4：链式 Promise 互斥，读写同锁串行化，
        // 关闭「读者旧 stat × 写者新缓存」交错导致的脏缓存投毒与并发上传丢条目）
        this._indexMutex = Promise.resolve();

        // 异步确保目录初始化 Promise
        this._dirsReady = this._ensureDirs();
    }

    async _ensureDirs() {
        for (const dir of [this.dataDir, this.rawDir, this.normalizedDir, this.importsDir]) {
            try {
                await fsPromises.mkdir(dir, { recursive: true });
            } catch (err) {
                throw errorIo(`创建目录失败：${dir}`, { operation: dir });
            }
        }
    }

    // ---------- index.json ----------

    /**
     * index 临界区统一入口（F-4）。链式 Promise 互斥，读写全部串行化。
     *
     * 约束（见《修复方案验证报告》§二 A，违反将死锁/丢修改）：
     *   - 链式 Promise 锁【不可重入】：fn 内部严禁再调用任何公开加锁方法
     *     （readIndex/writeIndex/addCardEntry/updateIndexSafely/updateMarksSafely），
     *     只能使用 _readIndexUnlocked/_writeIndexUnlocked 无锁原语——否则 fn 会等待
     *     自己正持有的锁而永久死锁；
     *   - 进锁前先 await this._dirsReady，避免持锁等待目录初始化拉长临界区；
     *   - fn 返回值（含 Promise）会被 await：允许异步函数，但请保持临界区短小。
     * @param {() => Promise<any>|any} fn 临界区内执行的操作
     */
    async _withIndexLock(fn) {
        let release;
        const currentLock = this._indexMutex;
        this._indexMutex = new Promise((resolve) => { release = resolve; });
        try {
            await this._dirsReady;
            await currentLock;
            return await fn();
        } finally {
            release();
        }
    }

    /** 无锁读 index（仅供持锁上下文使用；逻辑与旧 readIndex 一致：stat 校验 → 缓存命中 → 读盘直更缓存） */
    async _readIndexUnlocked() {
        let st;
        try {
            st = await fsPromises.stat(this.indexPath);
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, cards: {} };
            throw errorIo('读取索引元数据失败', { operation: this.indexPath });
        }

        if (this._indexCache && this._indexCache.mtimeMs === st.mtimeMs && this._indexCache.size === st.size) {
            return this._indexCache.data;
        }

        let data;
        try {
            data = JSON.parse(await fsPromises.readFile(this.indexPath, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, cards: {} };
            throw errorIo('读取索引文件失败', { operation: this.indexPath });
        }

        this._indexCache = { mtimeMs: st.mtimeMs, size: st.size, data };
        return data;
    }

    /** 无锁原子写 index 并直更内存缓存（仅供持锁上下文使用；rename 后 stat+赋值与写同处一个临界区，杜绝交错投毒） */
    async _writeIndexUnlocked(index) {
        await atomicWriteJson(this.indexPath, index);
        try {
            const st = await fsPromises.stat(this.indexPath);
            this._indexCache = { mtimeMs: st.mtimeMs, size: st.size, data: index };
        } catch {
            this._indexCache = null;
        }
    }

    /** 读 index（加锁）。所有查询路径经此获得与写入一致的视图 */
    readIndex() {
        return this._withIndexLock(() => this._readIndexUnlocked());
    }

    /** 整体覆盖写 index（加锁）。常规「读-改-写」应使用 updateIndexSafely 而非先读后写两段式 */
    writeIndex(index) {
        return this._withIndexLock(() => this._writeIndexUnlocked(index));
    }

    /**
     * index 读-改-写原子操作（F-4）：锁内读出 → updater 原地变异 → 锁内原子落盘并直更缓存。
     * updater 的返回值作为本方法返回值透传。
     * @param {(index: object) => Promise<any>|any} updater 同步或异步变异函数（会被 await；
     *   内部不得调用任何公开加锁方法，见 _withIndexLock 约束）
     */
    updateIndexSafely(updater) {
        return this._withIndexLock(async () => {
            const index = await this._readIndexUnlocked();
            const result = await updater(index);
            await this._writeIndexUnlocked(index);
            return result;
        });
    }

    /** 卡是否存在 */
    async hasCard(cardId) {
        const index = await this.readIndex();
        return !!(index.cards && index.cards[cardId]);
    }

    /** 成功路径的收尾：把元数据原子写进 index.json（F-4：经互斥锁，杜绝并发上传丢条目） */
    addCardEntry(cardId, meta) {
        return this.updateIndexSafely((index) => {
            if (!index.cards) index.cards = {};
            index.cards[cardId] = meta;
        });
    }

    /**
     * 回滚一次上传（F-3 补偿）：锁内摘除 index 条目并原子落盘，锁外删除本次已写的全部文件，
     * 保证「索引-磁盘」最终一致。修复前 upload 收尾只裸删文件——addCardEntry 成功后的失败会
     * 留下指向缺失文件的索引条目（exists 预检误报 true、列表查询 404 的自相矛盾状态）。
     * 补偿路径尽力而为：索引摘除失败不阻塞文件清理，错误上报由调用方的原始异常主导。
     * @param {string} cardId 本次上传的 cardId
     */
    async rollbackUpload(cardId) {
        try {
            await this.updateIndexSafely((index) => {
                if (index.cards) delete index.cards[cardId];
            });
        } catch { /* 尽力而为：索引摘除失败仍继续删文件 */ }
        await this.removeCardFiles(cardId);
    }

    /** 按 contentHash 查已导入的 cardId（导入去重预检）；未导入返回 null */
    async findByContentHash(contentHash) {
        const index = await this.readIndex();
        for (const [cid, meta] of Object.entries(index.cards || {})) {
            if (meta && typeof meta === 'object' && meta.contentHash === contentHash) return cid;
        }
        return null;
    }

    // ---------- marks.json ----------

    async readMarks() {
        await this._dirsReady;
        try {
            const content = await fsPromises.readFile(this.marksPath, 'utf8');
            const parsed = JSON.parse(content);
            return { version: 1, marks: (parsed && typeof parsed.marks === 'object') ? parsed.marks : {} };
        } catch (err) {
            if (err.code === 'ENOENT') return { version: 1, marks: {} };
            throw errorIo('读取 marks.json 失败', { operation: this.marksPath });
        }
    }

    async writeMarks(marksData) {
        await this._dirsReady;
        await atomicWriteJson(this.marksPath, marksData);
    }

    /**
     * 并发安全标记修改（读取-修改-落盘互斥锁）
     * @param {(marksData: { version: number, marks: object }) => any} updater
     * @returns {Promise<any>} updater 的返回值
     */
    async updateMarksSafely(updater) {
        let release;
        const currentLock = this._marksMutex;
        this._marksMutex = new Promise((resolve) => { release = resolve; });
        try {
            await currentLock;
            const marksData = await this.readMarks();
            const result = updater(marksData);
            await this.writeMarks(marksData);
            return result;
        } finally {
            release();
        }
    }

    // ---------- 卡数据文件 ----------

    /** 写 raw/、normalized/、imports/ 三处；失败时回滚已写文件 */
    async writeCardFiles(cardId, { blocksData, originalData, normalizedData, importRecord }) {
        await this._ensureDirs();
        const rawDir = path.join(this.rawDir, cardId);
        const written = [];
        try {
            await fsPromises.mkdir(rawDir, { recursive: true });
            written.push({ type: 'dir', p: rawDir });

            const blocksPath = path.join(rawDir, 'blocks.json');
            await fsPromises.writeFile(blocksPath, JSON.stringify(blocksData), 'utf8');
            written.push({ type: 'file', p: blocksPath });

            const originalPath = path.join(rawDir, 'original.json');
            await fsPromises.writeFile(originalPath, JSON.stringify(originalData), 'utf8');
            written.push({ type: 'file', p: originalPath });

            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            await fsPromises.writeFile(normalizedPath, JSON.stringify(normalizedData), 'utf8');
            written.push({ type: 'file', p: normalizedPath });

            const importPath = path.join(this.importsDir, `${cardId}.json`);
            await fsPromises.writeFile(importPath, JSON.stringify(importRecord), 'utf8');
            written.push({ type: 'file', p: importPath });

            // 写入成功后，直接放入内存缓存
            this._setNormalizedCache(cardId, normalizedData);
        } catch (err) {
            await this._rollbackAsync(written);
            if (err instanceof Error && err.code === 'ENOENT') {
                throw errorIo('写入卡文件失败（目录不可写）', { operation: this.dataDir });
            }
            throw errorIo('写入卡文件失败', { operation: cardId });
        }
    }

    async _rollbackAsync(written) {
        // 逆序清理：先文件后目录
        for (let i = written.length - 1; i >= 0; i--) {
            const item = written[i];
            try {
                if (item.type === 'file') {
                    await fsPromises.unlink(item.p);
                } else {
                    await fsPromises.rmdir(item.p);
                }
            } catch { /* ignore */ }
        }
    }

    /** 回滚 upload：删除某 cardId 全部已写文件（index.json 不在此列，调用方保证未写） */
    async removeCardFiles(cardId) {
        try {
            this._normalizedCache.delete(cardId);
            const rawDir = path.join(this.rawDir, cardId);
            await fsPromises.rm(rawDir, { recursive: true, force: true }).catch(() => {});
            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            await fsPromises.unlink(normalizedPath).catch(() => {});
            const importPath = path.join(this.importsDir, `${cardId}.json`);
            await fsPromises.unlink(importPath).catch(() => {});
        } catch { /* ignore */ }
    }

    // ---------- 读路径 ----------

    _setNormalizedCache(cardId, data) {
        this._normalizedCache.set(cardId, data);
        if (this._normalizedCache.size > CACHE_LIMIT) {
            const oldest = this._normalizedCache.keys().next().value;
            this._normalizedCache.delete(oldest);
        }
    }

    async readNormalized(cardId) {
        // normalized 卡片数据具备不可变性（cardId 导入唯一），优先命中内存 Map，不再重复 stat
        if (this._normalizedCache.has(cardId)) {
            const data = this._normalizedCache.get(cardId);
            // LRU 刷新
            this._normalizedCache.delete(cardId);
            this._normalizedCache.set(cardId, data);
            return data;
        }

        const filePath = path.join(this.normalizedDir, `${cardId}.json`);
        let data;
        try {
            const content = await fsPromises.readFile(filePath, 'utf8');
            data = JSON.parse(content);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw errorIo('读取文件失败', { operation: filePath });
        }

        this._setNormalizedCache(cardId, data);
        return data;
    }

    async readRawBlocks(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'blocks.json');
            return JSON.parse(await fsPromises.readFile(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始块失败', { operation: cardId });
        }
    }

    async readRawOriginal(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'original.json');
            return JSON.parse(await fsPromises.readFile(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始 JSON 失败', { operation: cardId });
        }
    }

    // ---------- 元数据（ETag 用，避免读全文件） ----------

    /** normalized 文件元数据：{ mtimeMs, size }；不存在返回 null */
    async statNormalized(cardId) {
        try {
            const p = path.join(this.normalizedDir, `${cardId}.json`);
            const st = await fsPromises.stat(p);
            return { mtimeMs: st.mtimeMs, size: st.size };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取规范化数据元数据失败', { operation: cardId });
        }
    }

    /** raw 目录元数据（blocks + original 文件的最大 mtime/size 合并）；不存在返回 null */
    async statRaw(cardId) {
        try {
            const dir = path.join(this.rawDir, cardId);
            const blocks = path.join(dir, 'blocks.json');
            const original = path.join(dir, 'original.json');
            let sig = '';
            for (const p of [blocks, original]) {
                const st = await fsPromises.stat(p);
                sig += `|${st.mtimeMs}:${st.size}`;
            }
            return { mtimeMs: 0, size: 0, sig };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始数据元数据失败', { operation: cardId });
        }
    }
}
