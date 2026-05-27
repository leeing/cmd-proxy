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
import {
  type AnthropicMessageRequest,
  type AnthropicSseEvent,
  anthropicMessagesFromCommandCodeEvents,
  convertAnthropicRequestToCommandCode,
  createAnthropicMessagesStreamTranslator,
} from "./messages.ts"
import { modelList } from "./models.ts"
import type { ResponseStore } from "./response-store.ts"
import {
  convertResponsesRequestToCommandCode,
  createResponsesStreamTranslator,
  responsesEventsFromCommandCodeEvents,
} from "./responses.ts"
import type { CommandCodeStreamEvent, ResponsesRequest, ResponsesStreamEvent } from "./types.ts"
import { idWithPrefix, isRecord, stringValue } from "./utils.ts"

export interface ProxyServerOptions {
  config: AppConfig
  logger?: Logger
  fetchImpl?: typeof fetch
  store?: ResponseStore
}

export function createProxyServer(options: ProxyServerOptions): Server {
  const logger = options.logger ?? pino({ level: options.config.logLevel })
  const fetchImpl = options.fetchImpl ?? fetch
  const store = options.store ?? null

  return createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options.config, logger, fetchImpl, store)
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
  store: ResponseStore | null,
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

  if (config.authMode === "pass_through" && req.method === "POST") {
    const clientKey = apiKeyFromRequest(req)
    if (clientKey !== undefined && clientKey !== config.apiKey) {
      sendOpenAiError(res, 401, {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      })
      return
    }
  }

  if (req.method === "POST" && (url === "/responses" || url === "/v1/responses")) {
    await handleResponses(req, res, config, logger, fetchImpl, store)
    return
  }

  if (req.method === "POST" && (url === "/chat/completions" || url === "/v1/chat/completions")) {
    await handleChatCompletions(req, res, config, logger, fetchImpl)
    return
  }

  if (req.method === "POST" && (url === "/messages" || url === "/v1/messages")) {
    await handleMessages(req, res, config, logger, fetchImpl)
    return
  }

  const storageResult = handleStorageEndpoint(req, res, url, store)
  if (storageResult.handled) return

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
    const includeUsage = chatRequest.stream_options?.include_usage === true
    await streamCommandCodeToChatCompletions(upstream, res, chatRequest.model, includeUsage)
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
  store: ResponseStore | null,
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
  const responseId = stringValue(responsesRequest.id) ?? idWithPrefix("resp")

  // Inject previous response output as assistant/tool input items for conversation continuity
  const inputWithContext = injectPreviousResponseContext(responsesRequest, store)
  const requestWithContext: ResponsesRequest = inputWithContext
    ? { ...responsesRequest, input: inputWithContext }
    : responsesRequest

  const commandCodePayload = convertResponsesRequestToCommandCode(requestWithContext)
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

  const controller = new AbortController()
  if (store) store.registerActive(responseId, controller)

  const upstream = await fetchCommandCode(
    req,
    config,
    fetchImpl,
    commandCodePayload,
    controller.signal,
  )

  if (!upstream.ok) {
    if (store) store.deregisterActive(responseId)
    await sendUpstreamError(upstream, res, logger)
    return
  }

  if (stream) {
    sendSseHeaders(res)
    await streamCommandCodeToResponses(upstream, res, responsesRequest, logger, responseId, store)
    if (store) store.deregisterActive(responseId)
    res.end()
  } else {
    const commandCodeEvents = await readCommandCodeEvents(upstream)
    const responseEvents = responsesEventsFromCommandCodeEvents(commandCodeEvents, {
      responseId,
      ...(responsesRequest.model ? { model: responsesRequest.model } : {}),
    })
    const completed = responseEvents.findLast((event) => event.type === "response.completed")
    const response = completed?.response ?? {}
    if (store) {
      store.store(responseId, {
        response,
        input: responsesRequest.input,
        instructions: responsesRequest.instructions,
        model: responsesRequest.model,
        createdAt: Math.floor(Date.now() / 1000),
      })
      store.deregisterActive(responseId)
    }
    sendJson(res, 200, response)
  }
}

