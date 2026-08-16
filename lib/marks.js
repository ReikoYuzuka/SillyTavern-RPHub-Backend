// lib/marks.js — 手动标记读写（见 接口契约/标记接口.md）
//
// marks.json 结构与卡数据独立：
//   { "version": 1, "marks": { "<contentHash>": { type, note?, markedAt } } }
//
// 纯函数式设计：读写走 store，判定逻辑可单测。

export const SUPPORTED_MARK_TYPES = ['rphub'];

export function isSupportedMarkType(type) {
    return SUPPORTED_MARK_TYPES.includes(type);
}

/** 从 marks 对象取单个标记记录（无则 null） */
export function findMark(marksObj, contentHash) {
    const marks = marksObj && typeof marksObj === 'object' ? (marksObj.marks || marksObj) : {};
    return marks[contentHash] || null;
}

/** 构建单条标记记录 */
export function buildMark(type, note) {
    return {
        type,
        note: note !== undefined && note !== null ? String(note) : undefined,
        markedAt: new Date().toISOString(),
    };
}

/** 设置标记（幂等）：返回 { contentHash, marked: true, mark } */
export function setMark(marksObj, contentHash, type, note) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : undefined;
    const store = marks ? marks : {};
    const mark = buildMark(type, note);
    store[contentHash] = mark;
    if (!marks) marksObj = { version: 1, marks: store };
    return { contentHash, marked: true, mark };
}

/** 取消标记（幂等）：返回 { contentHash, marked: false, mark: null } */
export function clearMark(marksObj, contentHash) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : undefined;
    const store = marks ? marks : {};
    if (contentHash in store) delete store[contentHash];
    if (!marks) marksObj = { version: 1, marks: store };
    return { contentHash, marked: false, mark: null };
}

/** 全部标记列表（数组形态，供 GET /v1/marks） */
export function listMarks(marksObj) {
    const marks = marksObj && typeof marksObj === 'object' ? marksObj.marks : {};
    return Object.entries(marks || {}).map(([contentHash, mark]) => ({
        contentHash,
        type: mark.type,
        note: mark.note,
        markedAt: mark.markedAt,
    }));
}

/** 查询单个标记状态：{ contentHash, marked, mark } */
export function getMarkStatus(marksObj, contentHash) {
    const mark = findMark(marksObj, contentHash);
    return { contentHash, marked: !!mark, mark: mark || null };
}
