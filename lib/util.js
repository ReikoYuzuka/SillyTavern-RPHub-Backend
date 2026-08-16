// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/util.js — 通用小工具

import { createHash } from 'node:crypto';

/** 稳定 id：基于内容哈希生成，同一输入永远得到同一 id（prefix + 12 位十六进制） */
export function stableId(prefix, ...parts) {
    const hash = createHash('sha256').update(parts.join('\u0000')).digest('hex');
    return `${prefix}_${hash.slice(0, 12)}`;
}

export function toNumber(value, fallback = null) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
    }
    return !!value;
}

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 字符串 keys → 数组（兼容 RP-Hub/ST 的逗号/顿号分隔字符串） */
export function normalizeKeys(keys) {
    if (typeof keys === 'string') {
        return keys.split(/[,，]/).map((k) => k.trim()).filter(Boolean);
    }
    if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string').map((k) => k.trim()).filter(Boolean);
    return [];
}

/**
 * 从 findRegex / regex 提取「模式 + flags」：
 * - 形如 `/pattern/gims` 的字面量 → 拆开
 * - 否则原样当模式
 */
export function splitRegexLiteral(input) {
    const text = String(input || '').trim();
    if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
        const lastSlash = text.lastIndexOf('/');
        const flags = text.slice(lastSlash + 1);
        if (/^[dgimsuvy]*$/.test(flags)) {
            return { pattern: text.slice(1, lastSlash), flags: flags || undefined };
        }
    }
    return { pattern: text, flags: undefined };
}
