import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import pino, { type Logger } from "pino"

import {
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  chatCompletionChunksFromCommandCodeEvents,
  chatCompletionFromChunks,
  convertChatCompletionRequestToCommandCode,
  createChatCompletionStreamTranslator,
} from "./chat-completions.ts"
import {
  parseCommandCodeStreamChunk,
  parseCommandCodeStreamRemainder,
} from "./command-code-stream.ts"
import type { AppConfig } from "./config.ts"
import { modelList } from "./models.ts"
import {
  convertResponsesRequestToCommandCode,
  createResponsesStreamTranslator,
  responsesEventsFromCommandCodeEvents,
} from "./responses.ts"
import type { CommandCodeStreamEvent, ResponsesRequest, ResponsesStreamEvent } from "./types.ts"
import { isRecord, stringValue } from "./utils.ts"

export interface ProxyServerOptions {
  config: AppConfig
  logger?: Logger
  fetchImpl?: typeof fetch
}

export function createProxyServer(options: ProxyServerOptions): Server {
  const logger = options.logger ?? pino({ level: options.config.logLevel })
  const fetchImpl = options.fetchImpl ?? fetch

  return createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options.config, logger, fetchImpl)
    } catch (error) {
      logger.error({ error }, "Unhandled request error")
      if (!res.headersSent) {
        if (error instanceof SyntaxError) {
          sendOpenAiError(res, 400, {
            message: "Invalid JSON request body",
            type: "invalid_request_error",
            code: "invalid_json",
          })
        } else {
          sendOpenAiError(res, 500, {
            message: errorMessage(error),
            type: "internal_error",
            code: "internal_error",
          })
        }
      } else {
        res.end()
      }
    }
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = req.url?.split("?")[0] ?? "/"
  logger.debug({ method: req.method, url }, "Incoming request")

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (req.method === "GET" && (url === "/models" || url === "/v1/models")) {
    sendJson(res, 200, { object: "list", data: modelList() })
    return
  }

  if (req.method === "POST" && (url === "/responses" || url === "/v1/responses")) {
    await handleResponses(req, res, config, logger, fetchImpl)
    return
  }

  if (req.method === "POST" && (url === "/chat/completions" || url === "/v1/chat/completions")) {
    await handleChatCompletions(req, res, config, logger, fetchImpl)
    return
  }

  if (isUnsupportedResponsesEndpoint(req.method, url)) {
    sendOpenAiError(res, 404, {
      message: "Responses storage endpoints are not supported by cmd-proxy",
      type: "invalid_request_error",
      code: "unsupported_endpoint",
    })
    return
  }

  sendOpenAiError(res, 404, {
    message: "Not found",
    type: "invalid_request_error",
    code: "not_found",
  })
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = await readJsonBody(req)
  if (!isRecord(request)) {
    sendOpenAiError(res, 400, {
      message: "Request body must be a JSON object",
      type: "invalid_request_error",
      code: "invalid_request_body",
    })
    return
  }

  const chatRequest = request as ChatCompletionRequest
  const commandCodePayload = convertChatCompletionRequestToCommandCode(chatRequest)
  const upstream = await fetchCommandCode(req, config, fetchImpl, commandCodePayload)
  if (!upstream.ok) {
    await sendUpstreamError(upstream, res, logger)
    return
  }

  if (chatRequest.stream !== false) {
    sendSseHeaders(res)
    await streamCommandCodeToChatCompletions(upstream, res, chatRequest.model)
    res.write("data: [DONE]\n\n")
    res.end()
  } else {
    const commandCodeEvents = await readCommandCodeEvents(upstream)
    const chunks = chatCompletionChunksFromCommandCodeEvents(commandCodeEvents, {
      ...(chatRequest.model ? { model: chatRequest.model } : {}),
    })
    sendJson(res, 200, chatCompletionFromChunks(chunks))
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = await readJsonBody(req)
  if (!isRecord(request)) {
    sendOpenAiError(res, 400, {
      message: "Request body must be a JSON object",
      type: "invalid_request_error",
      code: "invalid_request_body",
    })
    return
  }

  const responsesRequest = request as ResponsesRequest
  logger.debug(
    {
      model: responsesRequest.model,
      stream: responsesRequest.stream,
      inputType: typeof responsesRequest.input,
      inputItems: Array.isArray(responsesRequest.input) ? responsesRequest.input.length : undefined,
    },
    "Responses request summary",
  )
  const stream = responsesRequest.stream !== false
  const commandCodePayload = convertResponsesRequestToCommandCode(responsesRequest)
  logger.debug(
    {
      commandCodeModel: commandCodePayload.params.model,
      messageCount: commandCodePayload.params.messages.length,
      messageRoles: commandCodePayload.params.messages.map((message) => message.role),
      firstMessagePreview: previewCommandCodeMessage(commandCodePayload.params.messages[0]),
      toolCount: commandCodePayload.params.tools.length,
      tools: commandCodePayload.params.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.input_schema,
      })),
      systemLength: commandCodePayload.params.system.length,
      maxTokens: commandCodePayload.params.max_tokens,
      toolChoiceType: typeof commandCodePayload.params.tool_choice,
    },
    "Command Code request summary",
  )

  const upstream = await fetchCommandCode(req, config, fetchImpl, commandCodePayload)

  if (!upstream.ok) {
    await sendUpstreamError(upstream, res, logger)
    return
  }

  if (stream) {
    sendSseHeaders(res)
    await streamCommandCodeToResponses(upstream, res, responsesRequest.model, logger)
    res.end()
  } else {
    const commandCodeEvents = await readCommandCodeEvents(upstream)
    const responseEvents = responsesEventsFromCommandCodeEvents(commandCodeEvents, {
      ...(responsesRequest.model ? { model: responsesRequest.model } : {}),
    })
    const completed = responseEvents.findLast((event) => event.type === "response.completed")
    sendJson(res, 200, completed?.response ?? {})
  }
}

