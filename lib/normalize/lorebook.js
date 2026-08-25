// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/lorebook.js — 世界书归一
//
// 来源：data.character_book.entries（数组或对象）
// position 归一为 ST 数值语义（world_info_position：0=before_char, 1=after_char, 2/3=AN, 4=at_depth），
// 原值进 raw。
//
// 外部世界书引用（extensions.world 为世界书名）不展开 → lorebook 空 + mapping unsupported。

import { stableId, toBoolean, toNumber, normalizeKeys } from '../util.js';
import { isPlainObject } from '../util.js';

// RP-Hub 位置字符串 → ST 数值语义（world_info_position）
const POSITION_MAP = {
    before_char: 0,
    before_character: 0,
    system_top: 0,
    after_char: 1,
    after_character: 1,
    global_note: 2,
    author_note: 2,
    at_depth: 4,
    user_top: 4,
    assistant_top: 4,
};

export function collectLorebookEntries(data) {
    const book = data && typeof data === 'object' ? data.character_book : null;
    if (!book) return [];
    if (Array.isArray(book.entries)) return book.entries;
    if (book.entries && typeof book.entries === 'object') return Object.values(book.entries);
    if (Array.isArray(book)) return book;
    return [];
}

/**
 * 归一单条世界书条目。
 * @param {object} raw 原始条目
 * @param {string} source 'rphub' | 'st'
 */
export function normalizeLorebookEntry(raw, source) {
    const rawObj = isPlainObject(raw) ? raw : {};

    const keys = normalizeKeys(rawObj.keys !== undefined ? rawObj.keys : rawObj.key);
    const rawPosition = rawObj.position;
    let position = 4; // at_depth 默认
    if (typeof rawPosition === 'number') {
        position = [0, 1, 2, 3, 4].includes(rawPosition) ? rawPosition : 4;
    } else if (typeof rawPosition === 'string') {
        const normalized = rawPosition.toLowerCase().replace(/ /g, '_');
        position = POSITION_MAP[normalized] !== undefined ? POSITION_MAP[normalized] : 4;
    }

    const rawExt = isPlainObject(rawObj.extensions) ? rawObj.extensions : {};
    const depth = toNumber(rawObj.depth, null) ?? toNumber(rawExt.depth, null) ?? 4;

    const name = (typeof rawObj.name === 'string' && rawObj.name) ? rawObj.name
        : ((typeof rawObj.comment === 'string' && rawObj.comment) ? rawObj.comment : 'Entry');

    const enabled = toBoolean(rawObj.enabled, true) && !toBoolean(rawObj.disable ?? rawObj.disabled, false);
    const constant = toBoolean(rawObj.constant, false);
    const selective = toBoolean(rawObj.selective, false);
    const excludeRecursion = toBoolean(rawObj.exclude_recursion ?? rawObj.excludeRecursion, false);
    const probability = toNumber(rawObj.probability, 100) ?? 100;

    return {
        id: stableId('lb', source, name, rawObj.content || '', keys.join(',')),
        name,
        content: typeof rawObj.content === 'string' ? rawObj.content : '',
        keys,
        comment: typeof rawObj.comment === 'string' ? rawObj.comment : '',
        selective,
        constant,
        position,
        depth,
        disable: !enabled,
        excludeRecursion,
        probability,
        source,
        raw: rawObj,
    };
}

/**
 * 归一全部世界书条目。
 * @param {object} data 角色数据对象
 * @param {'rphub'|'st'} source 该卡条目的语义来源
 * @returns {{ lorebook: Array, mappingItems: Array, externalWorldRef: string|null }}
 */
export function normalizeLorebook(data, source) {
    const entries = collectLorebookEntries(data);
    const lorebook = entries.map((raw) => normalizeLorebookEntry(raw, source));
    const mappingItems = [];
    const ext = isPlainObject(data.extensions) ? data.extensions : {};

    // 外部世界书引用
    let externalWorldRef = null;
    if (typeof ext.world === 'string' && ext.world) {
        externalWorldRef = ext.world;
        mappingItems.push({
            category: 'lorebook',
            sourcePath: 'data.extensions.world',
            targetField: 'lorebook[]',
            status: 'unsupported',
            note: `引用外部世界书「${ext.world}」，读取属第二/三部范围`,
        });
    }

    entries.forEach((raw, index) => {
        mappingItems.push({
            category: 'lorebook',
            sourcePath: `data.character_book.entries[${index}]`,
            targetField: 'lorebook[]',
            status: 'mapped',
            note: '触发词/位置已归一为 ST 语义',
        });
    });

    if (entries.length === 0 && !externalWorldRef) {
        mappingItems.push({
            category: 'lorebook',
            sourcePath: 'data.character_book',
            targetField: 'lorebook[]',
            status: 'raw',
            note: '卡内无世界书条目',
        });
    }

    return { lorebook, mappingItems, externalWorldRef };
}
