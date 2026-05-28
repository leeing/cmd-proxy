import process from "node:process"

import { resolveModel } from "./models.ts"
import type {
  CommandCodeContent,
  CommandCodeMessage,
  CommandCodeParams,
  CommandCodePayload,
  CommandCodeStreamEvent,
  CommandCodeTool,
} from "./types.ts"
import {
  getEnvironmentInfo,
  getGitContext,
  idWithPrefix,
  isRecord,
  numberValue,
  recordOrEmpty,
  stringValue,
  toObjectJsonSchema,
} from "./utils.ts"

// --- Anthropic Messages API types ---

export interface AnthropicCacheControl {
  type: "ephemeral"
}

export interface AnthropicThinkingConfig {
  type: "enabled"
  budget_tokens: number
}

export interface AnthropicOutputConfig {
  type: "thinking" | "text" | "assistant_message" | "json_object"
  thinking?: {
    type: "enabled"
    budget_tokens: number
  }
}

export interface AnthropicContextManagement {
  edits?: Array<{
    type: string
    trigger?: { type: string; value: number }
    keep?: { type: string; value: number }
  }>
}

class AnthropicRequestError extends Error {
  readonly status: number
  readonly type: string

  constructor(message: string, options: { status?: number; type?: string } = {}) {
    super(message)
    this.name = "AnthropicRequestError"
    this.status = options.status ?? 400
    this.type = options.type ?? "invalid_request_error"
  }
}

export interface AnthropicMessageRequest {
  model?: string
  system?: string | (AnthropicTextBlock & { cache_control?: AnthropicCacheControl })[]
  messages?: AnthropicMessage[]
  tools?: AnthropicTool[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tool_choice?: AnthropicToolChoice
  metadata?: Record<string, unknown>
  thinking?: AnthropicThinkingConfig
  service_tier?: string
  container?: unknown
  mcp_servers?: unknown
  context_management?: AnthropicContextManagement
  output_config?: AnthropicOutputConfig
}

export type AnthropicMessage =
  | {
      role: "user"
      content: string | AnthropicContentBlock[]
    }
  | {
      role: "assistant"
      content: string | AnthropicContentBlock[]
    }

export type AnthropicContentBlock =
  | ({ type: "text"; text: string } & { cache_control?: AnthropicCacheControl })
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result"
      tool_use_id: string
      content: string | AnthropicTextBlock[]
      is_error?: boolean
      cache_control?: AnthropicCacheControl
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "document"; title?: string; source: AnthropicDocumentSource }

export interface AnthropicDocumentSource {
  type: "text" | "base64" | "url"
  media_type?: string
  data?: string
  url?: string
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageSource {
  type: "base64" | "url"
  media_type?: string
  data?: string
  url?: string
}

export interface AnthropicTool {
  type?: string
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  cache_control?: AnthropicCacheControl
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" }

// Non-streaming response

export interface AnthropicMessageResponse {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicResponseContentBlock[]
  model: string
  stop_reason: AnthropicStopReason
  stop_sequence: string | null
  usage: AnthropicUsage
}

export interface AnthropicTokenCountResponse {
  input_tokens: number
}

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "thinking"; thinking: string; signature: string }

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: Record<string, unknown>
  service_tier?: string
  inference_geo?: string
  server_tool_use?: Record<string, unknown>
}

// SSE events

export interface AnthropicSseEvent {
  type: string
  error?: { type: string; message: string }
  message?: AnthropicSseMessage
  index?: number
  content_block?: AnthropicResponseContentBlock
  delta?: AnthropicSseDelta | { stop_reason: string | null; stop_sequence: string | null }
  usage?: Partial<AnthropicUsage>
}

