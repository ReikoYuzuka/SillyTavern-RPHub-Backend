// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/character.js — 角色信息归一
//
// 输入：角色数据对象 data；输出 ST 标准字段，缺失补 null。
// extensions 原样透传。

import { isPlainObject } from '../util.js';

export function normalizeCharacter(data, formatDetail) {
    const character = {
        name: typeof data.name === 'string' ? data.name : (typeof data.char_name === 'string' ? data.char_name : null),
        description: typeof data.description === 'string' ? data.description : null,
        personality: typeof data.personality === 'string' ? data.personality : null,
        first_mes: typeof data.first_mes === 'string' ? data.first_mes : null,
        mes_example: typeof data.mes_example === 'string' ? data.mes_example : null,
        scenario: typeof data.scenario === 'string' ? data.scenario : null,
        system_prompt: typeof data.system_prompt === 'string' ? data.system_prompt : null,
        post_history_instructions: typeof data.post_history_instructions === 'string' ? data.post_history_instructions : null,
        creator_notes: typeof data.creator_notes === 'string' ? data.creator_notes
            : (typeof data.creatorcomment === 'string' ? data.creatorcomment : null),
        tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : null,
        extensions: isPlainObject(data.extensions) ? data.extensions : null,
    };

    const mappingItems = [];
    for (const key of ['name', 'description', 'personality', 'first_mes', 'mes_example', 'scenario', 'system_prompt', 'post_history_instructions', 'creator_notes', 'tags']) {
        if (character[key] !== null && character[key] !== undefined) {
            mappingItems.push({
                category: 'character',
                sourcePath: `data.${key}`,
                targetField: `character.${key}`,
                status: 'mapped',
                note: '直接对应',
            });
        }
    }
    if (character.extensions !== null) {
        mappingItems.push({
            category: 'character',
            sourcePath: 'data.extensions',
            targetField: 'character.extensions',
            status: 'mapped',
            note: '原样透传',
        });
    }

    return { character, mappingItems };
}
