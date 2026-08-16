// lib/router.js — 全部路由挂载（见 接口契约/）
//
// {BASE} = /api/plugins/rp-hub-compat（由 ST plugin-loader 自动挂载）
//
// 路由表：
//   POST {BASE}/v1/cards/upload       主入口：嗅探→解析→规范化→落盘→映射
//   POST {BASE}/v1/cards/analyze      辅助：卡面判断，不落盘
//   GET  {BASE}/v1/cards/{cardId}     全部规范化数据
//   GET  {BASE}/v1/cards/{cardId}/character
//   GET  {BASE}/v1/cards/{cardId}/regex
//   GET  {BASE}/v1/cards/{cardId}/lorebook
//   GET  {BASE}/v1/cards/{cardId}/variables
//   GET  {BASE}/v1/cards/{cardId}/raw
//   GET  {BASE}/v1/cards/{cardId}/mapping
//   GET  {BASE}/v1/marks
//   GET  {BASE}/v1/marks/{contentHash}
//   PUT  {BASE}/v1/marks/{contentHash}
//   DELETE {BASE}/v1/marks/{contentHash}
//   GET  {BASE}/v1/status
//
// 错误路径：统一 JSON 错误体 + 404 ROUTE_NOT_FOUND 兜底。

import express from 'express';
import { errorHandler, errorUnprocessable, errNotFound, errInvalidCardId, errInvalidContentHash, errUnsupportedMarkType } from './errors.js';
import { Store, SCHEMA_VERSION, computeContentHash, generateCardId, isValidCardId, isValidContentHash } from './store.js';
import { runPipeline } from './pipeline.js';
import { setMark, clearMark, listMarks, getMarkStatus, isSupportedMarkType } from './marks.js';
import { buildStandardCard, writeBackToSt } from './writeback.js';

function assertCardId(cardId) {
    if (!isValidCardId(cardId)) throw errInvalidCardId();
}

function assertContentHash(hash) {
    if (!isValidContentHash(hash)) throw errInvalidContentHash();
}

function readBody(req) {
    return Buffer.from(req.body || []);
}

function summaryCounts(normalized) {
    return {
        regex: normalized.regex.length,
        lorebook: normalized.lorebook.length,
        firstMes: !!(normalized.character && normalized.character.first_mes),
        variables: normalized.variables ? (normalized.variables.uiTemplates?.length || 0) : 0,
    };
}

function uploadResponse(payload, marked) {
    return {
        cardId: payload.cardId,
        contentHash: payload.contentHash,
        marked,
        format: payload.format,
        summary: {
            formatDetail: payload.formatDetail,
            detectedAt: new Date().toISOString(),
            features: payload.features,
            counts: summaryCounts(payload.normalized),
            mappingSummary: payload.normalized.mappingSummary,
        },
    };
}

/**
 * 挂载全部路由。
 * @param {import('express').Router} router
 * @param {object} context { dataDir }
 */