interface AnthropicSseMessage {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicResponseContentBlock[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded"
  | null

type AnthropicSseDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

// --- Constants ---

const DEFAULT_MODEL = "deepseek-v4-pro"
const DEFAULT_MAX_TOKENS = 4_096
const MAX_TOKENS = 200_000

const SYSTEM_PROMPT = ""

// --- Request Conversion ---

export function convertAnthropicRequestToCommandCode(
  request: AnthropicMessageRequest,
  options: {
    cwd?: string
    now?: Date
    memory?: string
    taste?: string
    betaHeaders?: string[]
    onWarning?: (warning: string) => void
  } = {},
): CommandCodePayload {
  validateAnthropicRequest(request, options.betaHeaders ?? [], {
    requireMaxTokens: true,
    onWarning: options.onWarning,
  })
  const systemParts: string[] = []

  // Handle system prompt
  const system = normalizeSystem(request.system)
  if (system) systemParts.push(system)

  // Convert messages
  const messages: CommandCodeMessage[] = []
  const toolNamesByCallId = new Map<string, string>()

  for (const message of request.messages ?? []) {
    appendAnthropicMessage(message, messages, toolNamesByCallId, options.onWarning)
  }

  const params: CommandCodeParams = {
    model: resolveModel(request.model ?? DEFAULT_MODEL),
    messages,
    tools: convertAnthropicTools(request.tools, options.onWarning),
    system: systemParts.join("\n\n"),
    max_tokens: Math.min(request.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS),
    stream: true,
  }

  if (typeof request.temperature === "number") params.temperature = Math.min(request.temperature, 1)
  if (typeof request.top_p === "number") params.top_p = request.top_p
  if (typeof request.top_k === "number") params.top_k = request.top_k
  if (isRecord(request.metadata)) params.metadata = request.metadata
  if (typeof request.service_tier === "string") params.service_tier = request.service_tier
  if (request.stop_sequences && request.stop_sequences.length > 0) {
    params.stop = request.stop_sequences
  }

  // Map Anthropic tool_choice to Command Code tool_choice
  if (request.tool_choice) {
    params.tool_choice = mapToolChoice(request.tool_choice)
  }

  // Map Anthropic thinking config (output_config takes priority)
  if (request.output_config?.type === "thinking" && request.output_config.thinking) {
    params.thinking = {
      type: "enabled",
      budget_tokens: request.output_config.thinking.budget_tokens,
    }
  } else if (request.thinking) {
    params.thinking = {
      type: "enabled",
      budget_tokens: request.thinking.budget_tokens,
    }
  }

  // Map Anthropic context management
  if (request.context_management) {
    params.context_management = request.context_management
  }

  const now = options.now ?? new Date()
  const git = getGitContext()
  return {
    config: {
      workingDir: options.cwd ?? process.cwd(),
      date: now.toISOString().split("T")[0] ?? now.toISOString(),
      environment: getEnvironmentInfo(),
      structure: [],
      isGitRepo: git.isGitRepo,
      currentBranch: git.currentBranch,
      mainBranch: git.mainBranch,
      gitStatus: git.gitStatus,
      recentCommits: git.recentCommits,
    },
    memory: options.memory ?? "",
    taste: options.taste ?? "",
    skills: null,
    permissionMode: "standard",
    params,
  }
}

export function countAnthropicInputTokens(
  request: AnthropicMessageRequest,
  options: { betaHeaders?: string[]; onWarning?: (warning: string) => void } = {},
): AnthropicTokenCountResponse {
  validateAnthropicRequest(request, options.betaHeaders ?? [], {
    requireMaxTokens: false,
    onWarning: options.onWarning,
  })

  let tokenCount = 0
  tokenCount += estimateTextTokens(normalizeSystem(request.system))
  tokenCount += estimateTextTokens(request.model ?? "")
  tokenCount += estimateJsonTokens(request.tools ?? [])
  tokenCount += estimateJsonTokens(request.tool_choice ?? {})
  tokenCount += estimateJsonTokens(request.thinking ?? {})

  for (const message of request.messages ?? []) {
    tokenCount += 4
    tokenCount += estimateTextTokens(message.role)
    for (const block of normalizeContent(message.content)) {
      tokenCount += estimateContentBlockTokens(block)
    }
  }

  return { input_tokens: Math.max(1, Math.ceil(tokenCount)) }
}

function normalizeSystem(system: string | AnthropicTextBlock[] | undefined): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }
  return SYSTEM_PROMPT
}

