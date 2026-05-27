import process from "node:process"

import { resolveModel } from "./models.ts"
import type {
  CommandCodeContent,
  CommandCodeMessage,
  CommandCodeParams,
  CommandCodePayload,
  CommandCodeStreamEvent,
  CommandCodeTool,
  ResponsesOutputItem,
  ResponsesRequest,
  ResponsesStreamEvent,
  ResponsesUsage,
} from "./types.ts"
import {
  getEnvironmentInfo,
  getGitContext,
  idWithPrefix,
  isRecord,
  numberValue,
  recordOrEmpty,
  stringValue,
  textFromUnknown,
  toObjectJsonSchema,
} from "./utils.ts"

const DEFAULT_MODEL = "deepseek-v4-pro"
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000
const MAX_OUTPUT_TOKENS = 200_000

export function convertResponsesRequestToCommandCode(
  request: ResponsesRequest,
  options: { cwd?: string; now?: Date; memory?: string; taste?: string } = {},
): CommandCodePayload {
  const messages: CommandCodeMessage[] = []
  const toolNamesByCallId = new Map<string, string>()
  const systemParts = [request.instructions].filter((part): part is string => Boolean(part))

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: request.input }] })
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!isRecord(item)) continue
      appendInputItem(item, messages, systemParts, toolNamesByCallId)
    }
  }

  const params: CommandCodeParams = {
    model: resolveModel(request.model ?? DEFAULT_MODEL),
    messages,
    tools: convertTools(request.tools),
    system: systemParts.join("\n\n"),
    max_tokens: Math.min(request.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    stream: true,
  }

  if (typeof request.temperature === "number") params.temperature = Math.min(request.temperature, 1)
  if (typeof request.top_p === "number") params.top_p = request.top_p
  if (typeof request.stop === "string" || Array.isArray(request.stop)) params.stop = request.stop
  if (isRecord(request.tool_choice)) params.tool_choice = request.tool_choice
  if (typeof request.parallel_tool_calls === "boolean") {
    params.parallel_tool_calls = request.parallel_tool_calls
  }
  if (typeof request.frequency_penalty === "number")
    params.frequency_penalty = request.frequency_penalty
  if (typeof request.presence_penalty === "number")
    params.presence_penalty = request.presence_penalty
  if (request.response_format) params.response_format = request.response_format

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

function appendInputItem(
  item: Record<string, unknown>,
  messages: CommandCodeMessage[],
  systemParts: string[],
  toolNamesByCallId: Map<string, string>,
): void {
  if (item.type === "message") {
    appendMessageItem(item, messages, systemParts, toolNamesByCallId)
    return
  }

  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const toolCall = functionCallContent(item)
    toolNamesByCallId.set(toolCall.toolCallId, toolCall.toolName)
    const last = messages.at(-1)
    if (
      last?.role === "assistant" &&
      last.content.some((content) => content.type === "tool-call")
    ) {
      last.content.push(toolCall)
      return
    }
    messages.push({ role: "assistant", content: [toolCall] })
    return
  }

  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const callId = stringValue(item.call_id) ?? ""
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: stringValue(item.name) ?? toolNamesByCallId.get(callId) ?? "",
          output: { type: "text", value: textFromUnknown(item.output) },
        },
      ],
    })
  }
}

function appendMessageItem(
  item: Record<string, unknown>,
  messages: CommandCodeMessage[],
  systemParts: string[],
  toolNamesByCallId: Map<string, string>,
): void {
  const role = stringValue(item.role)
  const content = Array.isArray(item.content) ? item.content : []

  if (role === "system") {
    const systemText = content.map(textFromContentBlock).filter(Boolean).join("\n")
    if (systemText) systemParts.push(systemText)
    return
  }

  if (role === "user") {
    const userContent = content.flatMap(userContentBlock)
    if (userContent.length > 0) messages.push({ role: "user", content: userContent })
    return
  }

  if (role === "assistant" || role === "model") {
    const parts: CommandCodeContent[] = []
    for (const block of content) {
      if (typeof block === "string") {
        parts.push({ type: "text", text: block })
      } else if (isRecord(block) && (block.type === "output_text" || block.type === "text")) {
        parts.push({ type: "text", text: stringValue(block.text) ?? "" })
      } else if (isRecord(block) && block.type === "function_call") {
        const toolCall = functionCallContent(block)
        toolNamesByCallId.set(toolCall.toolCallId, toolCall.toolName)
        parts.push(toolCall)
      }
    }
    if (parts.length > 0) messages.push({ role: "assistant", content: parts })
  }
}

