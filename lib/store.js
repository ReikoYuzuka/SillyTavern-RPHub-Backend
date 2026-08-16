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

import fs from 'node:fs';
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
 * 原子写 JSON：写临时文件 + rename 替换。compact 序列化（省磁盘，机器数据无需 pretty）。
 */
function atomicWriteJson(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
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
        // 读缓存：normalized 文件写入后不再变（cardId 每次导入唯一），按 mtime+size 校验失效；
        // index 每次 upload 重写，写后清缓存。
        this._normalizedCache = new Map(); // cardId -> { mtimeMs, size, data }
        this._indexCache = null; // { mtimeMs, size, data } | null
        this._ensureDirs();
    }

    /** 校验/刷新进程内读缓存：命中（mtime+size 一致）返回缓存，否则重读 */
    _cacheRead(key, cache, filePath) {
        const isMap = cache instanceof Map;
        let st;
        try {
            st = fs.statSync(filePath);
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw errorIo('读取文件元数据失败', { operation: filePath });
        }
        const hit = isMap ? cache.get(key) : cache;
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            if (isMap) { // LRU 刷新位置
                cache.delete(key);
                cache.set(key, hit);
            }
            return hit.data;
        }
        let data;
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw errorIo('读取文件失败', { operation: filePath });
        }
        const entry = { mtimeMs: st.mtimeMs, size: st.size, data };
        if (isMap) {
            cache.set(key, entry);
            if (cache.size > CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                cache.delete(oldest);
            }
        } else {
            this._indexCache = entry;
        }
        return data;
    }

    _ensureDirs() {
        for (const dir of [this.dataDir, this.rawDir, this.normalizedDir, this.importsDir]) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (err) {
                throw errorIo(`创建目录失败：${dir}`, { operation: dir });
            }
        }
    }

    // ---------- index.json ----------

    readIndex() {
        // 命中读缓存（mtime+size 校验）避免每次 GET 全量读+parse；文件不存在返回空索引
        const cached = this._cacheRead(null, this._indexCache, this.indexPath, null);
        if (cached !== undefined && cached !== null) return cached;
        return { version: 1, cards: {} };
    }

    writeIndex(index) {
        atomicWriteJson(this.indexPath, index);
        this._indexCache = null; // 写后失效，下次读按新 mtime 重载
    }

    /** 卡是否存在 */
    hasCard(cardId) {
        return !!this.readIndex().cards[cardId];
    }

    /** 成功路径的收尾：把元数据写进 index.json（原子替换） */
    addCardEntry(cardId, meta) {
        const index = this.readIndex();
        index.cards[cardId] = meta;
        this.writeIndex(index);
    }

    /** 按 contentHash 查已导入的 cardId（导入去重预检）；未导入返回 null */
    findByContentHash(contentHash) {
        const index = this.readIndex();
        for (const [cid, meta] of Object.entries(index.cards || {})) {
            if (meta && typeof meta === 'object' && meta.contentHash === contentHash) return cid;
        }
        return null;
    }

    // ---------- marks.json ----------

    readMarks() {
        try {
            if (!fs.existsSync(this.marksPath)) return { version: 1, marks: {} };
            const parsed = JSON.parse(fs.readFileSync(this.marksPath, 'utf8'));
            return { version: 1, marks: (parsed && typeof parsed.marks === 'object') ? parsed.marks : {} };
        } catch (err) {
            throw errorIo('读取 marks.json 失败', { operation: this.marksPath });
        }
    }

    writeMarks(marksData) {
        atomicWriteJson(this.marksPath, marksData);
    }

    // ---------- 卡数据文件 ----------

    /** 写 raw/、normalized/、imports/ 三处；失败时回滚已写文件 */
    writeCardFiles(cardId, { blocksData, originalData, normalizedData, importRecord }) {
        // 父目录可能在运行期被清理（如测试后清空 data/），写前确保存在
        this._ensureDirs();
        const rawDir = path.join(this.rawDir, cardId);
        const written = [];
        try {
            fs.mkdirSync(rawDir, { recursive: true });
            written.push({ type: 'dir', p: rawDir });

            const blocksPath = path.join(rawDir, 'blocks.json');
            fs.writeFileSync(blocksPath, JSON.stringify(blocksData), 'utf8');
            written.push({ type: 'file', p: blocksPath });

            const originalPath = path.join(rawDir, 'original.json');
            fs.writeFileSync(originalPath, JSON.stringify(originalData), 'utf8');
            written.push({ type: 'file', p: originalPath });

            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            fs.writeFileSync(normalizedPath, JSON.stringify(normalizedData), 'utf8');
            written.push({ type: 'file', p: normalizedPath });

            const importPath = path.join(this.importsDir, `${cardId}.json`);
            fs.writeFileSync(importPath, JSON.stringify(importRecord), 'utf8');
            written.push({ type: 'file', p: importPath });
        } catch (err) {
            this._rollback(written);
            if (err instanceof Error && err.code === 'ENOENT') {
                throw errorIo('写入卡文件失败（目录不可写）', { operation: this.dataDir });
            }
            throw errorIo('写入卡文件失败', { operation: cardId });
        }
    }

    _rollback(written) {
        // 逆序清理：先文件后目录
        for (let i = written.length - 1; i >= 0; i--) {
            const item = written[i];
            try {
                if (item.type === 'file') {
                    if (fs.existsSync(item.p)) fs.unlinkSync(item.p);
                } else {
                    fs.rmdirSync(item.p, { recursive: false });
                }
            } catch { /* ignore */ }
        }
    }

    /** 回滚 upload：删除某 cardId 全部已写文件（index.json 不在此列，调用方保证未写） */
    removeCardFiles(cardId) {
        try {
            const rawDir = path.join(this.rawDir, cardId);
            if (fs.existsSync(rawDir)) fs.rmSync(rawDir, { recursive: true, force: true });
            const normalizedPath = path.join(this.normalizedDir, `${cardId}.json`);
            if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
            const importPath = path.join(this.importsDir, `${cardId}.json`);
            if (fs.existsSync(importPath)) fs.unlinkSync(importPath);
        } catch { /* ignore */ }
    }

    // ---------- 读路径 ----------

    readNormalized(cardId) {
        // 进程内缓存（mtime+size 校验，LRU）：分页/字段请求不再每次全量读+parse 大文件
        return this._cacheRead(cardId, this._normalizedCache, path.join(this.normalizedDir, `${cardId}.json`));
    }

    readRawBlocks(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'blocks.json');
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始块失败', { operation: cardId });
        }
    }

    readRawOriginal(cardId) {
        try {
            const p = path.join(this.rawDir, cardId, 'original.json');
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始 JSON 失败', { operation: cardId });
        }
    }

    // ---------- 元数据（ETag 用，避免读全文件） ----------

    /** normalized 文件元数据：{ mtimeMs, size }；不存在返回 null */
    statNormalized(cardId) {
        try {
            const p = path.join(this.normalizedDir, `${cardId}.json`);
            const st = fs.statSync(p);
            return { mtimeMs: st.mtimeMs, size: st.size };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取规范化数据元数据失败', { operation: cardId });
        }
    }

    /** raw 目录元数据（blocks + original 文件的最大 mtime/size 合并）；不存在返回 null */
    statRaw(cardId) {
        try {
            const dir = path.join(this.rawDir, cardId);
            const blocks = path.join(dir, 'blocks.json');
            const original = path.join(dir, 'original.json');
            let sig = '';
            for (const p of [blocks, original]) {
                const st = fs.statSync(p);
                sig += `|${st.mtimeMs}:${st.size}`;
            }
            return { mtimeMs: 0, size: 0, sig };
        } catch (err) {
            if (err instanceof Error && err.code === 'ENOENT') return null;
            throw errorIo('读取原始数据元数据失败', { operation: cardId });
        }
    }
}
