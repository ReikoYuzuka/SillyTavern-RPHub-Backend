// lib/writeback.js — writeBack 能力：规范化数据 → ST 标准角色卡 PNG → 直接写入用户角色目录
//
// 位置约定（ST 1.18.0）：
//   - 角色卡目录：request.user.directories.characters（绝对路径，路由在登录中间件之后）
//   - 卡文件 = 头像文件：<角色名>.png，PNG tEXt 'chara'（v2）+ 'ccv3'（v3）内嵌角色 JSON
//   - 文件名：sanitize(角色名) + getUniqueName 去重（base / base1 / base2 …，无空格括号风格）
//   - 落盘：临时文件 + rename 原子替换
//
// 复用 ST 的 character-card-parser.js write()（同进程内直接 import，已验证可跨插件包边界
// 解析到 ST 根 node_modules 依赖），构造 chara_card_v2 卡后由 write() 就地生成 ccv3 块。

import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';
import { write as writeStCard } from '../../../src/character-card-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ST 默认头像（JSON 卡无图像时的底图）。从插件位置解析绝对路径，不依赖进程 cwd。
const DEFAULT_AVATAR_PATH = path.resolve(__dirname, '../../../public/img/ai4.png');

/** regex_placement 枚举（public/scripts/extensions/regex/engine.js:281-292） */
const regex_placement = Object.freeze({
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
});

/** substitute_find_regex 枚举（engine.js:298-302） */
const substitute_find_regex = Object.freeze({
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
});

// ---------- 小工具 ----------

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toBool(v, fallback = false) {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true') return true;
        if (s === 'false') return false;
    }
    return !!v;
}

/** 字符串兜底：null/undefined → ''，其余 String() */
function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
}