function appendAnthropicMessage(
  message: AnthropicMessage,
  messages: CommandCodeMessage[],
  toolNamesByCallId: Map<string, string>,
  onWarning?: (warning: string) => void,
): void {
  const contentBlocks = normalizeContent(message.content)

  if (message.role === "user") {
    const textParts: CommandCodeContent[] = []

    for (const block of contentBlocks) {
      if (block.type === "text") {
        const textContent: CommandCodeContent = { type: "text", text: block.text }
        if (block.cache_control) textContent.cache_control = block.cache_control
        textParts.push(textContent)
      } else if (block.type === "image") {
        const image = commandCodeImageContent(block.source)
        if (image) textParts.push(image)
      } else if (block.type === "document") {
        const documentText = documentTextContent(block, onWarning)
        if (documentText) textParts.push(documentText)
      } else if (block.type === "tool_result") {
        // Anthropic puts tool_result in user messages, but Command Code
        // requires them in separate role="tool" messages.
        const result: Extract<CommandCodeContent, { type: "tool-result" }> = {
          type: "tool-result",
          toolCallId: block.tool_use_id,
          toolName: toolNamesByCallId.get(block.tool_use_id) ?? "",
          output: {
            type: block.is_error ? "error-text" : "text",
            value: normalizeToolResultContent(block.content),
          },
        }
        if (block.cache_control) result.cache_control = block.cache_control
        messages.push({ role: "tool", content: [result] })
      } else {
        warnUnsupportedContentBlock(block, onWarning)
      }
    }

    if (textParts.length > 0) messages.push({ role: "user", content: textParts })
    return
  }

  if (message.role === "assistant") {
    const parts: CommandCodeContent[] = []

    for (const block of contentBlocks) {
      if (block.type === "text") {
        parts.push({ type: "text", text: block.text })
      } else if (block.type === "tool_use") {
        toolNamesByCallId.set(block.id, block.name)
        parts.push({
          type: "tool-call",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        })
      } else if (block.type === "thinking") {
        parts.push({ type: "reasoning", text: block.thinking, signature: block.signature })
      } else {
        warnUnsupportedContentBlock(block, onWarning)
      }
    }

    if (parts.length > 0) messages.push({ role: "assistant", content: parts })
  }
}

function normalizeContent(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return content
}

function normalizeToolResultContent(content: string | AnthropicTextBlock[]): string {
  if (typeof content === "string") return content
  return content.map((block) => block.text).join("\n")
}

function validateAnthropicRequest(
  request: AnthropicMessageRequest,
  betaHeaders: string[],
  options: { requireMaxTokens: boolean; onWarning?: ((warning: string) => void) | undefined },
): void {
  if (options.requireMaxTokens && typeof request.max_tokens !== "number") {
    throw new AnthropicRequestError("max_tokens is required")
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new AnthropicRequestError("messages must contain at least one message")
  }
  const firstMessage = request.messages[0]
  if (firstMessage?.role !== "user") {
    throw new AnthropicRequestError("messages: first message must use the user role")
  }
  for (let i = 1; i < request.messages.length; i += 1) {
    if (request.messages[i]?.role === request.messages[i - 1]?.role) {
      throw new AnthropicRequestError("messages: roles must alternate between user and assistant")
    }
  }
  warnAboutUnsupportedAnthropicRequest(request, betaHeaders, options.onWarning)
}

function warnAboutUnsupportedAnthropicRequest(
  request: AnthropicMessageRequest,
  betaHeaders: string[],
  onWarning?: (warning: string) => void,
): void {
  warnMissingBetaForField(request, betaHeaders, onWarning, "mcp_servers", [
    "mcp-client-2025-11-20",
    "mcp-client-2025-04-04",
  ])
  warnMissingBetaForField(request, betaHeaders, onWarning, "context_management", [
    "context-management-2025-06-27",
  ])

  for (const field of ["container", "mcp_servers"] as const) {
    if (request[field] !== undefined) {
      warn(`Ignored unsupported Anthropic request field: ${field}`, onWarning)
    }
  }
}

function warnMissingBetaForField(
  request: AnthropicMessageRequest,
  betaHeaders: string[],
  onWarning: ((warning: string) => void) | undefined,
  field: keyof AnthropicMessageRequest,
  allowedBetas: string[],
): void {
  if (request[field] === undefined) return
  if (allowedBetas.some((beta) => betaHeaders.includes(beta))) return
  warn(
    `Ignored Anthropic request field ${field} because it requires anthropic-beta: ${allowedBetas[0]}`,
    onWarning,
  )
}

