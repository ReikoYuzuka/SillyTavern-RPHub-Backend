// lib/parse/json.js — 纯 JSON 卡解析（见 格式解析/JSON卡解析.md）
//
// 输入 buffer → 跳过前导空白 → JSON.parse → 形态判定：
//   a. 整体是角色数据对象（含 name/spec/description 等）→ 直接用
//   b. 是包裹对象（{ chara: {...}, data: {...} }）→ 解包取角色对象
//   c. 数组 → 取第一个元素后按 a/b 再判定
//   d. 无法识别 → INVALID_CHARACTER
//
// 输出：{ spec, data, blocks: [], features }

import { errParseFailed, errInvalidCharacter } from '../errors.js';

function isPlausibleCharacterObject(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (typeof obj.spec === 'string' && /^chara_card_v[23]$/.test(obj.spec)) return true;
    if (typeof obj.spec === 'string' && obj.spec) return true;
    if (typeof obj.data === 'object' && obj.data && typeof obj.data.name === 'string') return true;
    if (typeof obj.name === 'string') return true;
    if (typeof obj.char_name === 'string') return true;
    return false;
}

function unwrap(obj) {
    let current = obj;
    // 数组取首个元素
    while (Array.isArray(current)) {
        if (current.length === 0) return null;
        current = current[0];
    }
    // 包裹形态解包
    for (let guard = 0; guard < 4; guard++) {
        if (!current || typeof current !== 'object') return null;
        if (isPlausibleCharacterObject(current)) return current;
        // 常见包裹键：chara / character / card / data
        if ('chara' in current) current = current.chara;
        else if ('character' in current && typeof current.character === 'object') current = current.character;
        else if ('card' in current && typeof current.card === 'object') current = current.card;
        else if ('data' in current && typeof current.data === 'object' && !isPlausibleCharacterObject(current)) {
            current = current.data;
        } else {
            break;
        }
    }
    return isPlausibleCharacterObject(current) ? current : null;
}

function detectSpec(dataObj) {
    if (dataObj && typeof dataObj === 'object') {
        const spec = dataObj.spec;
        if (typeof spec === 'string' && /^chara_card_v[23]$/.test(spec)) return spec;
        if (dataObj.data && typeof dataObj.data === 'object' && typeof dataObj.data.spec === 'string') {
            const s = dataObj.data.spec;
            if (/^chara_card_v[23]$/.test(s)) return s;
        }
        if (typeof spec === 'string' && spec) return spec;
    }
    return 'unknown';
}

/**
 * 主入口：JSON 字节 → { spec, data, blocks, features }
 * @param {Buffer} buffer
 */
export function parseJson(buffer) {
    if (!(buffer instanceof Buffer)) buffer = Buffer.from(buffer);
    const text = buffer.toString('utf8');

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw errParseFailed('parse', `JSON 解析失败：${err.message}`);
    }

    const data = unwrap(parsed);
    if (!data) {
        throw errInvalidCharacter('JSON 对象中未找到可识别的角色数据（name/spec/description 均缺失）');
    }

    // 解包 { spec, data } 包裹形态（chara_card_v2/v3 导出 JSON）→ 取 data 为角色对象
    let spec = detectSpec(parsed);
    let character = data;
    if (isPlausibleCharacterObject(data)
        && data.data && typeof data.data === 'object'
        && typeof data.spec === 'string') {
        character = data.data;
    }
    if (spec === 'unknown') spec = detectSpec(character);

    return { spec, data: character, blocks: [], features: ['json'] };
}
