// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/pipeline.js — 上传/分析共享管线：嗅探 → 解析 → 语义判定 → 规范化
//
// 不涉及落盘，供 upload / analyze 复用。

import { sniffFormat } from './sniff.js';
import { parsePng } from './parse/png.js';
import { parseJson } from './parse/json.js';
import { detectFormatDetail } from './detect.js';
import { buildNormalized } from './normalize/index.js';
import { errUnsupportedFormat, errParseFailed } from './errors.js';
import { isPlainObject } from './util.js';

const parsers = {
    png: parsePng,
    json: parseJson,
};

/**
 * 完整分析管道。
 * @param {Buffer} buffer 原始字节
 * @param {string} [forcedFormatDetail] 手动标记强制结果（命中标记时传入 'rphub'）
 * @returns {{
 *   format: string,
 *   spec: string,
 *   data: object,
 *   blocks: Array,
 *   features: Array,
 *   formatDetail: 'rphub'|'st'|'unknown',
 *   normalized: object,
 * }}
 */
export function runPipeline(buffer, forcedFormatDetail) {
    const format = sniffFormat(buffer);
    if (format === null || format === 'html') {
        throw errUnsupportedFormat();
    }

    const parser = parsers[format];
    if (!parser) {
        throw errParseFailed('extract', `没有 ${format} 解析器`);
    }

    const parsed = parser(buffer);

    // 中央守卫（N-E-1）：解析产物必须是普通对象，统一收敛为 422 PARSE_FAILED。
    // 缺陷面原本有两层——null 令 detect.js 解引用抛 TypeError → 500 INTERNAL；
    // 数组/字符串/数字穿透到 buildNormalized 的兜底后【静默产出全空角色卡入库】。
    // upload 与 analyze 共用本管线，两接口同等收紧。
    if (!isPlainObject(parsed.data)) {
        throw errParseFailed('parse', '卡数据不是有效的 JSON 对象');
    }

    // 语义来源判定
    let { formatDetail, features } = detectFormatDetail(parsed.data, parsed.blocks, { spec: parsed.spec });

    // 手动标记覆盖（自动判定之后、规范化写入之前）
    if (forcedFormatDetail === 'rphub') {
        formatDetail = 'rphub';
    }

    // 合并检测特征
    const allFeatures = [...parsed.features, ...features].filter((f, i, arr) => arr.indexOf(f) === i);

    const normalized = buildNormalized(parsed, formatDetail);

    return {
        format,
        spec: parsed.spec,
        data: parsed.data,
        blocks: parsed.blocks,
        features: allFeatures,
        formatDetail,
        normalized,
    };
}