function warnUnsupportedContentBlock(
  block: unknown,
  onWarning: ((warning: string) => void) | undefined,
): void {
  const type = isRecord(block) ? stringValue(block.type) : undefined
  warn(`Ignored unsupported Anthropic content block type: ${type ?? "unknown"}`, onWarning)
}

function warn(message: string, onWarning: ((warning: string) => void) | undefined): void {
  onWarning?.(message)
}

function estimateContentBlockTokens(block: AnthropicContentBlock): number {
  if (block.type === "text") return estimateTextTokens(block.text)
  if (block.type === "tool_use")
    return estimateTextTokens(block.name) + estimateJsonTokens(block.input)
  if (block.type === "tool_result") return estimateToolResultTokens(block)
  if (block.type === "image") return 256
  if (block.type === "document") return estimateDocumentTokens(block)
  if (block.type === "thinking") return estimateTextTokens(block.thinking)
  return 1
}

function estimateToolResultTokens(
  block: Extract<AnthropicContentBlock, { type: "tool_result" }>,
): number {
  const content = block.content
  if (typeof content === "string") return estimateTextTokens(content)
  return content.reduce((sum, item) => sum + estimateTextTokens(item.text), 0)
}

function estimateDocumentTokens(
  block: Extract<AnthropicContentBlock, { type: "document" }>,
): number {
  if (block.source.type === "text") {
    return estimateTextTokens(block.title ?? "") + estimateTextTokens(block.source.data ?? "")
  }
  return 512
}

function estimateJsonTokens(value: unknown): number {
  const text = JSON.stringify(value ?? "")
  return estimateTextTokens(text)
}

function estimateTextTokens(text: string): number {
  const normalized = text.trim()
  if (!normalized) return 0
  const asciiWords = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0
  let nonAsciiChars = 0
  let punctuation = 0
  for (const char of normalized) {
    if (/\s/.test(char)) continue
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint > 127) {
      nonAsciiChars += 1
    } else if (!/[A-Za-z0-9_]/.test(char)) {
      punctuation += 1
    }
  }
  const charEstimate = normalized.length / 4
  return Math.max(charEstimate, asciiWords + nonAsciiChars + punctuation * 0.25)
}

function convertAnthropicTools(
  tools: AnthropicTool[] | undefined,
  onWarning?: (warning: string) => void,
): CommandCodeTool[] {
  if (!tools || !Array.isArray(tools)) return []
  const converted: CommandCodeTool[] = []

  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const type = stringValue(tool.type)
    if (type && type !== "custom") {
      const builtinSchema = getBuiltinToolSchema(type, tool)
      if (!builtinSchema) {
        warn(`Ignored unsupported Anthropic tool type: ${type}`, onWarning)
        continue
      }
      const commandCodeTool: CommandCodeTool = {
        type: "function",
        name: builtinSchema.name,
        input_schema: builtinSchema.input_schema,
        description: builtinSchema.description,
      }
      if (tool.cache_control) commandCodeTool.cache_control = tool.cache_control
      converted.push(commandCodeTool)
      continue
    }
    const name = stringValue(tool.name)
    if (!name) continue
    const commandCodeTool: CommandCodeTool = {
      type: "function",
      name,
      input_schema: normalizeToolSchema(
        name,
        tool.input_schema ?? { type: "object", properties: {} },
      ),
    }
    if (tool.cache_control) commandCodeTool.cache_control = tool.cache_control
    const description = applyPatchDescription(name) ?? stringValue(tool.description)
    if (description) commandCodeTool.description = description
    converted.push(commandCodeTool)
  }

  return converted
}

