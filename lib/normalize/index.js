// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/index.js — 规范化编排（见 接口契约/规范化Schema.md）
//
// 输入：parse 后的 { spec, data, blocks, features } + 语义来源 formatDetail
// 输出：规范化顶层对象（normalized/{cardId}.json 内容，不含 cardId/importedAt，由调用方补充）

import { SCHEMA_VERSION } from '../store.js';
import { normalizeCharacter } from './character.js';
import { normalizeRegex } from './regex.js';
import { normalizeLorebook } from './lorebook.js';
import { collectVariables } from './variables.js';
import { collectUnmapped, buildMapping } from '../mapping.js';
import { isPlainObject } from '../util.js';

/**
 * 组装规范化数据。
 * @param {object} parsed parsePng/parseJson 的输出 { spec, data, blocks, features }
 * @param {'rphub'|'st'|'unknown'} formatDetail 语义来源（已含手动标记覆盖）
 * @returns {object} 规范化顶层对象
 */
export function buildNormalized(parsed, formatDetail) {
    const data = isPlainObject(parsed.data) ? parsed.data : {};

    const charResult = normalizeCharacter(data, formatDetail);
    const regexResult = normalizeRegex(data);
    const loreResult = normalizeLorebook(data, formatDetail === 'rphub' ? 'rphub' : 'st');
    const varsResult = collectVariables(data, formatDetail === 'rphub' ? 'rphub' : 'st');
    const unmappedResult = collectUnmapped(data);

    const allItems = [
        ...charResult.mappingItems,
        ...regexResult.mappingItems,
        ...loreResult.mappingItems,
        ...varsResult.mappingItems,
        ...unmappedResult.mappingItems,
    ];

    const { mapping, summary } = buildMapping(allItems);

    return {
        schema_version: SCHEMA_VERSION,
        formatDetail,
        character: charResult.character,
        regex: regexResult.regex,
        lorebook: loreResult.lorebook,
        variables: varsResult.variables,
        mapping,
        mappingSummary: summary,
        raw: {
            // schema_v2：仅保留 unmapped（唯一存储）；blocks/originalJson 不再冗余，
            // 原貌数据在 raw/{cardId}/blocks.json + original.json（raw 视图读取）
            unmapped: unmappedResult.unmapped,
        },
    };
}

export {
    normalizeCharacter,
    normalizeRegex,
    normalizeLorebook,
    collectVariables,
};
