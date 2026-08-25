// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

// lib/errors.js — 统一错误构造（见 接口契约/错误码.md）

export class ApiError extends Error {
    /**
     * @param {number} status HTTP 状态码
     * @param {string} code 错误码（错误码表）
     * @param {string} message 面向开发者的中文说明
     * @param {object} [details] 可选附加上下文
     */
    constructor(status, code, message, details = undefined) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.details = details;
    }

    /** 序列化为契约规定的错误响应体 */
    toJSON() {
        const body = { error: { code: this.code, message: this.message } };
        if (this.details !== undefined) {
            body.error.details = this.details;
        }
        return body;
    }
}

// —— 错误码表便捷构造 ——

export const errorBadRequest = (code, message, details) => new ApiError(400, code, message, details);
export const errorNotFound = (code, message, details) => new ApiError(404, code, message, details);
export const errorConflict = (code, message, details) => new ApiError(409, code, message, details);
export const errorUnprocessable = (code, message, details) => new ApiError(422, code, message, details);
export const errorIo = (message, details) => new ApiError(500, 'IO_ERROR', message, details);
export const errorInternal = (err) => {
    const e = new ApiError(500, 'INTERNAL', '服务器内部错误', { name: err?.name || 'Error' });
    return e;
};

export const errInvalidCardId = () => errorBadRequest('INVALID_CARD_ID', 'cardId 为空或格式非法');
export const errNotFound = () => errorNotFound('NOT_FOUND', '卡不存在（未导入或已删除）');
export const errInvalidContentHash = () => errorBadRequest('INVALID_CONTENT_HASH', 'contentHash 非法：须为 64 位小写十六进制 sha256');
export const errUnsupportedFormat = () => errorUnprocessable('UNSUPPORTED_FORMAT', '格式不支持：仅接受 PNG 或 JSON');
export const errParseFailed = (stage, message) => errorUnprocessable('PARSE_FAILED', message || '解析失败', { stage });
export const errInvalidCharacter = (reason) => errorUnprocessable('INVALID_CHARACTER', '解析出对象但无可识别的角色数据', { reason });
export const errUnsupportedMarkType = (type) => errorUnprocessable('UNSUPPORTED_MARK_TYPE', `不支持的标记类型：${type}（当前仅支持 rphub）`);

// —— body-parser 错误白名单映射（F-1）——

/** 已知 body-parser err.type → HTTP 状态码。白名单外一律回退 500，防透传任意内部状态码。 */
const BODY_PARSER_ERROR_STATUS = new Map([
    ['entity.too.large', 413],      // 请求体超过 express.raw 上限（35mb）
    ['entity.parse.failed', 400],   // 请求体解析失败
    ['entity.verify.failed', 400],  // 内容校验失败
    ['encoding.unsupported', 415],  // Content-Encoding 不支持
    ['charset.unsupported', 415],   // Charset 不支持
    ['request.aborted', 408],       // 客户端中途中断
    ['request.timeout', 408],       // 请求超时
]);

/** HTTP 状态码 → 契约错误码 */
const STATUS_ERROR_CODE = { 400: 'REQUEST_INVALID', 408: 'REQUEST_TIMEOUT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE' };

/** 构造超限 413（details 携带 limit，便于调用方前置校验体积） */
export function errorPayloadTooLarge(limit) {
    return new ApiError(
        413,
        'PAYLOAD_TOO_LARGE',
        limit ? `请求体超过大小上限（${limit}）` : '请求体超过大小上限',
        limit === undefined ? undefined : { limit },
    );
}

/**
 * body-parser 已知错误 → ApiError；非白名单返回 null。
 * 同时核对 err.status / err.statusCode 数字信号（body-parser 双字段都会设置，
 * 部分变体只设其一）；数字信号仅采信与白名单一致的 413，绝不盲信任意状态码。
 */
function mapBodyParserError(err) {
    const statusByType = BODY_PARSER_ERROR_STATUS.get(err.type);
    if (statusByType !== undefined) {
        if (statusByType === 413) {
            return errorPayloadTooLarge(typeof err.limit === 'string' ? err.limit : undefined);
        }
        return new ApiError(statusByType, STATUS_ERROR_CODE[statusByType], `请求无法处理：${err.type}`, { type: err.type });
    }
    const numericStatus = Number(err.status ?? err.statusCode);
    if (numericStatus === 413) return errorPayloadTooLarge(undefined);
    return null;
}

/**
 * 兜底：把任意抛出的值归一为 ApiError。
 * 归一顺序（F-1）：ApiError 直通 → body-parser 白名单（413/400/408/415）→ 其余包装为 INTERNAL。
 */
export function toApiError(err) {
    if (err instanceof ApiError) return err;
    if (err && typeof err === 'object') {
        const mapped = mapBodyParserError(err);
        if (mapped) return mapped;
    }
    return errorInternal(err);
}

/**
 * express 中间件：把任意错误写为契约 JSON 响应。
 * - headersSent 守卫：响应已开始后再写体会抛 ERR_HTTP_HEADERS_SENT 二次崩溃，
 *   此处记录日志后转交 next(err)，由 Express 默认处理器关闭连接；
 * - 日志分级（N-L-2）：按归一后的严重度决定——映射为 5xx 的错误才记录：
 *   非 ApiError 来源（真 bug）→ console.error（含 stack 与请求行，不打 headers/body）；
 *   ApiError 且 status≥500 → console.warn（含 message 与 details.operation）；
 *   归一后为 4xx（含白名单映射出的 413 等）属预期客户端条件，不打，防刷屏。
 */
export function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        console.error('[rp-hub-compat] 响应头已发送后收到错误，转交默认处理器关闭连接:', err);
        next(err);
        return;
    }

    const apiErr = toApiError(err);
    if (apiErr.status >= 500) {
        if (err instanceof ApiError) {
            const op = err.details && err.details.operation ? ` operation=${err.details.operation}` : '';
            console.warn(`[rp-hub-compat] 服务端错误 ${err.status} ${err.code}: ${err.message}${op}`);
        } else {
            console.error(`[rp-hub-compat] 未处理异常 ${req.method} ${req.originalUrl}:`, err);
        }
    }

    res.status(apiErr.status).json(apiErr.toJSON());
}