async function fetchCommandCode(
  req: IncomingMessage,
  config: AppConfig,
  fetchImpl: typeof fetch,
  commandCodePayload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(config.upstreamTimeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  return await fetchImpl(`${config.apiBase}/alpha/generate`, {
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
    signal: combinedSignal,
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
  request: ResponsesRequest,
  logger: Logger,
  responseId: string,
  store: ResponseStore | null,
): Promise<void> {
  const stopPing = startSsePing(res)
  try {
    await streamCommandCodeToResponsesInner(response, res, request, logger, responseId, store)
  } finally {
    stopPing()
  }
}

async function streamCommandCodeToResponsesInner(
  response: Response,
  res: ServerResponse,
  request: ResponsesRequest,
  logger: Logger,
  responseId: string,
  store: ResponseStore | null,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    for (const event of createResponsesStreamTranslator().finish()) writeResponsesEvent(res, event)
    return
  }

  const translator = createResponsesStreamTranslator({
    responseId,
    ...(request.model ? { model: request.model } : {}),
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
        if (store && responseEvent.type === "response.completed" && responseEvent.response) {
          store.store(responseId, {
            response: responseEvent.response,
            input: request.input,
            instructions: request.instructions,
            model: request.model,
            createdAt: responseEvent.response.created_at ?? Math.floor(Date.now() / 1000),
          })
        }
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
      if (store && responseEvent.type === "response.completed" && responseEvent.response) {
        store.store(responseId, {
          response: responseEvent.response,
          input: request.input,
          instructions: request.instructions,
          model: request.model,
          createdAt: responseEvent.response.created_at ?? Math.floor(Date.now() / 1000),
        })
      }
    }
  }
  for (const responseEvent of translator.finish()) {
    responseEventCount += 1
    responseEventTypes.push(responseEvent.type)
    writeResponsesEvent(res, responseEvent)
    if (store && responseEvent.type === "response.completed" && responseEvent.response) {
      store.store(responseId, {
        response: responseEvent.response,
        input: request.input,
        instructions: request.instructions,
        model: request.model,
        createdAt: responseEvent.response.created_at ?? Math.floor(Date.now() / 1000),
      })
    }
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
  includeUsage = false,
): Promise<void> {
  const stopPing = startSsePing(res)
  try {
    await streamCommandCodeToChatCompletionsInner(response, res, model, includeUsage)
  } finally {
    stopPing()
  }
}

async function streamCommandCodeToChatCompletionsInner(
  response: Response,
  res: ServerResponse,
  model: string | undefined,
  _includeUsage: boolean,
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

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  res.end(JSON.stringify(value))
}

function sendOpenAiError(
  res: ServerResponse,
  status: number,
  error: { message: string; type: string; code: string },
): void {
  sendJson(res, status, { error: { ...error, param: null } })
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  logger: Logger,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = await readJsonBody(req)
  if (!isRecord(request)) {
    sendAnthropicError(res, 400, {
      type: "invalid_request_error",
      message: "Request body must be a JSON object",
    })
    return
  }

  // Anthropic requires request header anthropic-version
  const anthropicVersion = req.headers["anthropic-version"] ?? "2023-06-01"

  const messagesRequest = request as AnthropicMessageRequest
  const commandCodePayload = convertAnthropicRequestToCommandCode(messagesRequest)
  const upstream = await fetchCommandCode(req, config, fetchImpl, commandCodePayload)

  if (!upstream.ok) {
    await sendUpstreamAnthropicError(upstream, res, logger)
    return
  }

  if (messagesRequest.stream !== false) {
    sendAnthropicSseHeaders(res)
    await streamCommandCodeToMessages(upstream, res, messagesRequest.model)
    res.end()
  } else {
    const commandCodeEvents = await readCommandCodeEvents(upstream)
    const response = anthropicMessagesFromCommandCodeEvents(commandCodeEvents, {
      ...(messagesRequest.model ? { model: messagesRequest.model } : {}),
    })
    res.setHeader("x-api-key", req.headers["x-api-key"] ?? "")
    sendJson(res, 200, response, { "anthropic-version": String(anthropicVersion) })
  }
}

async function streamCommandCodeToMessages(
  response: Response,
  res: ServerResponse,
  model: string | undefined,
): Promise<void> {
  const stopPing = startSsePing(res)
  try {
    await streamCommandCodeToMessagesInner(response, res, model)
  } finally {
    stopPing()
  }
}

async function streamCommandCodeToMessagesInner(
  response: Response,
  res: ServerResponse,
  model: string | undefined,
): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    const { events } = createAnthropicMessagesStreamTranslator().finish()
    for (const sseEvent of events) {
      writeAnthropicSseEvent(res, sseEvent)
    }
    return
  }

  const translator = createAnthropicMessagesStreamTranslator({
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
      for (const sseEvent of translator.push(commandCodeEvent)) {
        writeAnthropicSseEvent(res, sseEvent)
      }
    }
  }

  for (const commandCodeEvent of parseCommandCodeStreamRemainder(buffer)) {
    for (const sseEvent of translator.push(commandCodeEvent)) {
      writeAnthropicSseEvent(res, sseEvent)
    }
  }

  // Emit remaining events from finish() (message_delta, message_stop, etc.)
  const { events } = translator.finish()
  for (const sseEvent of events) {
    writeAnthropicSseEvent(res, sseEvent)
  }
}

function sendAnthropicError(
  res: ServerResponse,
  status: number,
  error: { type: string; message: string },
): void {
  sendJson(res, status, { type: "error", error }, { "anthropic-version": "2023-06-01" })
}

async function sendUpstreamAnthropicError(
  upstream: Response,
  res: ServerResponse,
  logger: Logger,
): Promise<void> {
  const body = await upstream.text().catch((error: unknown) => errorMessage(error))
  logger.warn(
    { status: upstream.status, body: body.slice(0, 500) },
    "Command Code upstream error (Messages)",
  )
  sendAnthropicError(res, upstream.status, {
    type: anthropicErrorType(upstream.status),
    message: `Command Code API error ${upstream.status}: ${body.slice(0, 500)}`,
  })
}

function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "server_error"
  return "invalid_request_error"
}