/** 有限数字或 null（ST 的 minDepth/maxDepth 允许 null） */
function finiteOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** 未转义 / 转义为 \/，保证 /pattern/flags 字面量可被 ST regexFromString 解析 */
function escapeRegexSlashes(pattern) {
    return String(pattern).replace(/(?<!\\)\//g, '\\/');
}

/**
 * findRegex 重新内嵌 flags：规范化阶段用 splitRegexLiteral 拆开了 /pattern/flags 字面量，
 * ST 侧没有独立 flags 字段（regexFromString 只认字面量），写回时按 ST 实际读取逻辑重组：
 *   flags 非空 → /<pattern>/<flags>；空 → 原样纯模式。
 */
export function embedRegexFlags(pattern, flags) {
    if (!flags) return String(pattern);
    return `/${escapeRegexSlashes(pattern)}/${flags}`;
}

/**
 * ST getUniqueName 等价实现（src/util.js:592）。角色卡命名风格：base / base1 / base2…（startIndex=0）。
 * @param {string} baseName
 * @param {(name: string) => boolean} exists
 * @returns {string|null}
 */
export function getUniqueName(baseName, exists, { startIndex = 0, maxTries = 10000 } = {}) {
    for (let i = startIndex; i < maxTries + startIndex; i++) {
        const candidate = i === 0 ? baseName : `${baseName}${i}`;
        if (!exists(candidate)) return candidate;
    }
    return null;
}

// ---------- 正则：规范化 → ST 原生 12 字段 ----------

/**
 * 规范化正则条目 → ST regex_scripts 条目。
 * 规范化字段：id/scriptName/findRegex/replaceString/regexFlags/enabled/trimOutput/
 *             markdownOnly/promptOnly/userOnly/substituteRegex/placement/depth/scope/source/raw
 * ST 字段：id/scriptName/findRegex/replaceString/trimStrings/placement/disabled/
 *          markdownOnly/promptOnly/runOnEdit/substituteRegex/minDepth/maxDepth
 *
 * 关键转换（依据 ST regex/engine.js 实际读取逻辑）：
 *   - enabled → disabled 取反（runRegexScript 判 !disabled）
 *   - userOnly → ST 无此字段。退化映射为 placement=[USER_INPUT]（仅用户输入阶段生效，
 *     getRegexedString 按 script.placement.includes(placement) 过滤，USER_INPUT=1），
 *     最接近 RP-Hub「仅对用户消息生效」语义的 ST 原生等价物。
 *   - regexFlags → 内嵌为 findRegex 的 /pattern/flags 字面量（regexFromString 解析）
 *   - depth → minDepth（ST 用 minDepth/maxDepth 判定深度范围；优先 raw 原值，fallback 规范化 depth）
 *   - substituteRegex（规范化是 boolean）→ 优先 raw 数字枚举，否则 true→RAW(1)/false→NONE(0)
 *   - runOnEdit：规范化未收纳，从 raw 透传（真实 RP-Hub 卡带 runOnEdit 标记）
 *   - trimStrings：规范化只有 trimOutput 布尔，实际裁切串从 raw.trimStrings 透传
 *   - source/raw 不写入标准卡（插件侧 normalized 已保留）
 */
export function mapRegexToSt(entry) {
    const raw = isPlainObject(entry?.raw) ? entry.raw : {};
    const name = typeof entry?.scriptName === 'string' && entry.scriptName ? entry.scriptName : 'Regex Script';

    // flags 内嵌
    const pattern = typeof entry?.findRegex === 'string' ? entry.findRegex : '';
    const flags = typeof entry?.regexFlags === 'string' ? entry.regexFlags : '';
    const findRegex = embedRegexFlags(pattern, flags);

    // placement：userOnly 强制 USER_INPUT
    let placement = [];
    if (Array.isArray(entry?.placement)) {
        placement = entry.placement.map(Number).filter((v) => Number.isInteger(v));
    }
    if (toBool(entry?.userOnly, false)) {
        placement = [regex_placement.USER_INPUT];
    }
    if (placement.length === 0) placement = [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT];

    // substituteRegex 数字枚举
    let substituteRegex = substitute_find_regex.NONE;
    const rawSub = raw.substituteRegex;
    if (rawSub !== undefined && rawSub !== null && typeof rawSub !== 'boolean') {
        const n = Number(rawSub);
        if ([0, 1, 2].includes(n)) substituteRegex = n;
    } else if (entry?.substituteRegex === true || rawSub === true) {
        substituteRegex = substitute_find_regex.RAW;
    }

    // minDepth / maxDepth：raw 原值优先（规范化 depth = minDepth 的归一值）
    const minDepth = finiteOrNull(raw.minDepth) ?? finiteOrNull(entry?.depth) ?? null;
    const maxDepth = finiteOrNull(raw.maxDepth) ?? null;

    return {
        id: typeof entry?.id === 'string' && entry.id
            ? entry.id
            : `rx_${createHash('sha256').update(`${name}\u0000${findRegex}\u0000${str(entry?.replaceString)}`).digest('hex').slice(0, 12)}`,
        scriptName: name,
        findRegex,
        replaceString: str(entry?.replaceString),
        trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.filter((s) => typeof s === 'string') : [],
        placement,
        disabled: entry?.enabled === false, // enabled → disabled 取反
        markdownOnly: !!entry?.markdownOnly,
        promptOnly: !!entry?.promptOnly,
        runOnEdit: toBool(raw.runOnEdit, false),
        substituteRegex,
        minDepth,
        maxDepth,
    };
}

// ---------- 世界书：规范化 → ST character_book 条目 ----------

/**
 * 规范化世界书条目 → ST v2 世界书条目。
 * ST convertCharacterBook（world-info.js:5498）读取：keys/secondary_keys/comment/content/
 * constant/selective/insertion_order/enabled/position(+extensions.position)/extensions.*。
 * 位置用 ST 数值语义：数值写进 extensions.position（world_info_position），顶层 position
 * 写 'before_char'/'after_char' 字符串（extensions.position 存在时 ST 优先取它）。
 */
export function mapLorebookToSt(entry, index) {
    const raw = isPlainObject(entry?.raw) ? entry.raw : {};
    const rawExt = isPlainObject(raw.extensions) ? raw.extensions : {};

    const position = Number.isInteger(entry?.position) ? entry.position : 4;

    const extensions = {
        ...rawExt,
        position, // world_info_position 数值语义
        exclude_recursion: entry?.excludeRecursion ?? raw.exclude_recursion ?? false,
        probability: entry?.probability ?? 100,
        useProbability: raw.use_probability ?? raw.useProbability ?? true,
        display_index: index,
    };
    const depth = finiteOrNull(raw.depth);
    if (depth !== null) extensions.depth = depth;
    const useRegex = raw.use_regex;
    if (useRegex !== undefined) extensions.use_regex = useRegex;

    return {
        id: index, // ST 以 id 作为 entries 键与 uid
        keys: Array.isArray(entry?.keys) ? entry.keys.slice() : [],
        secondary_keys: Array.isArray(raw.secondary_keys) ? raw.secondary_keys.slice() : [],
        comment: str(entry?.comment),
        content: str(entry?.content),
        constant: !!entry?.constant,
        selective: !!entry?.selective,
        insertion_order: Number.isInteger(raw.insertion_order) ? raw.insertion_order : 100,
        enabled: !entry?.disable, // disable → enabled 取反
        position: position === 0 ? 'before_char' : 'after_char',
        extensions,
    };
}

// ---------- 角色卡构造 ----------

/**
 * 规范化数据 → ST 标准角色卡（chara_card_v2 形态）。
 * - 角色字段直映（name/description/personality/first_mes/mes_example/scenario/
 *   system_prompt/post_history_instructions/creator_notes/tags）
 * - 补 create_date（当前 ISO 时间，前端日期域依赖）
 * - unsetPrivateFields 等价（src/endpoints/characters.js:498）：fav=false（顶层 + data.extensions.fav）、
 *   不写 chat（ST 读取时 readFromV2 会补默认 chat）
 * - data.extensions.regex_scripts = 规范化正则 → ST 12 字段
 * - data.character_book = 规范化世界书 → ST 世界书条目
 * @param {object} normalized 规范化顶层对象（pipeline 输出）
 * @returns {object} v2 角色卡
 */
export function buildStandardCard(normalized) {
    const character = isPlainObject(normalized?.character) ? normalized.character : {};
    const name = typeof character.name === 'string' && character.name ? character.name : 'Unknown';

    // extensions 原样透传为底，剥离原始正则字段后写入映射后的 regex_scripts
    const baseExt = isPlainObject(character.extensions) ? character.extensions : {};
    const extensions = { ...baseExt };
    delete extensions.regex_scripts;
    delete extensions.rp_hub_regex_scripts;
    if (extensions.talkativeness === undefined) extensions.talkativeness = 0.5;
    extensions.fav = false;

    const regexScripts = Array.isArray(normalized?.regex)
        ? normalized.regex.map((r) => mapRegexToSt(r))
        : [];
    if (regexScripts.length > 0) extensions.regex_scripts = regexScripts;

    const data = {
        name,
        description: str(character.description),
        personality: str(character.personality),
        scenario: str(character.scenario),
        first_mes: str(character.first_mes),
        mes_example: str(character.mes_example),
        creator_notes: str(character.creator_notes),
        system_prompt: str(character.system_prompt),
        post_history_instructions: str(character.post_history_instructions),
        tags: Array.isArray(character.tags) ? character.tags.slice() : [],
        creator: '',
        character_version: '',
        alternate_greetings: [],
        extensions,
    };

    if (Array.isArray(normalized?.lorebook) && normalized.lorebook.length > 0) {
        data.character_book = {
            name,
            entries: normalized.lorebook.map((entry, index) => mapLorebookToSt(entry, index)),
        };
    }

    const create_date = new Date().toISOString();

    // v2 顶层：与 ST charaFormatData 产出形态一致（顶层冗余字段 + data 权威双写）
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: data.creator_notes,
        avatar: 'none',
        talkativeness: extensions.talkativeness ?? 0.5,
        fav: false, // unsetPrivateFields：fav 清零
        tags: data.tags,
        create_date,
        data,
    };
}