async function fetchCommandCode(
  req: IncomingMessage,
  config: AppConfig,
  fetchImpl: typeof fetch,
  commandCodePayload: unknown,
): Promise<Response> {
  return await fetchImpl(`${config.commandCodeApiBase}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstreamApiKey(req, config)}`,
      "x-command-code-version": "0.24.1",
      "x-cli-environment": "production",
      "x-project-slug": "cmd-proxy",
      "x-taste-learning": "false",
      "x-co-flag": "false",
      "x-session-id": randomUUID(),
    },
    body: JSON.stringify(commandCodePayload),
  })
}

async function sendUpstreamError(
  upstream: Response,
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  const body = await upstream.text().catch((error: unknown) => errorMessage(error))
  logger.warn({ status: upstream.status, body: body.slice(0, 500) }, "Command Code upstream error")
  sendOpenAiError(res, upstream.status, {
    message: `Command Code API error ${upstream.status}: ${body.slice(0, 500)}`,
    type: openAiErrorTypeForStatus(upstream.status),
    code: `upstream_${upstream.status}`,
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let body = ""
  for await (const chunk of req) {
    body += chunk
  }
  if (!body.trim()) return {}
  return JSON.parse(body) as unknown
}

async function readCommandCodeEvents(response: Response): Promise<CommandCodeStreamEvent[]> {
  const reader = response.body?.getReader()
  if (!reader) return []
  const decoder = new TextDecoder()
  let buffer = ""
  const events: CommandCodeStreamEvent[] = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const parsed = parseCommandCodeStreamChunk(decoder.decode(value, { stream: true }), buffer)
    events.push(...parsed.events)
    buffer = parsed.buffer
  }
  events.push(...parseCommandCodeStreamRemainder(buffer))
  return events
}

async function streamCommandCodeToResponses(
  response: Response,
  res: ServerResponse,
  model: string | undefined,
  logger: Logger,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    for (const event of createResponsesStreamTranslator().finish()) writeResponsesEvent(res, event)
    return
  }

  const translator = createResponsesStreamTranslator({
    ...(model ? { model } : {}),
  })
  const decoder = new TextDecoder()
  let buffer = ""
  let commandCodeEventCount = 0
  let responseEventCount = 0
  const commandCodeEventTypes: string[] = []
  const responseEventTypes: string[] = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const parsed = parseCommandCodeStreamChunk(decoder.decode(value, { stream: true }), buffer)
    buffer = parsed.buffer
    for (const commandCodeEvent of parsed.events) {
      commandCodeEventCount += 1
      const commandCodeEventType = stringValue(commandCodeEvent.type) ?? ""
      commandCodeEventTypes.push(commandCodeEventType)
      if (commandCodeEventType === "error") {
        logger.warn(
          { commandCodeError: commandCodeEvent },
          "Command Code stream returned error event",
        )
      }
      for (const responseEvent of translator.push(commandCodeEvent)) {
        responseEventCount += 1
        responseEventTypes.push(responseEvent.type)
        writeResponsesEvent(res, responseEvent)
      }
    }
  }

  for (const commandCodeEvent of parseCommandCodeStreamRemainder(buffer)) {
    commandCodeEventCount += 1
    const commandCodeEventType = stringValue(commandCodeEvent.type) ?? ""
    commandCodeEventTypes.push(commandCodeEventType)
    if (commandCodeEventType === "error") {
      logger.warn(
        { commandCodeError: commandCodeEvent },
        "Command Code stream returned error event",
      )
    }
    for (const responseEvent of translator.push(commandCodeEvent)) {
      responseEventCount += 1
      responseEventTypes.push(responseEvent.type)
      writeResponsesEvent(res, responseEvent)
    }
  }
  for (const responseEvent of translator.finish()) {
    responseEventCount += 1
    responseEventTypes.push(responseEvent.type)
    writeResponsesEvent(res, responseEvent)
  }
  logger.debug(
    {
      commandCodeEventCount,
      commandCodeEventTypes,
      responseEventCount,
      responseEventTypes,
    },
    "Responses stream translation summary",
  )
}