function writeAnthropicSseEvent(res: ServerResponse, event: AnthropicSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function writeSsePing(res: ServerResponse): void {
  res.write("event: ping\ndata: {}\n\n")
}

function startSsePing(res: ServerResponse): () => void {
  const interval = setInterval(() => {
    writeSsePing(res)
  }, 15_000)
  return () => clearInterval(interval)
}

function sendAnthropicSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  })
  res.flushHeaders()
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
      "Content-Type, Authorization, openai-organization, openai-project, anthropic-version, x-api-key, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version",
    "Access-Control-Max-Age": "86400",
  }
}

function apiKeyFromRequest(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth?.startsWith("Bearer ")) return auth.slice(7)
  const xApiKey = req.headers["x-api-key"]
  if (typeof xApiKey === "string") return xApiKey
  return undefined
}

function upstreamApiKey(req: IncomingMessage, config: AppConfig): string {
  if (config.authMode === "fixed" || config.authMode === "none") return config.apiKey
  return apiKeyFromRequest(req) ?? config.apiKey
}

function openAiErrorTypeForStatus(status: number): string {
  if (status === 401 || status === 403) return "authentication_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "server_error"
  return "upstream_error"
}

function handleStorageEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  store: ResponseStore | null,
): { handled: boolean } {
  // GET /v1/responses/{id}
  const getMatch = url.match(/^\/(?:v1\/)?responses\/([^/]+)$/)
  if (req.method === "GET" && getMatch) {
    const id = getMatch[1] ?? ""
    if (store) handleGetResponse(res, store, id)
    else sendStoreUnavailable(res)
    return { handled: true }
  }

  // GET /v1/responses/{id}/input_items
  const itemsMatch = url.match(/^\/(?:v1\/)?responses\/([^/]+)\/input_items$/)
  if (req.method === "GET" && itemsMatch) {
    const id = itemsMatch[1] ?? ""
    if (store) handleGetInputItems(res, store, id)
    else sendStoreUnavailable(res)
    return { handled: true }
  }

  // POST /v1/responses/{id}/cancel
  const cancelMatch = url.match(/^\/(?:v1\/)?responses\/([^/]+)\/cancel$/)
  if (req.method === "POST" && cancelMatch) {
    const id = cancelMatch[1] ?? ""
    if (store) handleCancel(res, store, id)
    else sendStoreUnavailable(res)
    return { handled: true }
  }

  // POST /v1/responses/compact
  if (req.method === "POST" && /^\/(?:v1\/)?responses\/compact$/.test(url)) {
    handleCompact(res)
    return { handled: true }
  }

  // POST /v1/responses/input_tokens
  if (req.method === "POST" && /^\/(?:v1\/)?responses\/input_tokens$/.test(url)) {
    sendJson(res, 200, { input_tokens: 0 })
    return { handled: true }
  }

  return { handled: false }
}

