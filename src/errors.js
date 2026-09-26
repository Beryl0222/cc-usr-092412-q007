/** 领域错误：服务以错误码区分调用方应如何处理。 */

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 载荷不完整或值不合法。 */
export class ValidationError extends DomainError {
  constructor(message) {
    super("VALIDATION_ERROR", message);
    this.name = "ValidationError";
  }
}

/** 签署人角色无权执行该动作。 */
export class AuthorizationError extends DomainError {
  constructor(message) {
    super("AUTHORIZATION_ERROR", message);
    this.name = "AuthorizationError";
  }
}

/** 与当前链状态冲突（如紧急停止后仍开训、交接名额不平）。 */
export class ConflictError extends DomainError {
  constructor(message) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

/** 引用的链、处方、复核记录不存在。 */
export class NotFoundError extends DomainError {
  constructor(message) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}