async function streamCommandCodeToChatCompletions(
  response: Response,
  res: ServerResponse,
  model: string | undefined,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    for (const chunk of createChatCompletionStreamTranslator().finish()) writeSseData(res, chunk)
    return
  }

  const translator = createChatCompletionStreamTranslator({
    ...(model ? { model } : {}),
  })
  const decoder = new TextDecoder()
  let buffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const parsed = parseCommandCodeStreamChunk(decoder.decode(value, { stream: true }), buffer)
    buffer = parsed.buffer
    for (const commandCodeEvent of parsed.events) {
      for (const chunk of translator.push(commandCodeEvent)) writeChatCompletionChunk(res, chunk)
    }
  }

  for (const commandCodeEvent of parseCommandCodeStreamRemainder(buffer)) {
    for (const chunk of translator.push(commandCodeEvent)) writeChatCompletionChunk(res, chunk)
  }
  for (const chunk of translator.finish()) writeChatCompletionChunk(res, chunk)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() })
  res.end(JSON.stringify(value))
}

function sendOpenAiError(
  res: ServerResponse,
  status: number,
  error: { message: string; type: string; code: string },
): void {
  sendJson(res, status, { error: { ...error, param: null } })
}

function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  })
  res.flushHeaders()
}

function writeResponsesEvent(res: ServerResponse, event: ResponsesStreamEvent): void {
  writeSseData(res, event)
}

function writeChatCompletionChunk(res: ServerResponse, chunk: ChatCompletionChunk): void {
  writeSseData(res, chunk)
}

function writeSseData(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}

function previewCommandCodeMessage(
  message:
    | {
        role: string
        content: Array<{ type: string; text?: string; toolName?: string }>
      }
    | undefined,
): string | undefined {
  if (!message) return undefined
  return message.content
    .map((content) => {
      if (content.type === "text") return content.text ?? ""
      if (content.type === "tool-call") return `[tool-call:${content.toolName ?? ""}]`
      return `[${content.type}]`
    })
    .join("\n")
    .slice(0, 300)
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, openai-organization, openai-project",
    "Access-Control-Max-Age": "86400",
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined
}

function upstreamApiKey(req: IncomingMessage, config: AppConfig): string {
  if (config.authMode === "fixed" || config.authMode === "none") return config.apiKey
  return bearerToken(req) ?? config.apiKey
}

function openAiErrorTypeForStatus(status: number): string {
  if (status === 401 || status === 403) return "authentication_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "server_error"
  return "upstream_error"
}

function isUnsupportedResponsesEndpoint(method: string | undefined, url: string): boolean {
  if (!method) return false
  if (method === "GET") {
    return (
      /^\/(?:v1\/)?responses\/[^/]+$/.test(url) ||
      /^\/(?:v1\/)?responses\/[^/]+\/input_items$/.test(url)
    )
  }
  if (method === "DELETE") {
    return /^\/(?:v1\/)?responses\/[^/]+$/.test(url)
  }
  if (method === "POST") {
    return /^\/(?:v1\/)?responses\/(?:[^/]+\/cancel|compact|input_tokens)$/.test(url)
  }
  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
