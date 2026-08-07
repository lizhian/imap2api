export class AccountNotFoundError extends Error {
  constructor() {
    super("邮箱账号不存在");
    this.name = "AccountNotFoundError";
  }
}

export class MessageNotFoundError extends Error {
  constructor() {
    super("邮件不存在");
    this.name = "MessageNotFoundError";
  }
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}
