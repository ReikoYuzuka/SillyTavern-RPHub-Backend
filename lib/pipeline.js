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
