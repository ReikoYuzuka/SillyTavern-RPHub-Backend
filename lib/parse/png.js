// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/parse/png.js — PNG 块提取（见 格式解析/PNG卡解析.md）
//
// PNG = 8 字节签名 + 连续数据块，每块：
//   4 字节长度(big-endian) | 4 字节类型 | N 字节数据 | 4 字节 CRC32
//
// 文本块类型：
//   tEXt：keyword\0content（content 为 Latin-1 文本，按 UTF-8 读取兼容中文字段）
//   zTXt：keyword\0<压缩方法 1 字节> + zlib 压缩内容
//   iTXt：keyword\0<压缩标志 1 字节>\0<压缩方法 1 字节>\0<语言标签>\0<翻译关键字>\0 + 内容
//         （压缩标志 0 = 未压缩文本；1 = 压缩文本）
//
// 输出：
//   { spec, data, blocks, features }
//   blocks 保留全部文本块的 keyword + content（content 按解压/解码后的可读形式存储）。

import zlib from 'node:zlib';
import { errParseFailed } from '../errors.js';

const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);

function decodeTextChunk(type, data) {
    // 找到 keyword 的结束符（第一个 0x00）
    let nullIdx = -1;
    for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { nullIdx = i; break; }
    }
    if (nullIdx === -1) return null;
    const keyword = data.subarray(0, nullIdx).toString('utf8');
    let content = null;

    if (type === 'tEXt') {
        content = data.subarray(nullIdx + 1).toString('utf8');
    } else if (type === 'zTXt') {
        // keyword\0 compression-method(1) compressed-data
        const method = data[nullIdx + 1];
        const payload = data.subarray(nullIdx + 2);
        if (method !== 0) return { keyword, content: null, compressed: true };
        try {
            content = zlib.inflateSync(payload).toString('utf8');
        } catch {
            return { keyword, content: null, compressed: true };
        }
    } else if (type === 'iTXt') {
        // keyword\0 compression-flag(1) compression-method(1) language-tag\0 translated-keyword\0 text
        let cursor = nullIdx + 1;
        const compressionFlag = cursor < data.length ? data[cursor] : 0;
        cursor += 1;
        if (cursor >= data.length) return { keyword, content: null };
        cursor += 1; // compression method
        // 跳过 language tag 与 translated keyword 两个 \0 结尾段
        for (let i = 0; i < 2; i++) {
            while (cursor < data.length && data[cursor] !== 0) cursor++;
            cursor += 1;
        }
        const payload = data.subarray(cursor);
        if (compressionFlag === 1) {
            try {
                content = zlib.inflateSync(payload).toString('utf8');
            } catch {
                content = null;
            }
        } else {
            content = payload.toString('utf8');
        }
    }
    return { keyword, content };
}

/**
 * 解析 PNG 字节 → 文本块清单。
 * @param {Buffer} buffer
 * @returns {Array<{keyword: string, content: string|null, chunkType: string}>}
 */
export function extractPngBlocks(buffer) {
    const blocks = [];
    let offset = 8;
    const len = buffer.length;
    while (offset + 12 <= len) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > len) break; // 截断的块：忽略（坏 PNG 交给缺块判定兜底）
        if (TEXT_CHUNK_TYPES.has(type)) {
            const decoded = decodeTextChunk(type, buffer.subarray(dataStart, dataEnd));
            if (decoded && decoded.keyword) {
                blocks.push({ keyword: decoded.keyword, content: decoded.content, chunkType: type });
            }
        }
        offset = dataEnd + 4;
    }
    return blocks;
}

function findCharaBlock(blocks) {
    for (const b of blocks) {
        if (b.keyword === 'chara') return b;
    }
    return null;
}

/**
 * chara 块内容解码：base64 JSON 优先，失败回退纯 UTF-8 文本（支持去除 UTF-8 BOM）。
 */
export function decodeCharaContent(content) {
    if (typeof content !== 'string') return null;
    // 先试 base64
    try {
        let text = Buffer.from(content, 'base64').toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const parsed = JSON.parse(text);
        return { parsed, viaBase64: true };
    } catch {
        // fallthrough
    }
    // 再试纯文本 JSON
    try {
        let text = content;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const parsed = JSON.parse(text);
        return { parsed, viaBase64: false };
    } catch {
        return null;
    }
}

/** 判定 spec */
export function detectSpec(dataObj) {
    if (dataObj && typeof dataObj === 'object') {
        const spec = dataObj.spec;
        if (typeof spec === 'string' && /^chara_card_v[23]$/.test(spec)) return spec;
        if (dataObj.data && typeof dataObj.data === 'object' && typeof dataObj.data.spec === 'string') {
            const s = dataObj.data.spec;
            if (/^chara_card_v[23]$/.test(s)) return s;
        }
        if (dataObj.spec === 'rphub' || dataObj.rp_hub_export === true) return 'rphub_export';
        if (typeof spec === 'string' && spec) return spec;
    }
    return 'unknown';
}

/**
 * 主入口：PNG → { spec, data, blocks, features }
 * @param {Buffer} buffer PNG 原始字节
 */
export function parsePng(buffer) {
    if (!(buffer instanceof Buffer)) buffer = Buffer.from(buffer);

    const blocks = extractPngBlocks(buffer);
    if (blocks.length === 0) {
        throw errParseFailed('extract', 'PNG 块提取失败：未找到任何文本块');
    }

    const charaBlock = findCharaBlock(blocks);
    if (!charaBlock) {
        throw errParseFailed('extract', 'PNG 块提取失败：缺少 chara 块');
    }

    const decoded = decodeCharaContent(charaBlock.content);
    if (!decoded) {
        throw errParseFailed('parse', 'chara 块内容无法解码为 JSON（base64 与纯文本均失败）');
    }

    // 解包：顶层可能为 { spec, data } 或直接为角色对象
    let dataObj = decoded.parsed;
    let spec = detectSpec(dataObj);
    if (dataObj && typeof dataObj === 'object' && 'data' in dataObj && dataObj.data && typeof dataObj.data === 'object') {
        // { spec, data } 包裹形态：data 即角色对象
        dataObj = dataObj.data;
        if (spec === 'unknown') spec = detectSpec(dataObj);
    }

    const features = ['png', 'chara_block'];
    return { spec, data: dataObj, blocks, features };
}
