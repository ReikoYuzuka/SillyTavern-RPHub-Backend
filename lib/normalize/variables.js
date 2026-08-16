// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/variables.js — 变量/UI 模板收纳（第一部只原样收纳，语义化留给第三部）
//
// 来源（兼容多位置，参考 RP-Hub parseImportedCharacterCard）：
//   - data.uiTemplates / data.ui_templates / data.rp_hub_ui_templates
//   - data.extensions.ui_templates / data.extensions.rp_hub_ui_templates
//   - data.runtimeByCharacter
//
// variables.initial 聚合各模板的 initialVariableState（扁平合并，键冲突后者覆盖）；
// 完整模板（含各自的 initialVariableState/variableSchema）原样进 variables.uiTemplates。

import { isPlainObject } from '../util.js';

export function collectUiTemplates(data) {
    const ext = isPlainObject(data.extensions) ? data.extensions : {};
    const candidates = [
        data.uiTemplates,
        data.ui_templates,
        data.rp_hub_ui_templates,
        ext.ui_templates,
        ext.rp_hub_ui_templates,
    ];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return [];
}

/**
 * 收纳变量/模板。
 * @param {object} data 角色数据对象
 * @param {'rphub'|'st'} source
 * @returns {{ variables: object, mappingItems: Array }}
 */
export function collectVariables(data, source) {
    const uiTemplates = collectUiTemplates(data);
    const runtimeByCharacter = (data && 'runtimeByCharacter' in data)
        ? data.runtimeByCharacter
        : (isPlainObject(data.extensions) && 'runtimeByCharacter' in data.extensions ? data.extensions.runtimeByCharacter : null);

    // initial：聚合各模板 initialVariableState
    const initial = {};
    for (const tpl of uiTemplates) {
        if (isPlainObject(tpl) && isPlainObject(tpl.initialVariableState)) {
            for (const [k, v] of Object.entries(tpl.initialVariableState)) {
                initial[k] = v;
            }
        }
    }

    const hasAny = uiTemplates.length > 0 || runtimeByCharacter !== null;
    const variables = hasAny ? {
        initial: initial,
        uiTemplates,
        runtimeByCharacter,
    } : null;

    const mappingItems = [];
    if (uiTemplates.length > 0) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data.uiTemplates',
            targetField: 'variables.uiTemplates',
            status: 'mapped',
            note: '原样收纳（语义化处理属第三部）',
        });
    }
    if (runtimeByCharacter !== null) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data.runtimeByCharacter',
            targetField: 'variables.runtimeByCharacter',
            status: 'mapped',
            note: '原样收纳（语义化处理属第三部）',
        });
    }
    if (!hasAny) {
        mappingItems.push({
            category: 'variables',
            sourcePath: 'data',
            targetField: 'variables',
            status: 'raw',
            note: '未发现变量/UI 模板',
        });
    }

    return { variables, mappingItems };
}
