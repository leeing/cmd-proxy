export class OpenAiRequestError extends Error {
  readonly status: number
  readonly type: string
  readonly code: string
  readonly param: string | null

  constructor(
    message: string,
    options: { status?: number; type?: string; code?: string; param?: string | null } = {},
  ) {
    super(message)
    this.name = "OpenAiRequestError"
    this.status = options.status ?? 400
    this.type = options.type ?? "invalid_request_error"
    this.code = options.code ?? "invalid_request"
    this.param = options.param ?? null
  }
}
