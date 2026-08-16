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

/**
 * 兜底：把任意抛出的值归一为 ApiError（保持原 ApiError 不动，其余包装为 INTERNAL）。
 */
export function toApiError(err) {
    if (err instanceof ApiError) return err;
    return errorInternal(err);
}

/** express 中间件：把 ApiError 写为 JSON 响应 */
export function errorHandler(err, req, res, next) {
    const apiErr = toApiError(err);
    res.status(apiErr.status).json(apiErr.toJSON());
}