function textFromContentBlock(block: unknown): string {
  if (typeof block === "string") return block
  if (!isRecord(block)) return ""
  if (block.type === "input_text" || block.type === "text") return stringValue(block.text) ?? ""
  return ""
}

function userContentBlock(block: unknown): CommandCodeContent[] {
  const text = textFromContentBlock(block)
  return text ? [{ type: "text", text }] : []
}

function functionCallContent(
  item: Record<string, unknown>,
): Extract<CommandCodeContent, { type: "tool-call" }> {
  const callId = stringValue(item.call_id) ?? stringValue(item.id) ?? idWithPrefix("call")
  return {
    type: "tool-call",
    toolCallId: callId,
    toolName: stringValue(item.name) ?? "",
    input: customToolInput(item) ?? recordOrEmpty(item.arguments),
  }
}

function customToolInput(item: Record<string, unknown>): { input: string } | undefined {
  if (item.type !== "custom_tool_call") return undefined
  return { input: stringValue(item.input) ?? "" }
}

function convertTools(tools: unknown): CommandCodeTool[] {
  if (!Array.isArray(tools)) return []
  const converted: CommandCodeTool[] = []

  for (const tool of tools) {
    if (!isRecord(tool)) continue
    const type = stringValue(tool.type)
    if (type && type !== "function" && type !== "custom") continue

    const fn = isRecord(tool.function) ? tool.function : undefined
    const name = stringValue(fn?.name) ?? stringValue(tool.name)
    if (!name) continue
    const commandCodeTool: CommandCodeTool = {
      type: "function",
      name,
      input_schema: commandCodeToolSchema(name, fn?.parameters ?? tool.parameters),
    }
    const description =
      applyPatchDescription(name) ?? stringValue(fn?.description) ?? stringValue(tool.description)
    if (description) commandCodeTool.description = description
    converted.push(commandCodeTool)
  }

  return converted
}

function commandCodeToolSchema(name: string, schema: unknown): unknown {
  if (isCustomToolName(name)) {
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
    }
  }
  return toObjectJsonSchema(schema)
}

function applyPatchDescription(name: string): string | undefined {
  if (!isCustomToolName(name)) return undefined
  return [
    "Apply a unified diff patch to edit files.",
    "Use standard unified diff format: --- a/file, +++ b/file headers,",
    "@@ -start,count +start,count @@ hunk markers with 3 lines of context.",
    "Lines: space-prefixed = context, +prefixed = addition, -prefixed = deletion.",
    "Example: --- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n context\n+new line\n context",
  ].join(" ")
}

export function responsesEventsFromCommandCodeEvents(
  commandCodeEvents: CommandCodeStreamEvent[],
  options: { responseId?: string; model?: string; createdAt?: number } = {},
): ResponsesStreamEvent[] {
  const translator = createResponsesStreamTranslator(options)
  const events: ResponsesStreamEvent[] = []
  for (const event of commandCodeEvents) {
    events.push(...translator.push(event))
  }
  events.push(...translator.finish())
  return events
}

export interface ResponsesStreamTranslator {
  push(event: CommandCodeStreamEvent): ResponsesStreamEvent[]
  finish(): ResponsesStreamEvent[]
}

export function createResponsesStreamTranslator(
  options: { responseId?: string; model?: string; createdAt?: number } = {},
): ResponsesStreamTranslator {
  const state = createResponsesState(options)
  return {
    push(event) {
      const start = state.events.length
      handleCommandCodeEvent(state, event)
      return state.events.slice(start)
    },
    finish() {
      const start = state.events.length
      if (!state.sentCompleted) completeResponse(state)
      return state.events.slice(start)
    },
  }
}

interface ResponsesState {
  events: ResponsesStreamEvent[]
  responseId: string
  itemId: string
  model: string
  createdAt: number
  outputIndex: number
  textContent: string
  textOpen: boolean
  reasoningContent: string
  reasoningItemId: string
  reasoningOutputIndex: number
  reasoningOpen: boolean
  output: ResponsesOutputItem[]
  toolCalls: Map<string, ToolCallState>
  sentCreated: boolean
  sentCompleted: boolean
  usage: ResponsesUsage
}

interface ToolCallState {
  item: ResponsesOutputItem
  outputIndex: number
  rawInput: string
}

