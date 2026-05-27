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
  imageContentFromDataUrl,
  isRecord,
  numberValue,
  recordOrEmpty,
  stringValue,
  toObjectJsonSchema,
} from "./utils.ts"

const DEFAULT_MODEL = "deepseek-v4-pro"
const DEFAULT_MAX_TOKENS = 32_000
const MAX_TOKENS = 200_000

export interface ChatCompletionRequest {
  model?: string
  messages?: ChatMessage[]
  tools?: unknown
  max_tokens?: number
  max_completion_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  frequency_penalty?: number
  presence_penalty?: number
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown }
  stream_options?: { include_usage?: boolean }
  seed?: number
}

type ChatMessage =
  | { role: "developer"; content?: unknown }
  | { role: "system"; content?: unknown }
  | { role: "user"; content?: unknown }
  | { role: "assistant"; content?: unknown; tool_calls?: unknown }
  | { role: "tool"; content?: unknown; tool_call_id?: string; name?: string }

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: 0
    delta: {
      role?: "assistant"
      content?: string
      tool_calls?: ChatToolCallDelta[]
      reasoning_content?: string
    }
    finish_reason: "stop" | "length" | "tool_calls" | null
  }>
  usage?: ChatCompletionUsage
}

export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<{
    index: 0
    message: {
      role: "assistant"
      content: string | null
      tool_calls?: ChatToolCall[]
    }
    finish_reason: "stop" | "length" | "tool_calls" | null
  }>
  usage: ChatCompletionUsage
}

interface ChatToolCallDelta {
  index: number
  id?: string
  type?: "function"
  function?: {
    name?: string
    arguments?: string
  }
}

interface ChatToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export function convertChatCompletionRequestToCommandCode(
  request: ChatCompletionRequest,
  options: { cwd?: string; now?: Date; memory?: string; taste?: string } = {},
): CommandCodePayload {
  const systemParts: string[] = []
  const messages: CommandCodeMessage[] = []
  const toolNamesByCallId = new Map<string, string>()

  for (const message of request.messages ?? []) {
    appendChatMessage(message, messages, systemParts, toolNamesByCallId)
  }

  const params: CommandCodeParams = {
    model: resolveModel(request.model ?? DEFAULT_MODEL),
    messages,
    tools: request.tool_choice === "none" ? [] : convertChatTools(request.tools),
    system: systemParts.join("\n\n"),
    max_tokens: Math.min(
      request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS,
      MAX_TOKENS,
    ),
    stream: true,
  }

  if (typeof request.temperature === "number") params.temperature = Math.min(request.temperature, 1)
  if (typeof request.top_p === "number") params.top_p = request.top_p
  if (typeof request.stop === "string" || Array.isArray(request.stop)) params.stop = request.stop
  if (isRecord(request.tool_choice) || request.tool_choice === "required") {
    params.tool_choice = request.tool_choice
  }
  if (typeof request.parallel_tool_calls === "boolean") {
    params.parallel_tool_calls = request.parallel_tool_calls
  }
  if (typeof request.frequency_penalty === "number")
    params.frequency_penalty = request.frequency_penalty
  if (typeof request.presence_penalty === "number")
    params.presence_penalty = request.presence_penalty
  if (request.response_format) params.response_format = request.response_format
  if (typeof request.seed === "number") params.seed = request.seed

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

function appendChatMessage(
  message: ChatMessage,
  messages: CommandCodeMessage[],
  systemParts: string[],
  toolNamesByCallId: Map<string, string>,
): void {
  if (message.role === "system" || message.role === "developer") {
    const text = chatContentText(message.content)
    if (text) systemParts.push(text)
    return
  }

  if (message.role === "user") {
    const content = chatContentBlocks(message.content)
    if (content.length > 0) messages.push({ role: "user", content })
    return
  }

  if (message.role === "assistant") {
    const content: CommandCodeContent[] = []
    const text = chatContentText(message.content)
    if (text) content.push({ type: "text", text })
    for (const toolCall of chatToolCalls(message.tool_calls)) {
      toolNamesByCallId.set(toolCall.toolCallId, toolCall.toolName)
      content.push(toolCall)
    }
    if (content.length > 0) messages.push({ role: "assistant", content })
    return
  }

  const toolCallId = message.tool_call_id ?? ""
  messages.push({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: message.name ?? toolNamesByCallId.get(toolCallId) ?? "",
        output: { type: "text", value: chatContentText(message.content) },
      },
    ],
  })
}

function chatContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (isRecord(part) && part.type === "text") return stringValue(part.text) ?? ""
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function chatContentBlocks(content: unknown): CommandCodeContent[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((part): CommandCodeContent[] => {
    if (typeof part === "string") return part ? [{ type: "text", text: part }] : []
    if (!isRecord(part)) return []
    if (part.type === "text") {
      const text = stringValue(part.text)
      return text ? [{ type: "text", text }] : []
    }
    if (part.type === "image_url") {
      const imageUrl = isRecord(part.image_url)
        ? stringValue(part.image_url.url)
        : stringValue(part.image_url)
      const image = imageUrl ? imageContentFromDataUrl(imageUrl) : undefined
      return image ? [image] : []
    }
    return []
  })
}

function chatToolCalls(
  toolCalls: unknown,
): Array<Extract<CommandCodeContent, { type: "tool-call" }>> {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.flatMap((toolCall) => {
    if (!isRecord(toolCall)) return []
    const fn = isRecord(toolCall.function) ? toolCall.function : {}
    return [
      {
        type: "tool-call",
        toolCallId: stringValue(toolCall.id) ?? idWithPrefix("call"),
        toolName: stringValue(fn.name) ?? "",
        input: recordOrEmpty(fn.arguments),
      },
    ]
  })
}

function convertChatTools(tools: unknown): CommandCodeTool[] {
  if (!Array.isArray(tools)) return []
  const converted: CommandCodeTool[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const type = stringValue(tool.type)
    if (type && type !== "function") continue
    const fn = isRecord(tool.function) ? tool.function : undefined
    const name = stringValue(fn?.name) ?? stringValue(tool.name)
    if (!name) continue
    const commandCodeTool: CommandCodeTool = {
      type: "function",
      name,
      input_schema: toObjectJsonSchema(fn?.parameters ?? tool.parameters),
    }
    const description = stringValue(fn?.description) ?? stringValue(tool.description)
    if (description) commandCodeTool.description = description
    converted.push(commandCodeTool)
  }
  return converted
}

export function chatCompletionChunksFromCommandCodeEvents(
  commandCodeEvents: CommandCodeStreamEvent[],
  options: { completionId?: string; model?: string; created?: number; includeUsage?: boolean } = {},
): ChatCompletionChunk[] {
  const translator = createChatCompletionStreamTranslator(options)
  const chunks: ChatCompletionChunk[] = []
  for (const event of commandCodeEvents) chunks.push(...translator.push(event))
  chunks.push(...translator.finish())
  return chunks
}

export interface ChatCompletionStreamTranslator {
  push(event: CommandCodeStreamEvent): ChatCompletionChunk[]
  finish(): ChatCompletionChunk[]
}

export function createChatCompletionStreamTranslator(
  options: { completionId?: string; model?: string; created?: number; includeUsage?: boolean } = {},
): ChatCompletionStreamTranslator {
  const state: ChatState = {
    chunks: [],
    completionId: options.completionId ?? idWithPrefix("chatcmpl"),
    model: options.model ?? DEFAULT_MODEL,
    created: options.created ?? Math.floor(Date.now() / 1000),
    sentRole: false,
    finishReason: null,
    usage: undefined,
    includeUsage: options.includeUsage ?? true,
    toolIndexes: new Map(),
    nextToolIndex: 0,
  }

  return {
    push(event) {
      const start = state.chunks.length
      handleChatEvent(state, event)
      return state.chunks.slice(start)
    },
    finish() {
      const start = state.chunks.length
      if (state.finishReason === null) {
        pushChunk(state, {}, "stop")
        state.finishReason = "stop"
      }
      return state.chunks.slice(start)
    },
  }
}

interface ChatState {
  chunks: ChatCompletionChunk[]
  completionId: string
  model: string
  created: number
  sentRole: boolean
  finishReason: "stop" | "length" | "tool_calls" | null
  usage: ChatCompletionUsage | undefined
  includeUsage: boolean
  toolIndexes: Map<string, number>
  nextToolIndex: number
}