// ---------- PNG 生成与落盘 ----------

let _defaultAvatarCache = null;

function readDefaultAvatar() {
    if (!_defaultAvatarCache) {
        _defaultAvatarCache = fs.readFileSync(DEFAULT_AVATAR_PATH);
    }
    return _defaultAvatarCache;
}

/**
 * 底图解析：PNG 卡用原始上传字节（write() 会替换其中 chara/ccv3 块），JSON 卡用 ST 默认头像。
 */
export function resolveBaseImage(format, buffer) {
    if (format === 'png' && buffer instanceof Buffer && buffer.length > 0) {
        return buffer;
    }
    return readDefaultAvatar();
}

/**
 * 生成标准卡 PNG（chara v2 + ccv3 块，复用 ST character-card-parser.write()）。
 * @param {object} card buildStandardCard 输出的 v2 卡
 * @param {Buffer} baseImage 底图 PNG 字节
 * @returns {Buffer} 标准卡 PNG 字节
 */
export function writeStandardPng(card, baseImage) {
    return Buffer.from(writeStCard(baseImage, JSON.stringify(card)));
}

/** 原子写：临时文件 + rename（插件 store.js 同款模式） */
function atomicWrite(filePath, buffer) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw err;
    }
}

/**
 * 落盘：去重命名 → 生成 PNG → 原子写 → 返回文件名。
 * @param {Buffer} outputImage 标准卡 PNG 字节
 * @param {string} charactersDir request.user.directories.characters 绝对路径
 * @param {string} name 角色名
 * @returns {{ fileName: string, avatarFileName: string }}
 */
export function persistStandardPng(outputImage, charactersDir, name) {
    if (!fs.existsSync(charactersDir)) {
        fs.mkdirSync(charactersDir, { recursive: true });
    }
    const base = sanitize(name) || 'Unknown';
    const exists = (candidate) => fs.existsSync(path.join(charactersDir, `${candidate}.png`));
    const fileName = getUniqueName(base, exists) ?? base;
    const finalPath = path.join(charactersDir, `${fileName}.png`);
    atomicWrite(finalPath, outputImage);
    return { fileName, avatarFileName: `${fileName}.png` };
}

/**
 * writeBack 一站式入口（路由调用）：
 * 规范化数据 → 标准卡 → PNG → 用户角色目录，返回 avatar 文件名。
 * 写回失败时抛错（由路由捕获转 standardCard 容错，不影响插件主流程落盘）。
 * @param {object} normalized 规范化数据
 * @param {{ format: string, buffer: Buffer, charactersDir: string }} opts
 * @returns {{ fileName: string, avatarFileName: string }}
 */
export function writeBackToSt(normalized, { format, buffer, charactersDir }) {
    const card = buildStandardCard(normalized);
    let baseImage = resolveBaseImage(format, buffer);

    let outputImage;
    try {
        outputImage = writeStandardPng(card, baseImage);
    } catch (err) {
        // 原始底图写失败（理论不会：PNG 已过解析）→ 退 ST 默认头像再试一次
        if (baseImage === _defaultAvatarCache) throw err;
        outputImage = writeStandardPng(card, readDefaultAvatar());
    }

    const name = card.data.name || card.name || 'Unknown';
    return persistStandardPng(outputImage, charactersDir, name);
}