function handleGetResponse(res: ServerResponse, store: ResponseStore, id: string): void {
  const entry = store.get(id)
  if (!entry) {
    sendOpenAiError(res, 404, {
      message: `Response ${id} not found`,
      type: "invalid_request_error",
      code: "not_found",
    })
    return
  }
  sendJson(res, 200, entry.response)
}

function handleGetInputItems(res: ServerResponse, store: ResponseStore, id: string): void {
  const entry = store.get(id)
  if (!entry) {
    sendOpenAiError(res, 404, {
      message: `Response ${id} not found`,
      type: "invalid_request_error",
      code: "not_found",
    })
    return
  }

  const input = entry.input
  const data = Array.isArray(input) ? input : input !== undefined ? [input] : []
  sendJson(res, 200, {
    object: "list",
    data,
    first_id: data[0] ?? null,
    last_id: data[data.length - 1] ?? null,
    has_more: false,
  })
}

function handleCancel(res: ServerResponse, store: ResponseStore, id: string): void {
  const cancelled = store.cancel(id)
  if (!cancelled) {
    // When no active request is found, treat it as if cancel is accepted
    // since the response may have completed or id is wrong
  }
  const entry = store.get(id)
  if (!entry) {
    sendOpenAiError(res, 404, {
      message: `Response ${id} not found`,
      type: "invalid_request_error",
      code: "not_found",
    })
    return
  }
  sendJson(res, 200, entry.response)
}

function handleCompact(res: ServerResponse): void {
  sendJson(res, 200, {
    object: "response.compacted",
    id: idWithPrefix("comp"),
    status: "compacted",
  })
}

function sendStoreUnavailable(res: ServerResponse): void {
  sendOpenAiError(res, 501, {
    message: "Response storage is not configured for this proxy instance",
    type: "invalid_request_error",
    code: "storage_unavailable",
  })
}

function injectPreviousResponseContext(
  request: ResponsesRequest,
  store: ResponseStore | null,
): unknown {
  const prevId = request.previous_response_id
  if (!prevId || !store) return undefined

  const prev = store.get(prevId)
  if (!prev) return undefined

  const outputItems = isRecord(prev.response)
    ? Array.isArray(prev.response.output)
      ? prev.response.output
      : []
    : []
  if (outputItems.length === 0) return undefined

  const existingInput = Array.isArray(request.input)
    ? request.input
    : request.input !== undefined
      ? [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: String(request.input) }],
          },
        ]
      : []
  return [...existingInput, ...outputItems]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
