export type OpenAiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_error"
  | "timeout_error";

export class OpenAiError extends Error {
  readonly status: 400 | 401 | 404 | 405 | 429 | 500 | 502 | 504;
  readonly type: OpenAiErrorType;
  readonly code: string;
  readonly param: string | null;

  constructor(
    status: 400 | 401 | 404 | 405 | 429 | 500 | 502 | 504,
    type: OpenAiErrorType,
    code: string,
    message: string,
    param: string | null = null,
  ) {
    super(message);
    this.name = "OpenAiError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }
}

export function invalidRequest(message: string, param: string | null = null): never {
  throw new OpenAiError(400, "invalid_request_error", "invalid_request", message, param);
}
