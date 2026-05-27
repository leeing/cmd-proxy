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

export interface AnthropicMessageRequest {
  model?: string
  system?: string | (AnthropicTextBlock & { cache_control?: AnthropicCacheControl })[]
  messages?: AnthropicMessage[]
  tools?: AnthropicTool[]
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  tool_choice?: AnthropicToolChoice
  metadata?: Record<string, unknown>
  thinking?: AnthropicThinkingConfig
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
  | { type: "image"; source: AnthropicImageSource }

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageSource {
  type: "base64"
  media_type: string
  data: string
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
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
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null
  stop_sequence: string | null
  usage: AnthropicUsage
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
}

// SSE events

export interface AnthropicSseEvent {
  type: string
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

type AnthropicSseDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }

// --- Constants ---

const DEFAULT_MODEL = "deepseek-v4-pro"
const DEFAULT_MAX_TOKENS = 4_096
const MAX_TOKENS = 200_000

const SYSTEM_PROMPT = ""

// --- Request Conversion ---

export function convertAnthropicRequestToCommandCode(
  request: AnthropicMessageRequest,
  options: { cwd?: string; now?: Date; memory?: string; taste?: string } = {},
): CommandCodePayload {
  const systemParts: string[] = []

  // Handle system prompt
  const system = normalizeSystem(request.system)
  if (system) systemParts.push(system)

  // Convert messages
  const messages: CommandCodeMessage[] = []
  const toolNamesByCallId = new Map<string, string>()

  for (const message of request.messages ?? []) {
    appendAnthropicMessage(message, messages, toolNamesByCallId)
  }

  const params: CommandCodeParams = {
    model: resolveModel(request.model ?? DEFAULT_MODEL),
    messages,
    tools: convertAnthropicTools(request.tools),
    system: systemParts.join("\n\n"),
    max_tokens: Math.min(request.max_tokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS),
    stream: true,
  }

  if (typeof request.temperature === "number") params.temperature = request.temperature
  if (typeof request.top_p === "number") params.top_p = request.top_p
  if (request.stop_sequences && request.stop_sequences.length > 0) {
    params.stop = request.stop_sequences
  }

  // Map Anthropic tool_choice to Command Code tool_choice
  if (request.tool_choice) {
    params.tool_choice = mapToolChoice(request.tool_choice)
  }

  // Map Anthropic thinking config
  if (request.thinking) {
    params.thinking = {
      type: "enabled",
      budget_tokens: request.thinking.budget_tokens,
    }
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
        textParts.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.source.media_type,
            data: block.source.data,
          },
        })
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

function convertAnthropicTools(tools: AnthropicTool[] | undefined): CommandCodeTool[] {
  if (!tools || !Array.isArray(tools)) return []
  const converted: CommandCodeTool[] = []

  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const name = stringValue(tool.name)
    if (!name) continue
    const commandCodeTool: CommandCodeTool = {
      type: "function",
      name,
      input_schema: normalizeToolSchema(name, tool.input_schema),
    }
    if (tool.cache_control) commandCodeTool.cache_control = tool.cache_control
    const description = applyPatchDescription(name) ?? stringValue(tool.description)
    if (description) commandCodeTool.description = description
    converted.push(commandCodeTool)
  }

  return converted
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
  currentThinkingBlock: { type: "thinking"; thinking: string; signature: string } | null
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null
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
    currentThinkingBlock: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    stopReason: null,
    stopSequence: null,
    sentStart: false,
    finished: false,
  }
}

function handleAnthropicEvent(state: AnthropicState, event: CommandCodeStreamEvent): void {
  const type = stringValue(event.type)
  if (!type) return

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
    if (state.currentThinkingBlock) {
      state.contentBlocks.push(state.currentThinkingBlock)
      state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
      state.currentBlockIndex += 1
      state.currentThinkingBlock = null
    }
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
      // Try to parse accumulated input
      const id = stringValue(event.id) ?? stringValue(event.toolCallId)
      if (id) state.currentToolUseBlock.id = id
      state.contentBlocks.push(state.currentToolUseBlock)
      state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
      state.currentBlockIndex += 1
      state.currentToolUseBlock = null
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

    const usage = isRecord(event.totalUsage) ? event.totalUsage : {}
    state.inputTokens = numberValue(usage.inputTokens) ?? 0
    state.outputTokens = numberValue(usage.outputTokens) ?? 0
    const cacheDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {}
    state.cacheCreationInputTokens = numberValue(cacheDetails.cacheCreationTokens) ?? 0
    state.cacheReadInputTokens = numberValue(cacheDetails.cacheReadTokens) ?? 0

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
      usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
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
  state.contentBlocks.push(state.currentToolUseBlock)
  state.events.push({ type: "content_block_stop", index: state.currentBlockIndex })
  state.currentBlockIndex += 1
  state.currentToolUseBlock = null
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

  state.events.push({
    type: "content_block_start",
    index: state.currentBlockIndex,
    content_block: { type: "tool_use", id, name, input: {} },
  })
}

function mapAnthropicStopReason(
  reason: unknown,
): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null {
  if (reason === "tool-calls" || reason === "tool_use") return "tool_use"
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens") return "max_tokens"
  if (reason === "stop_sequence" || reason === "stop-sequence") return "stop_sequence"
  if (reason === "stop" || reason === "end_turn") return "end_turn"
  return null
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