export function registerRoutes(router, context) {
    const store = new Store(context.dataDir);

    // ST 只全局挂了 bodyParser.json/urlencoded，没有 raw 解析器。
    // 插件自己挂 raw 解析（仅 application/octet-stream），保证 upload/analyze 拿到原始字节。
    const rawParser = express.raw({ type: 'application/octet-stream', limit: '200mb' });

    // ---------- upload ----------
    router.post('/v1/cards/upload', rawParser, (req, res, next) => {
        let pendingCardId = null;
        try {
            const buffer = readBody(req);
            // 前端 X-Filename 为 encodeURIComponent 编码（中文文件名 → fetch header 只接受 <256 字节），
            // 这里 decodeURIComponent 还原；解码失败（非编码串/异常）原样保留。
            const rawName = typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : null;
            let sourceFile = rawName;
            if (rawName) { try { sourceFile = decodeURIComponent(rawName); } catch { /* 原样保留 */ } }

            const contentHash = computeContentHash(buffer);
            const marksData = store.readMarks();
            const mark = marksData.marks[contentHash];
            const forcedFormatDetail = mark && mark.type === 'rphub' ? 'rphub' : undefined;

            // 嗅探 → 解析 → 语义判定（含标记覆盖）→ 规范化
            const payload = runPipeline(buffer, forcedFormatDetail);
            const { format, formatDetail, normalized, features, data, blocks } = payload;

            const characterName = (normalized.character && normalized.character.name) || 'Unknown';
            const importedAt = new Date().toISOString();
            const cardId = generateCardId(buffer, characterName, importedAt);
            pendingCardId = cardId;

            // 落盘：normalized / raw / imports 先写，最后原子更新 index.json
            const originalData = {
                cardId,
                format,
                original: {
                    spec: payload.spec,
                    data,
                },
            };
            const blocksData = { cardId, format, blocks };
            const importRecord = {
                cardId,
                importedAt,
                sourceFile,
                format,
                formatDetail,
                features,
                mappingSummary: normalized.mappingSummary,
                contentHash,
            };

            store.writeCardFiles(cardId, { blocksData, originalData, normalizedData: { ...normalized, schema_version: SCHEMA_VERSION, cardId, format, formatDetail, importedAt, sourceFile }, importRecord });
            store.addCardEntry(cardId, {
                format,
                formatDetail,
                characterName,
                importedAt,
                regexCount: normalized.regex.length,
                lorebookCount: normalized.lorebook.length,
                contentHash,
            });

            const responseData = uploadResponse({ cardId, contentHash, format, formatDetail, features, normalized }, !!mark);

            // writeBack=1：把规范化数据构造成 ST 标准角色卡 PNG，直接写入当前登录用户（request.user）
            // 的 ST 角色目录。失败不阻塞主流程：卡数据已落盘，standardCard 置 null + 错误信息。
            if (req.query.writeBack === '1') {
                try {
                    const charactersDir = req.user?.directories?.characters;
                    if (!charactersDir) {
                        throw new Error('request.user.directories.characters 不可用（未登录上下文）');
                    }
                    const result = writeBackToSt(normalized, { format, buffer, charactersDir });
                    responseData.standardCard = { avatar: result.avatarFileName };
                } catch (err) {
                    console.error('[rp-hub-compat] writeBack 写回失败（不影响本次上传落盘）:', err);
                    responseData.standardCard = {
                        avatar: null,
                        error: { message: err instanceof Error ? err.message : String(err) },
                    };
                }
            }

            res.status(200).json(responseData);
        } catch (err) {
            // 失败无副作用：删除本次已写文件；index.json 在 addCardEntry 成功前不会写入
            if (pendingCardId) {
                store.removeCardFiles(pendingCardId);
            }
            next(err);
        }
    });

    // ---------- analyze ----------
    router.post('/v1/cards/analyze', rawParser, (req, res, next) => {
        try {
            const buffer = readBody(req);
            const contentHash = computeContentHash(buffer);
            const marksData = store.readMarks();
            const mark = marksData.marks[contentHash];
            const forcedFormatDetail = mark && mark.type === 'rphub' ? 'rphub' : undefined;

            const payload = runPipeline(buffer, forcedFormatDetail);

            const character = payload.normalized.character || {};
            res.status(200).json({
                format: payload.format,
                confidence: 0.99,
                features: payload.features,
                contentHash,
                marked: !!mark,
                characterName: character.name || null,
                summary: summaryCounts(payload.normalized),
            });
        } catch (err) {
            next(err);
        }
    });

    // ---------- 卡与状态 ----------
    router.get('/v1/status', (req, res, next) => {
        try {
            const index = store.readIndex();
            const cardsCount = Object.keys(index.cards || {}).length;
            res.status(200).json({
                plugin: 'rp-hub-compat',
                version: '0.1.0',
                status: 'ok',
                schema_version: SCHEMA_VERSION,
                data_dir: store.dataDir,
                cards_count: cardsCount,
                uptime_ms: Date.now() - (globalThis.__rphubStartedAt || Date.now()),
            });
        } catch (err) {
            next(err);
        }
    });

    // ---------- 数据交换优化（向后兼容，不传参行为与旧契约一致） ----------

    /** 解析 ?fields=a,b,c → ['a','b','c']；不传返回 null（=全量） */
    function parseFields(req) {
        const raw = req.query.fields;
        if (typeof raw !== 'string' || !raw.trim()) return null;
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }

    /** 按字段白名单裁剪对象；fields 为 null 时原样返回。契约：fields 时 id 始终保留 */
    function pickFields(obj, fields) {
        if (!fields || !obj || typeof obj !== 'object') return obj;
        const out = {};
        if (Object.prototype.hasOwnProperty.call(obj, 'id')) out.id = obj.id;
        for (const f of fields) {
            if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
        }
        return out;
    }

    /** 解析分页 ?offset=&limit=；返回 { offset, limit }，limit 为 null 表示不分页 */
    function parsePage(req) {
        const rawOffset = Number(req.query.offset);
        const rawLimit = Number(req.query.limit);
        const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
        const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : null;
        return { offset, limit };
    }

    /**
     * 视图请求公共处理：
     *  - ETag/If-None-Match → 304（卡数据未变时整个响应体不发）
     *  - 无命中才读文件序列化
     */
    function viewRespond(req, res, next, etag, build) {
        const tag = `"${etag}"`;
        res.set('ETag', tag);
        if (req.headers['if-none-match'] === tag) {
            res.status(304).end();
            return;
        }
        try {
            const data = build();
            res.status(200).json(data);
        } catch (err) {
            next(err);
        }
    }

    // 视图查询共用逻辑
    function loadCard(req, res, next, category) {
        try {
            const { cardId } = req.params;
            assertCardId(cardId);
            if (!store.hasCard(cardId)) throw errNotFound();

            // raw 视图基于 raw/ 目录元数据，其余基于 normalized 文件
            const stat = category === 'raw' ? store.statRaw(cardId) : store.statNormalized(cardId);
            if (!stat) throw errNotFound();
            const fieldsKey = JSON.stringify(req.query.fields ?? '');
            const pageKey = JSON.stringify([req.query.offset ?? '', req.query.limit ?? '']);
            const etag = `${category}-${stat.size}-${Math.round(stat.mtimeMs)}-${fieldsKey}-${pageKey}`;

            viewRespond(req, res, next, etag, () => {
                if (category === 'raw') {
                    const blocksData = store.readRawBlocks(cardId) || { cardId, blocks: [] };
                    const originalData = store.readRawOriginal(cardId);
                    return {
                        cardId,
                        format: blocksData.format || 'png',
                        blocks: blocksData.blocks || [],
                        originalJson: originalData ? originalData.original : null,
                    };
                }

                const normalized = store.readNormalized(cardId);
                if (!normalized) throw errNotFound();
                const fields = parseFields(req);
                const { offset, limit } = parsePage(req);

                switch (category) {
                    case 'all':
                        return {
                            cardId,
                            schema_version: normalized.schema_version,
                            format: normalized.format,
                            formatDetail: normalized.formatDetail,
                            importedAt: normalized.importedAt,
                            character: pickFields(normalized.character, fields),
                            regex: fields ? (normalized.regex || []).map((r) => pickFields(r, fields)) : normalized.regex,
                            lorebook: fields ? (normalized.lorebook || []).map((r) => pickFields(r, fields)) : normalized.lorebook,
                            variables: normalized.variables,
                        };
                    case 'character':
                        return { cardId, character: pickFields(normalized.character, fields) };
                    case 'regex':
                        return {
                            cardId,
                            regex: (normalized.regex || []).map((r) => pickFields(r, fields)).slice(offset, limit === null ? undefined : offset + limit),
                        };
                    case 'lorebook':
                        return {
                            cardId,
                            lorebook: (normalized.lorebook || []).map((r) => pickFields(r, fields)).slice(offset, limit === null ? undefined : offset + limit),
                        };
                    case 'variables':
                        return { cardId, variables: pickFields(normalized.variables, fields) };
                    case 'mapping':
                        return { cardId, mapping: fields ? (normalized.mapping || []).map((m) => pickFields(m, fields)) : (normalized.mapping || []) };
                    default:
                        throw errorUnprocessable('UNSUPPORTED_TYPE', `未知数据类别：${category}`);
                }
            });
        } catch (err) {
            next(err);
        }
    }

    // ---------- 前端模式判定辅助（第二部正则引擎） ----------
    // 当前 ST 角色（writeBack 标准卡）→ 按角色名匹配后端已导入卡（index.json characterName）。
    // 同名多卡（重复导入）取 importedAt 最新。未匹配 404 → 前端降级为 st 模式。
    router.get('/v1/cards/by-name/:name', (req, res, next) => {
        try {
            const name = String(req.params.name || '');
            if (!name) return res.status(400).json({ error: { code: 'INVALID_CARD_NAME', message: '角色名不能为空' } });
            const index = store.readIndex();
            let best = null;
            for (const [cardId, meta] of Object.entries(index.cards || {})) {
                if (meta && typeof meta === 'object' && meta.characterName === name) {
                    if (!best || (meta.importedAt || '') > best.importedAt) {
                        best = { cardId, ...meta };
                    }
                }
            }
            if (!best) {
                return res.status(404).json({ error: { code: 'NOT_FOUND', message: `未找到角色「${name}」的导入记录` } });
            }
            const marksData = store.readMarks();
            const mark = (() => {
                // marks 以 contentHash 为键；index 元数据含 contentHash
                const hash = best.contentHash;
                if (hash && marksData.marks?.[hash]) return marksData.marks[hash];
                return null;
            })();
            res.status(200).json({
                cardId: best.cardId,
                characterName: best.characterName,
                format: best.format ?? null,
                formatDetail: mark && mark.type === 'rphub' ? 'rphub' : (best.formatDetail ?? 'st'),
                contentHash: best.contentHash ?? null,
                marked: !!mark,
                importedAt: best.importedAt ?? null,
                regexCount: best.regexCount ?? 0,
                lorebookCount: best.lorebookCount ?? 0,
            });
        } catch (err) {
            next(err);
        }
    });

    router.get('/v1/cards/:cardId', (req, res, next) => loadCard(req, res, next, 'all'));
    router.get('/v1/cards/:cardId/character', (req, res, next) => loadCard(req, res, next, 'character'));
    router.get('/v1/cards/:cardId/regex', (req, res, next) => loadCard(req, res, next, 'regex'));
    router.get('/v1/cards/:cardId/lorebook', (req, res, next) => loadCard(req, res, next, 'lorebook'));
    router.get('/v1/cards/:cardId/variables', (req, res, next) => loadCard(req, res, next, 'variables'));
    router.get('/v1/cards/:cardId/mapping', (req, res, next) => loadCard(req, res, next, 'mapping'));
    router.get('/v1/cards/:cardId/raw', (req, res, next) => loadCard(req, res, next, 'raw'));

    // ---------- 导入去重预检（数据交换优化：前端先查再决定是否上传） ----------
    router.get('/v1/cards/exists/:contentHash', (req, res, next) => {
        try {
            const { contentHash } = req.params;
            assertContentHash(contentHash);
            const cardId = store.findByContentHash(contentHash);
            res.status(200).json({ contentHash, exists: !!cardId, cardId });
        } catch (err) {
            next(err);
        }
    });

    // ---------- marks ----------
    router.get('/v1/marks', (req, res, next) => {
        try {
            const marksData = store.readMarks();
            res.status(200).json({ marks: listMarks(marksData) });
        } catch (err) {
            next(err);
        }
    });

    router.get('/v1/marks/:contentHash', (req, res, next) => {
        try {
            const { contentHash } = req.params;
            assertContentHash(contentHash);
            const marksData = store.readMarks();
            res.status(200).json(getMarkStatus(marksData, contentHash));
        } catch (err) {
            next(err);
        }
    });

    router.put('/v1/marks/:contentHash', (req, res, next) => {
        try {
            const { contentHash } = req.params;
            assertContentHash(contentHash);
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const type = typeof body.type === 'string' && body.type ? body.type : 'rphub';
            if (!isSupportedMarkType(type)) throw errUnsupportedMarkType(type);
            const note = typeof body.note === 'string' ? body.note : undefined;

            const marksData = store.readMarks();
            const result = setMark(marksData, contentHash, type, note);
            store.writeMarks(marksData);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    });

    router.delete('/v1/marks/:contentHash', (req, res, next) => {
        try {
            const { contentHash } = req.params;
            assertContentHash(contentHash);
            const marksData = store.readMarks();
            const result = clearMark(marksData, contentHash);
            store.writeMarks(marksData);
            res.status(200).json(result);
        } catch (err) {
            next(err);
        }
    });

    // ---------- 兜底 ----------
    router.use((req, res, next) => {
        res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `路径不存在：${req.method} ${req.path}` } });
    });

    router.use(errorHandler);
}