function createResponsesState(options: {
  responseId?: string
  model?: string
  createdAt?: number
}): ResponsesState {
  return {
    events: [],
    responseId: options.responseId ?? idWithPrefix("resp"),
    itemId: idWithPrefix("item"),
    model: options.model ?? DEFAULT_MODEL,
    createdAt: options.createdAt ?? Math.floor(Date.now() / 1000),
    outputIndex: 0,
    textContent: "",
    textOpen: false,
    reasoningContent: "",
    reasoningItemId: idWithPrefix("rsn"),
    reasoningOutputIndex: -1,
    reasoningOpen: false,
    output: [],
    toolCalls: new Map(),
    sentCreated: false,
    sentCompleted: false,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
}

function handleCommandCodeEvent(state: ResponsesState, event: CommandCodeStreamEvent): void {
  const type = stringValue(event.type)
  if (!type) return

  if (type === "text-delta") {
    ensureCreated(state)
    appendTextDelta(state, stringValue(event.text) ?? "")
    return
  }

  if (type === "reasoning-delta") {
    ensureCreated(state)
    startReasoning(state)
    const delta = stringValue(event.text) ?? ""
    state.reasoningContent += delta
    state.events.push({
      type: "response.reasoning_text.delta",
      output_index: state.reasoningOutputIndex,
      content_index: 0,
      delta,
    })
    return
  }

  if (type === "reasoning-end") {
    ensureCreated(state)
    closeReasoning(state)
    return
  }

  if (type === "text-end") {
    ensureCreated(state)
    closeText(state)
    return
  }

  if (type === "tool-input-start") {
    ensureCreated(state)
    closeText(state)
    startToolCall(
      state,
      stringValue(event.id) ?? stringValue(event.toolCallId),
      stringValue(event.toolName),
    )
    return
  }

  if (type === "tool-input-delta") {
    ensureCreated(state)
    appendToolDelta(
      state,
      stringValue(event.id) ?? stringValue(event.toolCallId),
      stringValue(event.delta) ?? "",
    )
    return
  }

  if (type === "tool-input-end") {
    ensureCreated(state)
    finishToolArguments(state, stringValue(event.id) ?? stringValue(event.toolCallId))
    return
  }

  if (type === "tool-call") {
    ensureCreated(state)
    closeText(state)
    completeToolCall(
      state,
      stringValue(event.toolCallId) ?? stringValue(event.id),
      stringValue(event.toolName),
      event.input,
    )
    return
  }

  if (type === "finish") {
    ensureCreated(state)
    state.usage = usageFromFinish(event)
    completeResponse(state)
  }
}

function ensureCreated(state: ResponsesState): void {
  if (state.sentCreated) return
  state.events.push({
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status: "in_progress",
      output: [],
    },
  })
  state.sentCreated = true
}

