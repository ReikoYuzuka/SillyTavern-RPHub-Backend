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
 * - 形如 `/pattern/gims` 的字面量 → 拆开（从尾部扫描未转义的定界符 /）
 * - 否则原样当模式
 */
export function splitRegexLiteral(input) {
    const text = String(input || '').trim();
    if (text.startsWith('/') && text.length >= 2) {
        // 从尾部向前扫描寻找闭合定界符 '/'
        let lastSlash = -1;
        for (let i = text.length - 1; i > 0; i--) {
            if (text[i] === '/') {
                // 计算前面的连续反斜杠数量（偶数个表示 / 未被转义，奇数个表示被转义 \/）
                let backslashes = 0;
                let j = i - 1;
                while (j >= 0 && text[j] === '\\') {
                    backslashes++;
                    j--;
                }
                if (backslashes % 2 === 0) {
                    lastSlash = i;
                    break;
                }
            }
        }
        if (lastSlash > 0) {
            const flags = text.slice(lastSlash + 1);
            if (/^[dgimsuvy]*$/.test(flags)) {
                return { pattern: text.slice(1, lastSlash), flags: flags || undefined };
            }
        }
    }
    return { pattern: text, flags: undefined };
}