function getBuiltinToolSchema(
  type: string,
  _tool: AnthropicTool,
): { name: string; input_schema: Record<string, unknown>; description: string } | undefined {
  if (type === "web_search_20250305") {
    return {
      name: "web_search",
      description: "Search the web for current information.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    }
  }
  if (type === "text_editor_20250124") {
    return {
      name: "text_editor",
      description: "View or edit a file in the workspace.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["view", "create", "str_replace", "insert", "undo_edit"],
          },
          path: { type: "string" },
          file_text: { type: "string" },
          insert_line: { type: "number" },
          new_str: { type: "string" },
          old_str: { type: "string" },
          view_range: { type: "array", items: { type: "number" } },
        },
        required: ["command", "path"],
      },
    }
  }
  if (type === "computer_20250124") {
    return {
      name: "computer",
      description: "Interact with a computer desktop through mouse and keyboard actions.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "key",
              "type",
              "mouse_move",
              "left_click",
              "left_click_drag",
              "right_click",
              "middle_click",
              "double_click",
              "screenshot",
              "cursor_position",
            ],
          },
          coordinate: { type: "array", items: { type: "number" } },
          text: { type: "string" },
        },
        required: ["action"],
      },
    }
  }
  return undefined
}

export function isAnthropicRequestError(error: unknown): error is AnthropicRequestError {
  return error instanceof AnthropicRequestError
}

function commandCodeImageContent(
  source: AnthropicImageSource,
): Extract<CommandCodeContent, { type: "image" }> | undefined {
  if (source.type === "url") {
    const url = stringValue(source.url)
    return url ? { type: "image", source: { type: "url", url } } : undefined
  }
  const mediaType = stringValue(source.media_type)
  const data = stringValue(source.data)
  if (!mediaType || !data) return undefined
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  }
}

function documentTextContent(
  block: Extract<AnthropicContentBlock, { type: "document" }>,
  onWarning?: (warning: string) => void,
): Extract<CommandCodeContent, { type: "text" }> | undefined {
  if (block.source.type !== "text") {
    warn(`Ignored unsupported Anthropic document source type: ${block.source.type}`, onWarning)
    return undefined
  }
  const data = stringValue(block.source.data) ?? ""
  const title = stringValue(block.title)
  return {
    type: "text",
    text: title ? `Document: ${title}\n\n${data}` : data,
  }
}

function normalizeToolSchema(
  name: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "apply_patch") {
    return {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description:
            "A unified diff patch to apply. Use standard unified diff format with ---/+++ file headers and @@ hunk markers with context lines. Lines starting with space are context, + are additions, - are deletions.",
        },
      },
      required: ["patch"],
    } as Record<string, unknown>
  }
  return toObjectJsonSchema(schema)
}

function applyPatchDescription(name: string): string | undefined {
  if (name !== "apply_patch") return undefined
  return [
    "Apply a unified diff patch to edit files.",
    "Use standard unified diff format: --- a/file, +++ b/file headers,",
    "@@ -start,count +start,count @@ hunk markers with 3 lines of context.",
    "Lines: space-prefixed = context, +prefixed = addition, -prefixed = deletion.",
    "Example: --- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n context\n+new line\n context",
  ].join(" ")
}

function mapToolChoice(toolChoice: AnthropicToolChoice): unknown {
  switch (toolChoice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      return { type: "function", function: { name: toolChoice.name } }
    default:
      return undefined
  }
}

// --- Non-streaming Event Conversion ---

export function anthropicMessagesFromCommandCodeEvents(
  commandCodeEvents: CommandCodeStreamEvent[],
  options: { messageId?: string; model?: string } = {},
): AnthropicMessageResponse {
  const translator = createAnthropicMessagesStreamTranslator(options)
  for (const event of commandCodeEvents) {
    translator.push(event)
  }
  return translator.finish().response
}

// --- Streaming Translator ---

export interface AnthropicMessagesStreamTranslator {
  push(event: CommandCodeStreamEvent): AnthropicSseEvent[]
  finish(): { events: AnthropicSseEvent[]; response: AnthropicMessageResponse }
}

export function createAnthropicMessagesStreamTranslator(
  options: { messageId?: string; model?: string } = {},
): AnthropicMessagesStreamTranslator {
  const state = createAnthropicState(options)

  return {
    push(event): AnthropicSseEvent[] {
      const start = state.events.length
      handleAnthropicEvent(state, event)
      return state.events.slice(start)
    },
    finish() {
      const start = state.events.length
      const response = buildFinalResponse(state)
      return { events: state.events.slice(start), response }
    },
  }
}