function handleChatEvent(state: ChatState, event: CommandCodeStreamEvent): void {
  const type = stringValue(event.type)
  if (!type) return

  if (type === "reasoning-delta") {
    ensureRole(state)
    pushChunk(state, { reasoning_content: stringValue(event.text) ?? "" }, null)
    return
  }

  if (type === "reasoning-end") return

  if (type === "text-delta") {
    ensureRole(state)
    pushChunk(state, { content: stringValue(event.text) ?? "" }, null)
    return
  }

  if (type === "tool-input-start") {
    ensureRole(state)
    const id = stringValue(event.id) ?? stringValue(event.toolCallId) ?? idWithPrefix("call")
    const index = toolIndex(state, id)
    pushChunk(
      state,
      {
        tool_calls: [
          {
            index,
            id,
            type: "function",
            function: { name: stringValue(event.toolName) ?? "", arguments: "" },
          },
        ],
      },
      null,
    )
    return
  }

  if (type === "tool-input-delta") {
    ensureRole(state)
    const id = stringValue(event.id) ?? stringValue(event.toolCallId) ?? idWithPrefix("call")
    pushChunk(
      state,
      {
        tool_calls: [
          {
            index: toolIndex(state, id),
            function: { arguments: stringValue(event.delta) ?? "" },
          },
        ],
      },
      null,
    )
    return
  }

  if (type === "tool-call") {
    ensureRole(state)
    const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? idWithPrefix("call")
    const index = toolIndex(state, id)
    if (!state.toolIndexes.has(id)) state.toolIndexes.set(id, index)
    return
  }

  if (type === "finish") {
    state.usage = chatUsageFromFinish(event)
    const finishReason = mapChatFinishReason(event.finishReason)
    pushChunk(state, {}, finishReason)
    if (state.includeUsage) pushUsageChunk(state)
    state.finishReason = finishReason
  }
}

function ensureRole(state: ChatState): void {
  if (state.sentRole) return
  pushChunk(state, { role: "assistant" }, null)
  state.sentRole = true
}

function pushChunk(
  state: ChatState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: "stop" | "length" | "tool_calls" | null,
): void {
  const chunk: ChatCompletionChunk = {
    id: state.completionId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  state.chunks.push(chunk)
}

function pushUsageChunk(state: ChatState): void {
  if (!state.usage) return
  state.chunks.push({
    id: state.completionId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [],
    usage: state.usage,
  })
}

function toolIndex(state: ChatState, id: string): number {
  const existing = state.toolIndexes.get(id)
  if (existing !== undefined) return existing
  const next = state.nextToolIndex
  state.nextToolIndex += 1
  state.toolIndexes.set(id, next)
  return next
}

function chatUsageFromFinish(event: CommandCodeStreamEvent): ChatCompletionUsage {
  const usage = isRecord(event.totalUsage) ? event.totalUsage : {}
  const promptTokens = numberValue(usage.inputTokens) ?? 0
  const completionTokens = numberValue(usage.outputTokens) ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function mapChatFinishReason(reason: unknown): "stop" | "length" | "tool_calls" {
  if (reason === "tool-calls") return "tool_calls"
  if (reason === "length" || reason === "max_tokens" || reason === "max-tokens") return "length"
  return "stop"
}

export function chatCompletionFromChunks(chunks: ChatCompletionChunk[]): ChatCompletionResponse {
  const last = chunks.findLast((chunk) => chunk.choices.length > 0) ?? chunks.at(-1)
  const usageChunk = chunks.findLast((chunk) => chunk.usage !== undefined)
  const content = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("")
  const toolCalls = aggregateToolCalls(chunks)
  return {
    id: last?.id ?? idWithPrefix("chatcmpl"),
    object: "chat.completion",
    created: last?.created ?? Math.floor(Date.now() / 1000),
    model: last?.model ?? DEFAULT_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length > 0 && !content ? null : content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: last?.choices[0]?.finish_reason ?? "stop",
      },
    ],
    usage: usageChunk?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function aggregateToolCalls(chunks: ChatCompletionChunk[]): ChatToolCall[] {
  const calls = new Map<number, ChatToolCall>()

  for (const chunk of chunks) {
    for (const delta of chunk.choices[0]?.delta.tool_calls ?? []) {
      const existing = calls.get(delta.index) ?? {
        id: delta.id ?? idWithPrefix("call"),
        type: "function",
        function: { name: "", arguments: "" },
      }
      if (delta.id) existing.id = delta.id
      if (delta.function?.name) existing.function.name = delta.function.name
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments
      calls.set(delta.index, existing)
    }
  }

  return [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call)
}
