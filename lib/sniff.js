// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/sniff.js — 格式嗅探（见 格式解析/README.md）
//
// 只依据字节魔数，不依赖文件名：
//   PNG 签名 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A → 'png'
//   否则跳过前导空白后以 { 或 [ 开头 → 'json'
//   以 < 开头（疑似 HTML/XML）        → 'html'（识别但暂不支持）
//   否则 → null（→ 422 UNSUPPORTED_FORMAT）

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buffer) {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * 嗅探格式。
 * @param {Buffer} buffer
 * @returns {'png'|'json'|'html'|null}
 */
export function sniffFormat(buffer) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
    if (isPng(buffer)) return 'png';

    let start = 0;
    while (start < buffer.length) {
        const b = buffer[start];
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) {
            start++;
        } else {
            break;
        }
    }

    if (start >= buffer.length) return null;

    const first = buffer[start];
    if (first === 0x7b /* { */ || first === 0x5b /* [ */) return 'json';
    if (first === 0x3c /* < */) return 'html';

    return null;
}

/** 返回全部已识别格式（features 用） */
export function sniffFeatures(buffer) {
    const format = sniffFormat(buffer);
    return format ? [format] : [];
}