interface AnthropicState {
  events: AnthropicSseEvent[]
  messageId: string
  model: string
  contentBlocks: AnthropicResponseContentBlock[]
  currentBlockIndex: number
  currentTextBlock: { type: "text"; text: string } | null
  currentToolUseBlock: {
    type: "tool_use"
    id: string
    name: string
    input: Record<string, unknown>
  } | null
  currentToolInputJson: string
  currentThinkingBlock: { type: "thinking"; thinking: string; signature: string } | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  cacheCreation: Record<string, unknown> | undefined
  serviceTier: string | undefined
  inferenceGeo: string | undefined
  serverToolUse: Record<string, unknown> | undefined
  stopReason: AnthropicStopReason
  stopSequence: string | null
  sentStart: boolean
  finished: boolean
}

function createAnthropicState(options: { messageId?: string; model?: string }): AnthropicState {
  return {
    events: [],
    messageId: options.messageId ?? idWithPrefix("msg"),
    model: options.model ?? DEFAULT_MODEL,
    contentBlocks: [],
    currentBlockIndex: 0,
    currentTextBlock: null,
    currentToolUseBlock: null,
    currentToolInputJson: "",
    currentThinkingBlock: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreation: undefined,
    serviceTier: undefined,
    inferenceGeo: undefined,
    serverToolUse: undefined,
    stopReason: null,
    stopSequence: null,
    sentStart: false,
    finished: false,
  }
}

function handleAnthropicEvent(state: AnthropicState, event: CommandCodeStreamEvent): void {
  const type = stringValue(event.type)
  if (!type) return

  if (type === "error") {
    state.events.push({ type: "error", error: anthropicStreamError(event) })
    return
  }

  if (type === "ping") {
    state.events.push({ type: "ping" })
    return
  }

  if (type === "usage-start" || type === "usage") {
    updateUsageFromEvent(state, event)
    return
  }

  if (type === "reasoning-delta") {
    ensureStart(state)
    ensureThinkingBlock(state)
    const delta = stringValue(event.text) ?? ""
    if (state.currentThinkingBlock) {
      state.currentThinkingBlock.thinking += delta
    }
    state.events.push({
      type: "content_block_delta",
      index: state.currentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta },
    })
    return
  }

  if (type === "reasoning-end") {
    ensureStart(state)
    const signature = stringValue(event.signature)
    if (signature && state.currentThinkingBlock) {
      state.currentThinkingBlock.signature = signature
      state.events.push({
        type: "content_block_delta",
        index: state.currentBlockIndex,
        delta: { type: "signature_delta", signature },
      })
    }
    if (state.currentThinkingBlock) {
      state.contentBlocks.push(state.currentThinkingBlock)
      state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
      state.currentBlockIndex += 1
      state.currentThinkingBlock = null
    }
    return
  }

  if (type === "reasoning-signature-delta") {
    ensureStart(state)
    ensureThinkingBlock(state)
    const signature = stringValue(event.signature) ?? ""
    if (state.currentThinkingBlock) state.currentThinkingBlock.signature += signature
    state.events.push({
      type: "content_block_delta",
      index: state.currentBlockIndex,
      delta: { type: "signature_delta", signature },
    })
    return
  }

  if (type === "text-delta") {
    ensureStart(state)
    ensureTextBlock(state)
    const delta = stringValue(event.text) ?? ""
    if (state.currentTextBlock) {
      state.currentTextBlock.text += delta
    }
    state.events.push({
      type: "content_block_delta",
      index: state.currentBlockIndex,
      delta: { type: "text_delta", text: delta },
    })
    return
  }

  if (type === "text-end") {
    ensureStart(state)
    if (state.currentTextBlock) {
      state.contentBlocks.push(state.currentTextBlock)
      state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
      state.currentBlockIndex += 1
      state.currentTextBlock = null
    }
    return
  }

  if (type === "tool-input-start") {
    ensureStart(state)
    closeTextBlock(state)
    closeThinkingBlock(state)
    startToolUseBlock(state, event)
    return
  }

  if (type === "tool-input-delta") {
    ensureStart(state)
    if (state.currentToolUseBlock) {
      const rawDelta = stringValue(event.delta) ?? ""
      state.currentToolInputJson += rawDelta
      state.events.push({
        type: "content_block_delta",
        index: state.currentBlockIndex,
        delta: { type: "input_json_delta", partial_json: rawDelta },
      })
    }
    return
  }

  if (type === "tool-input-end") {
    ensureStart(state)
    if (state.currentToolUseBlock) {
      const id = stringValue(event.id) ?? stringValue(event.toolCallId)
      if (id) state.currentToolUseBlock.id = id
      state.currentToolUseBlock.input = recordOrEmpty(state.currentToolInputJson)
      state.contentBlocks.push(state.currentToolUseBlock)
      state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
      state.currentBlockIndex += 1
      state.currentToolUseBlock = null
      state.currentToolInputJson = ""
    }
    return
  }

  if (type === "tool-call") {
    // Complete tool call event (non-streamed)
    ensureStart(state)
    closeTextBlock(state)
    closeToolUseBlock(state)
    closeThinkingBlock(state)

    const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? idWithPrefix("toolu")
    const name = stringValue(event.toolName) ?? ""
    const input = isRecord(event.input) ? event.input : recordOrEmpty(event.input)

    const block: AnthropicResponseContentBlock = {
      type: "tool_use",
      id,
      name,
      input,
    }
    state.contentBlocks.push(block)
    state.currentBlockIndex += 1
    return
  }

  if (type === "finish") {
    ensureStart(state)
    closeTextBlock(state)
    closeToolUseBlock(state)
    closeThinkingBlock(state)

    updateUsageFromEvent(state, event)

    state.stopReason = mapAnthropicStopReason(event.finishReason)
    state.stopSequence = stringValue(event.stop_reason) ?? null

    state.events.push({
      type: "message_delta",
      delta: { stop_reason: state.stopReason, stop_sequence: state.stopSequence },
      usage: { output_tokens: state.outputTokens },
    })
    state.events.push({ type: "message_stop" })
    state.finished = true
    return
  }
}

