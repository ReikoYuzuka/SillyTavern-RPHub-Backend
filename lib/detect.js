// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/detect.js — 语义来源判定（formatDetail）与特征提取
//
// 见 格式解析/README.md「语义来源判定」：
//   任一 RP-Hub 特有字段命中 → rphub
//   标准 ST 卡结构（chara_card_v2/v3 + 无 RP-Hub 特有字段）→ st
//   都未命中 → unknown
//
// 手动标记覆盖在 upload/analyze 层完成（查 marks.json，命中 rphub 强制 formatDetail='rphub'）。

/**
 * 汇总原始角色对象的 RP-Hub 特征。
 * @param {object} data 角色数据对象（parsePng/parseJson 的输出 data）
 * @param {Array<{keyword:string}>} blocks PNG 文本块清单（JSON 卡传 []）
 * @returns {{ features: string[], isRphub: boolean }}
 */
export function detectRphub(data, blocks = []) {
    const features = [];
    if (!data || typeof data !== 'object') {
        return { features, isRphub: false };
    }

    const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    const blockKeywords = new Set((blocks || []).map((b) => b.keyword));

    // RP-Hub 特有块（真实世界模拟器等卡带的标记块）
    if (blockKeywords.has('RoleplayHubCard')) features.push('rphub_block_roleplayhubcard');
    if (blockKeywords.has('rp_hub_credit')) features.push('rphub_block_credit');
    if (blockKeywords.has('rp_hub_fingerprint')) features.push('rphub_block_fingerprint');

    // RP-Hub 特有字段（兼容 rp_hub_* / uiTemplates / runtimeByCharacter / ui_templates）
    if (Array.isArray(data.uiTemplates) && data.uiTemplates.length > 0) features.push('rphub_ui_templates');
    if (Array.isArray(ext.rp_hub_ui_templates) && ext.rp_hub_ui_templates.length > 0) features.push('rphub_ui_templates');
    if (Array.isArray(data.ui_templates) && data.ui_templates.length > 0) features.push('rphub_ui_templates');
    if (data.uiTemplates !== undefined) features.push('rphub_ui_templates');
    if (data.ui_templates !== undefined) features.push('rphub_ui_templates');
    if (data.runtimeByCharacter !== undefined) features.push('rphub_runtime_by_character');
    if (ext.rp_hub_watermark !== undefined) features.push('rphub_watermark');
    if (ext.rp_hub_ui_templates !== undefined) features.push('rphub_ui_templates');
    if (ext.rp_hub_regex_scripts !== undefined) features.push('rphub_regex');
    if (data.rp_hub_watermark !== undefined) features.push('rphub_watermark');
    // 顶层 data.regex_scripts 非空（rphub 导出卡的写法：正则放角色数据顶层，而非 ST 标准位
    // data.extensions.regex_scripts）。这类卡走 upload/writeBack 管线会由 normalize/regex.js
    // 归一并写回 ST 标准位，否则 ST 原生正则扩展（只读 extensions.regex_scripts）识别不到。
    if (Array.isArray(data.regex_scripts) && data.regex_scripts.length > 0) features.push('rphub_top_level_regex_scripts');

    return { features, isRphub: features.length > 0 };
}

/**
 * 判定语义来源。
 * @param {object} data 角色数据对象
 * @param {Array} blocks
 * @param {object} [opts]
 * @param {string} [opts.spec] 由解析器得到的 spec
 * @returns {{ formatDetail: 'rphub'|'st'|'unknown', features: string[] }}
 */
export function detectFormatDetail(data, blocks = [], opts = {}) {
    const rphubResult = detectRphub(data, blocks);
    if (rphubResult.isRphub) {
        return { formatDetail: 'rphub', features: rphubResult.features };
    }

    const spec = opts.spec;
    if (spec === 'chara_card_v2' || spec === 'chara_card_v3' || data.spec === 'chara_card_v2' || data.spec === 'chara_card_v3') {
        return { formatDetail: 'st', features: rphubResult.features };
    }

    return { formatDetail: 'unknown', features: rphubResult.features };
}
