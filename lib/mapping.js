// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/mapping.js — 映射表生成与未映射字段收纳（见 格式解析/字段映射.md）
//
// mapping 条目：{ category, sourcePath, targetField, status, note }
// status：mapped | raw | conflict | unsupported
// raw.unmapped：未映射字段集中存放，键为来源路径。

import { isPlainObject } from './util.js';

// 已纳入归一化的顶层字段（这些不落入 raw.unmapped）
const HANDLED_TOP_KEYS = new Set([
    'spec', 'spec_version', 'data',
    'name', 'char_name', 'nickname', 'creator', 'character_version',
    'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings', 'group_only_greetings',
    'mes_example', 'creator_notes', 'creatorcomment', 'creator_comment',
    'system_prompt', 'post_history_instructions', 'tags', 'extensions',
    'character_book', 'regex_scripts', 'rp_hub_regex_scripts',
    'uiTemplates', 'ui_templates', 'rp_hub_ui_templates', 'runtimeByCharacter',
    'assets', 'create_date', 'fav', 'talkativeness', 'avatar',
]);

/**
 * 收集未映射字段 → raw.unmapped。
 * @param {object} data 角色数据对象
 * @returns {{ unmapped: object, mappingItems: Array }}
 */
export function collectUnmapped(data) {
    const unmapped = {};
    const mappingItems = [];
    if (!data || typeof data !== 'object') return { unmapped, mappingItems };

    for (const key of Object.keys(data)) {
        if (HANDLED_TOP_KEYS.has(key)) continue;
        const value = data[key];
        if (value === undefined || value === null) continue;
        unmapped[`data.${key}`] = value;
        mappingItems.push({
            category: 'raw',
            sourcePath: `data.${key}`,
            targetField: 'raw.unmapped',
            status: 'raw',
            note: '未定义映射规则，原样保留',
        });
    }

    return { unmapped, mappingItems };
}

/**
 * 汇总映射表并统计摘要。
 * note 仅在非 mapped（raw/conflict/unsupported）时输出——mapped 的说明语义确定，重复冗余（大卡上千条同文案）。
 * @param {Array} mappingItems 各归一阶段产生的条目
 * @returns {{ mapping: Array, summary: { mapped: number, raw: number, conflict: number, unsupported: number } }}
 */
export function buildMapping(mappingItems) {
    const mapping = mappingItems.slice();
    for (const item of mapping) {
        if (item.status === 'mapped') {
            delete item.note;
        }
    }
    const summary = { mapped: 0, raw: 0, conflict: 0, unsupported: 0 };
    for (const item of mapping) {
        if (summary[item.status] === undefined) summary[item.status] = 0;
        summary[item.status] += 1;
    }
    return { mapping, summary };
}