function ensureStart(state: AnthropicState): void {
  if (state.sentStart) return
  state.events.push({
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: buildAnthropicUsage(state),
    },
  })
  state.sentStart = true
}

function ensureTextBlock(state: AnthropicState): void {
  if (state.currentTextBlock) return
  closeToolUseBlock(state)
  closeThinkingBlock(state)
  state.currentTextBlock = { type: "text", text: "" }
  state.events.push({
    type: "content_block_start",
    index: state.currentBlockIndex,
    content_block: { type: "text", text: "" },
  })
}

function ensureThinkingBlock(state: AnthropicState): void {
  if (state.currentThinkingBlock) return
  closeTextBlock(state)
  closeToolUseBlock(state)
  state.currentThinkingBlock = { type: "thinking", thinking: "", signature: "" }
  state.events.push({
    type: "content_block_start",
    index: state.currentBlockIndex,
    content_block: { type: "thinking", thinking: "", signature: "" },
  })
}

function closeTextBlock(state: AnthropicState): void {
  if (!state.currentTextBlock) return
  state.contentBlocks.push(state.currentTextBlock)
  state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
  state.currentBlockIndex += 1
  state.currentTextBlock = null
}

function closeThinkingBlock(state: AnthropicState): void {
  if (!state.currentThinkingBlock) return
  state.contentBlocks.push(state.currentThinkingBlock)
  state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
  state.currentBlockIndex += 1
  state.currentThinkingBlock = null
}

function closeToolUseBlock(state: AnthropicState): void {
  if (!state.currentToolUseBlock) return
  state.currentToolUseBlock.input = recordOrEmpty(state.currentToolInputJson)
  state.contentBlocks.push(state.currentToolUseBlock)
  state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
  state.currentBlockIndex += 1
  state.currentToolUseBlock = null
  state.currentToolInputJson = ""
}