function appendTextDelta(state: ResponsesState, delta: string): void {
  if (!state.textOpen) {
    state.events.push({
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: {
        type: "message",
        id: state.itemId,
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
    state.events.push({
      type: "response.content_part.added",
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    })
    state.textOpen = true
  }

  state.textContent += delta
  state.events.push({
    type: "response.output_text.delta",
    output_index: state.outputIndex,
    content_index: 0,
    delta,
  })
}

function closeText(state: ResponsesState): void {
  if (!state.textOpen) return
  const item: ResponsesOutputItem = {
    type: "message",
    id: state.itemId,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: state.textContent }],
  }
  state.events.push({
    type: "response.output_text.done",
    output_index: state.outputIndex,
    content_index: 0,
    text: state.textContent,
  })
  state.events.push({
    type: "response.content_part.done",
    output_index: state.outputIndex,
    content_index: 0,
    part: { type: "output_text", text: state.textContent },
  })
  state.events.push({ type: "response.output_item.done", output_index: state.outputIndex, item })
  state.output.push(item)
  state.outputIndex += 1
  state.textOpen = false
}

function startReasoning(state: ResponsesState): void {
  if (state.reasoningOpen) return
  if (state.reasoningOutputIndex < 0) {
    state.reasoningOutputIndex = state.outputIndex
    state.outputIndex += 1
  }
  state.events.push({
    type: "response.output_item.added",
    output_index: state.reasoningOutputIndex,
    item: {
      type: "reasoning",
      id: state.reasoningItemId,
      status: "in_progress",
      summary: [],
    },
  })
  state.reasoningOpen = true
}

function closeReasoning(state: ResponsesState): void {
  if (!state.reasoningOpen) return
  state.events.push({
    type: "response.reasoning_text.done",
    output_index: state.reasoningOutputIndex,
    content_index: 0,
    text: state.reasoningContent,
  })
  const item: ResponsesOutputItem = {
    type: "reasoning",
    id: state.reasoningItemId,
    status: "completed",
    summary: state.reasoningContent ? [{ type: "summary_text", text: state.reasoningContent }] : [],
  }
  state.events.push({
    type: "response.output_item.done",
    output_index: state.reasoningOutputIndex,
    item,
  })
  state.output.push(item)
  state.reasoningOpen = false
}

function startToolCall(
  state: ResponsesState,
  id: string | undefined,
  name: string | undefined,
): void {
  const callId = id || idWithPrefix("call")
  if (state.toolCalls.has(callId)) return
  const item = isCustomToolName(name)
    ? {
        type: "custom_tool_call" as const,
        id: callId,
        call_id: callId,
        name: name ?? "",
        input: "",
        status: "in_progress" as const,
      }
    : {
        type: "function_call" as const,
        id: callId,
        call_id: callId,
        name: name ?? "",
        arguments: "",
        status: "in_progress" as const,
      }
  const outputIndex = state.outputIndex
  state.outputIndex += 1
  state.toolCalls.set(callId, { item, outputIndex, rawInput: "" })
  state.events.push({ type: "response.output_item.added", output_index: outputIndex, item })
}

function appendToolDelta(state: ResponsesState, id: string | undefined, delta: string): void {
  const toolCall = ensureToolCall(state, id)
  const { item } = toolCall
  if (item.type === "custom_tool_call") {
    toolCall.rawInput += delta
    return
  }

  item.arguments = `${item.arguments ?? ""}${delta}`
  state.events.push({
    type: "response.function_call_arguments.delta",
    output_index: toolCall.outputIndex,
    delta,
  })
}

function finishToolArguments(state: ResponsesState, id: string | undefined): void {
  const toolCall = ensureToolCall(state, id)
  if (toolCall.item.type === "custom_tool_call") {
    const input = customInputText(recordOrEmpty(toolCall.rawInput), toolCall.rawInput)
    toolCall.item.input = input
    state.events.push({
      type: "response.custom_tool_call_input.delta",
      output_index: toolCall.outputIndex,
      item_id: toolCall.item.id,
      delta: input,
    })
    state.events.push({
      type: "response.custom_tool_call_input.done",
      output_index: toolCall.outputIndex,
      item_id: toolCall.item.id,
      input,
    })
    return
  }

  state.events.push({
    type: "response.function_call_arguments.done",
    output_index: toolCall.outputIndex,
    arguments: toolCall.item.arguments ?? "",
  })
}

function completeToolCall(
  state: ResponsesState,
  id: string | undefined,
  name: string | undefined,
  input: unknown,
): void {
  const toolCall = ensureToolCall(state, id, name)
  const { item } = toolCall
  if (name) item.name = name
  if (item.type === "custom_tool_call") {
    const customInput = customInputText(input, item.input ?? "")
    if (!item.input || item.input !== customInput) item.input = customInput
  } else {
    const args = JSON.stringify(isRecord(input) ? input : recordOrEmpty(input))
    if (!item.arguments || item.arguments !== args) item.arguments = args
  }
  item.status = "completed"
  state.events.push({ type: "response.output_item.done", output_index: toolCall.outputIndex, item })
  state.output = Array.from(state.toolCalls.values())
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .filter((entry) => entry.item.status === "completed")
    .map((entry) => ({ ...entry.item }))
}

function isCustomToolName(name: string | undefined): boolean {
  return name === "apply_patch"
}

function customInputText(input: unknown, fallback: string): string {
  if (typeof input === "string") return input
  if (isRecord(input)) {
    return (
      stringValue(input.input) ??
      stringValue(input.patch) ??
      stringValue(input.content) ??
      stringValue(input.text) ??
      fallback
    )
  }
  return fallback
}

function ensureToolCall(
  state: ResponsesState,
  id: string | undefined,
  name?: string,
): ToolCallState {
  const callId = id || idWithPrefix("call")
  const existing = state.toolCalls.get(callId)
  if (existing) return existing
  startToolCall(state, callId, name ?? "")
  const created = state.toolCalls.get(callId)
  if (!created) throw new Error(`Failed to create tool call ${callId}`)
  return created
}

function usageFromFinish(event: CommandCodeStreamEvent): ResponsesUsage {
  const usage = isRecord(event.totalUsage) ? event.totalUsage : {}
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {}
  const inputTokens = numberValue(usage.inputTokens) ?? 0
  const outputTokens = numberValue(usage.outputTokens) ?? 0
  const cachedTokens = numberValue(details.cacheReadTokens) ?? 0
  const responseUsage: ResponsesUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens + cachedTokens,
  }
  if (cachedTokens > 0) responseUsage.input_tokens_details = { cached_tokens: cachedTokens }
  return responseUsage
}

function completeResponse(state: ResponsesState): void {
  if (state.sentCompleted) return
  closeText(state)
  closeReasoning(state)
  state.events.push({
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.createdAt,
      model: state.model,
      status: "completed",
      output: state.output,
      usage: state.usage,
    },
  })
  state.sentCompleted = true
}
