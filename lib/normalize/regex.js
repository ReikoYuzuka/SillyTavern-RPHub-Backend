// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/normalize/regex.js — 正则归一（rphub / st 双来源 → 统一形态）
//
// 来源：
//   - data.extensions.regex_scripts（rphub 与 st 卡都可能在此）
//   - data.regex_scripts（rphub 导出卡）
//   - data.rp_hub_regex_scripts（rphub 特有位）
// 合并去重：按 findRegex+replaceString 判重，同正则取 rphub 版本，另一份进 raw。

import { stableId, toBoolean, toNumber, splitRegexLiteral } from '../util.js';
import { isPlainObject } from '../util.js';

const CHARACTER_FIELD_NAMES = ['name', 'scriptName'];
const GLOBAL_SYSTEM_NAMES = ['NAI画图正则']; // 参考 RPHubConfig.systemRegexNames

function collectRegexSources(data) {
    const sources = [];
    const ext = isPlainObject(data.extensions) ? data.extensions : {};
    if (Array.isArray(ext.regex_scripts)) {
        sources.push({ source: 'st', base: 'data.extensions.regex_scripts', list: ext.regex_scripts });
    }
    if (Array.isArray(data.regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.regex_scripts', list: data.regex_scripts });
    }
    if (Array.isArray(ext.rp_hub_regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.extensions.rp_hub_regex_scripts', list: ext.rp_hub_regex_scripts });
    }
    if (Array.isArray(data.rp_hub_regex_scripts)) {
        sources.push({ source: 'rphub', base: 'data.rp_hub_regex_scripts', list: data.rp_hub_regex_scripts });
    }
    return sources;
}

function pickName(raw) {
    for (const key of CHARACTER_FIELD_NAMES) {
        if (typeof raw[key] === 'string' && raw[key]) return raw[key];
    }
    return null;
}

/**
 * 归一单条正则脚本。
 * @param {object} raw 原始脚本对象
 * @param {string} source 'rphub' | 'st'
 */
export function normalizeRegexEntry(raw, source) {
    const rawObj = isPlainObject(raw) ? raw : {};

    // findRegex 与 flags（尊重原始意图，不强制兜底追加 'g'）
    const literalResult = splitRegexLiteral(rawObj.findRegex || rawObj.regex || '');
    let findRegex = literalResult.pattern;
    if (!findRegex && typeof rawObj.regex === 'string') findRegex = rawObj.regex;
    let regexFlags = literalResult.flags !== undefined
        ? literalResult.flags
        : (typeof rawObj.regexFlags === 'string'
            ? rawObj.regexFlags
            : (typeof rawObj.flags === 'string' ? rawObj.flags : undefined));

    // enabled：RP-Hub/ST 的 disabled 反转
    let enabled = true;
    if (rawObj.enabled !== undefined) enabled = toBoolean(rawObj.enabled, true);
    else if (rawObj.disabled !== undefined) enabled = !toBoolean(rawObj.disabled, false);

    // markdownOnly / promptOnly 互斥（参考 RPHub 语义）
    let markdownOnly = toBoolean(rawObj.markdownOnly, false);
    let promptOnly = toBoolean(rawObj.promptOnly, false);
    if (markdownOnly && promptOnly) promptOnly = false;

    // placement 归一为 ST 数值语义（1=user 输入，2=AI 输出）
    let placement = [];
    if (Array.isArray(rawObj.placement)) {
        placement = rawObj.placement.map(Number).filter((v) => v === 1 || v === 2);
    } else if (rawObj.placement !== undefined) {
        const n = Number(rawObj.placement);
        if (n === 1 || n === 2) placement = [n];
    }
    if (placement.length === 0) placement = [1, 2];

    const depth = toNumber(rawObj.minDepth, 0) || 0;

    // scope：rphub global/character 两类归一；st 来源的卡内脚本一律 character
    const rawScope = rawObj.scope;
    const scope = rawScope === 'global'
        || GLOBAL_SYSTEM_NAMES.includes(rawObj.name || rawObj.scriptName || '')
        ? 'global' : 'character';

    const name = pickName(rawObj) || 'Regex Script';
    const replaceString = (typeof rawObj.replaceString === 'string' ? rawObj.replaceString : '')
        || (typeof rawObj.replacement === 'string' ? rawObj.replacement : '');

    return {
        id: stableId('rx', source, name, findRegex, replaceString),
        scriptName: name,
        findRegex,
        replaceString,
        regexFlags,
        enabled,
        trimOutput: toBoolean(rawObj.trimOutput, false),
        markdownOnly,
        promptOnly,
        userOnly: toBoolean(rawObj.userOnly, false),
        substituteRegex: toBoolean(rawObj.substituteRegex, false),
        placement,
        depth,
        scope,
        source,
        raw: rawObj,
    };
}

/**
 * 归一全部正则脚本。
 * @param {object} data 角色数据对象
 * @returns {{ regex: Array, mappingItems: Array, duplicates: Array }}
 */
export function normalizeRegex(data) {
    const sources = collectRegexSources(data);
    const mappingItems = [];
    const duplicates = [];
    const seen = new Map(); // dedupKey → { entry, source, base, index }

    for (const { source, base, list } of sources) {
        list.forEach((raw, index) => {
            const entry = normalizeRegexEntry(raw, source);
            const dedupKey = `${entry.findRegex}\u0000${entry.replaceString}\u0000${entry.regexFlags || ''}`;
            const existing = seen.get(dedupKey);
            if (existing) {
                // 冲突：同正则，来源优先级 rphub > st（见 格式解析/字段映射.md）
                if (source === 'rphub' && existing.source === 'st') {
                    duplicates.push({ base, index, dropped: existing.entry });
                    existing.entry = entry;
                    existing.source = source;
                    existing.base = base;
                    existing.index = index;
                } else {
                    duplicates.push({ base, index, dropped: entry });
                }
                return;
            }
            seen.set(dedupKey, { entry, source, base, index });
        });
    }

    const regex = [...seen.values()].map((item) => item.entry);

    // mapping：按每个来源条目逐条记录（被保留的标 mapped，被去重丢弃的标 raw）
    for (const { source, base, list } of sources) {
        list.forEach((raw, index) => {
            const entry = normalizeRegexEntry(raw, source);
            const dedupKey = `${entry.findRegex}\u0000${entry.replaceString}\u0000${entry.regexFlags || ''}`;
            const kept = seen.get(dedupKey);
            const isKept = kept && kept.source === source;
            mappingItems.push({
                category: 'regex',
                sourcePath: `${base}[${index}]`,
                targetField: 'regex[]',
                status: isKept ? 'mapped' : 'raw',
                note: isKept ? '已归一为 ST 正则字段' : '与另一来源同正则，保留 raw（优先级 rphub > st）',
            });
        });
    }

    return { regex, mappingItems, duplicates };
}