function startToolUseBlock(state: AnthropicState, event: CommandCodeStreamEvent): void {
  const id = stringValue(event.id) ?? stringValue(event.toolCallId) ?? idWithPrefix("toolu")
  const name = stringValue(event.toolName) ?? ""

  state.currentToolUseBlock = {
    type: "tool_use",
    id,
    name,
    input: {},
  }
  state.currentToolInputJson = ""

  state.events.push({
    type: "content_block_start",
    index: state.currentBlockIndex,
    content_block: { type: "tool_use", id, name, input: {} },
  })
}

function mapAnthropicStopReason(reason: unknown): AnthropicStopReason {
  if (reason === "tool-calls" || reason === "tool_use") return "tool_use"
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens") return "max_tokens"
  if (reason === "stop_sequence" || reason === "stop-sequence") return "stop_sequence"
  if (reason === "stop" || reason === "end_turn") return "end_turn"
  if (
    reason === "pause_turn" ||
    reason === "refusal" ||
    reason === "model_context_window_exceeded"
  ) {
    return reason
  }
  return null
}

function updateUsageFromEvent(state: AnthropicState, event: CommandCodeStreamEvent): void {
  const usage = isRecord(event.totalUsage)
    ? event.totalUsage
    : isRecord(event.usage)
      ? event.usage
      : event
  state.inputTokens =
    numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? state.inputTokens
  state.outputTokens =
    numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? state.outputTokens
  const cacheDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {}
  state.cacheCreationInputTokens =
    numberValue(cacheDetails.cacheCreationTokens) ??
    numberValue(usage.cache_creation_input_tokens) ??
    state.cacheCreationInputTokens
  state.cacheReadInputTokens =
    numberValue(cacheDetails.cacheReadTokens) ??
    numberValue(usage.cache_read_input_tokens) ??
    state.cacheReadInputTokens
  state.cacheCreation = isRecord(usage.cacheCreation)
    ? usage.cacheCreation
    : isRecord(usage.cache_creation)
      ? usage.cache_creation
      : state.cacheCreation
  state.serviceTier =
    stringValue(usage.serviceTier) ?? stringValue(usage.service_tier) ?? state.serviceTier
  state.inferenceGeo =
    stringValue(usage.inferenceGeo) ?? stringValue(usage.inference_geo) ?? state.inferenceGeo
  state.serverToolUse = isRecord(usage.serverToolUse)
    ? usage.serverToolUse
    : isRecord(usage.server_tool_use)
      ? usage.server_tool_use
      : state.serverToolUse
}

function anthropicStreamError(event: CommandCodeStreamEvent): { type: string; message: string } {
  const error = isRecord(event.error) ? event.error : event
  return {
    type: stringValue(error.type) ?? "server_error",
    message: stringValue(error.message) ?? "Upstream stream error",
  }
}

function buildAnthropicUsage(state: AnthropicState): AnthropicUsage {
  const usage: AnthropicUsage = {
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
  }
  if (state.cacheCreationInputTokens > 0) {
    usage.cache_creation_input_tokens = state.cacheCreationInputTokens
  }
  if (state.cacheReadInputTokens > 0) {
    usage.cache_read_input_tokens = state.cacheReadInputTokens
  }
  if (state.cacheCreation) usage.cache_creation = state.cacheCreation
  if (state.serviceTier) usage.service_tier = state.serviceTier
  if (state.inferenceGeo) usage.inference_geo = state.inferenceGeo
  if (state.serverToolUse) usage.server_tool_use = state.serverToolUse
  return usage
}

function buildFinalResponse(state: AnthropicState): AnthropicMessageResponse {
  // Close any open blocks
  if (!state.finished) {
    closeTextBlock(state)
    closeToolUseBlock(state)
    closeThinkingBlock(state)

    if (state.stopReason === null) {
      state.stopReason = "end_turn"
    }

    state.events.push({
      type: "message_delta",
      delta: { stop_reason: state.stopReason, stop_sequence: state.stopSequence },
      usage: { output_tokens: state.outputTokens },
    })
    state.events.push({ type: "message_stop" })
    state.finished = true
  }

  return {
    id: state.messageId,
    type: "message",
    role: "assistant",
    content: state.contentBlocks,
    model: state.model,
    stop_reason: state.stopReason,
    stop_sequence: state.stopSequence,
    usage: buildAnthropicUsage(state),
  }
}
