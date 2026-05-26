import { describe, expect, it } from "vitest"

import {
  convertResponsesRequestToCommandCode,
  createResponsesStreamTranslator,
  responsesEventsFromCommandCodeEvents,
} from "../src/responses.ts"
import type { CommandCodeContent, ResponsesStreamEvent } from "../src/types.ts"

function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((event) => event.type)
}

function expectToolCall(
  content: CommandCodeContent | undefined,
): Extract<CommandCodeContent, { type: "tool-call" }> {
  if (content?.type !== "tool-call") throw new Error("Expected tool-call content")
  return content as Extract<CommandCodeContent, { type: "tool-call" }>
}

function expectToolResult(
  content: CommandCodeContent | undefined,
): Extract<CommandCodeContent, { type: "tool-result" }> {
  if (content?.type !== "tool-result") throw new Error("Expected tool-result content")
  return content as Extract<CommandCodeContent, { type: "tool-result" }>
}

function expectCompleted(
  events: ResponsesStreamEvent[],
): NonNullable<ResponsesStreamEvent["response"]> {
  const response = events.at(-1)?.response
  if (!response) throw new Error("Expected completed response")
  return response as NonNullable<ResponsesStreamEvent["response"]>
}

describe("convertResponsesRequestToCommandCode", () => {
  it("combines instructions and system input messages", () => {
    const result = convertResponsesRequestToCommandCode({
      model: "deepseek-v4-pro",
      instructions: "Base system.",
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "Extra system." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
    })

    expect(result.params.system).toBe("Base system.\n\nExtra system.")
    expect(result.params.messages[0]?.role).toBe("user")
  })

  it("infers function_call_output toolName from prior function_call call_id", () => {
    const result = convertResponsesRequestToCommandCode({
      model: "deepseek-v4-pro",
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"README.md"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "contents",
        },
      ],
    })

    expect(expectToolCall(result.params.messages[0]?.content[0]).toolCallId).toBe("call_1")
    expect(expectToolResult(result.params.messages[1]?.content[0]).toolName).toBe("read_file")
  })

  it("passes supported sampling parameters and object tool choice through", () => {
    const result = convertResponsesRequestToCommandCode({
      model: "deepseek-v4-pro",
      input: "hi",
      temperature: 0.2,
      top_p: 0.9,
      stop: ["END"],
      tool_choice: { type: "function", name: "read_file" },
      parallel_tool_calls: true,
    })

    expect(result.params.temperature).toBe(0.2)
    expect(result.params.top_p).toBe(0.9)
    expect(result.params.stop).toEqual(["END"])
    expect(result.params.tool_choice).toEqual({ type: "function", name: "read_file" })
    expect(result.params.parallel_tool_calls).toBe(true)
  })

  it("does not forward string tool_choice values to Command Code", () => {
    const result = convertResponsesRequestToCommandCode({
      model: "deepseek-v4-pro",
      input: "hi",
      tool_choice: "auto",
    })

    expect(result.params.tool_choice).toBeUndefined()
  })

  it("maps apply_patch to a patch string schema for Command Code", () => {
    const result = convertResponsesRequestToCommandCode({
      model: "deepseek-v4-pro",
      input: "hi",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          parameters: { type: null },
        },
      ],
    })

    expect(result.params.tools[0]).toEqual({
      type: "function",
      name: "apply_patch",
      description:
        "Apply a Codex patch to edit files. The patch string must be exactly in Codex apply_patch format. For new files, use: *** Begin Patch, *** Add File: path, +lines, *** End Patch. Do not use unified diff headers such as ---/+++ or @@ ranges.",
      input_schema: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "A Codex apply_patch patch. It must start with '*** Begin Patch' and end with '*** End Patch'. Use only *** Add File, *** Delete File, or *** Update File hunks.",
          },
        },
        required: ["patch"],
      },
    })
  })
})

describe("responsesEventsFromCommandCodeEvents", () => {
  it("translates Command Code events incrementally for live SSE forwarding", () => {
    const translator = createResponsesStreamTranslator({
      responseId: "resp_test",
      model: "deepseek-v4-pro",
      createdAt: 1,
    })

    expect(
      JSON.stringify(translator.push({ type: "reasoning-delta", text: "hidden" })),
    ).not.toContain("hidden")
    expect(eventTypes(translator.push({ type: "text-delta", text: "hello" }))).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
    ])
    expect(eventTypes(translator.push({ type: "finish", finishReason: "stop" }))).toContain(
      "response.completed",
    )
  })

  it("keeps reasoning out of assistant output_text by default", () => {
    const events = responsesEventsFromCommandCodeEvents([
      { type: "reasoning-delta", text: "private thought" },
      { type: "reasoning-end" },
      { type: "text-delta", text: "public answer" },
      { type: "finish", finishReason: "stop" },
    ])

    expect(JSON.stringify(events)).not.toContain("private thought")
    expect(JSON.stringify(events)).toContain("public answer")
  })

  it("streams tool input deltas before the final tool-call event", () => {
    const events = responsesEventsFromCommandCodeEvents([
      { type: "tool-input-start", id: "call_1", toolName: "read_file" },
      { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
      { type: "tool-input-delta", id: "call_1", delta: '"README.md"}' },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read_file",
        input: { path: "README.md" },
      },
      { type: "finish", finishReason: "tool-calls" },
    ])

    expect(eventTypes(events).filter((type) => type.includes("function_call"))).toEqual([
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ])
    const response = expectCompleted(events)
    expect(response.status).toBe("completed")
    expect(response.output[0]?.arguments).toBe('{"path":"README.md"}')
  })

  it("translates apply_patch as a Responses custom tool call", () => {
    const patch = "*** Begin Patch\n*** Add File: patch_probe.txt\n+hello\n*** End Patch\n"
    const input = JSON.stringify({ patch })
    const events = responsesEventsFromCommandCodeEvents([
      { type: "tool-input-start", id: "call_patch", toolName: "apply_patch" },
      { type: "tool-input-delta", id: "call_patch", delta: input.slice(0, 20) },
      { type: "tool-input-delta", id: "call_patch", delta: input.slice(20) },
      { type: "tool-input-end", id: "call_patch" },
      {
        type: "tool-call",
        toolCallId: "call_patch",
        toolName: "apply_patch",
        input: { input: patch },
      },
      { type: "finish", finishReason: "tool-calls" },
    ])

    expect(eventTypes(events).filter((type) => type.includes("custom_tool_call"))).toEqual([
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
    ])
    const added = events.find((event) => event.type === "response.output_item.added")
    expect(added?.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
    })
    const response = expectCompleted(events)
    expect(response.output[0]).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
      input: patch,
    })
  })

  it("keeps output indexes stable for interleaved tool calls", () => {
    const events = responsesEventsFromCommandCodeEvents([
      { type: "tool-input-start", id: "call_1", toolName: "read_file" },
      { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
      { type: "tool-input-start", id: "call_2", toolName: "list_files" },
      { type: "tool-input-delta", id: "call_2", delta: '{"dir":' },
      { type: "tool-input-delta", id: "call_1", delta: '"README.md"}' },
      { type: "tool-input-end", id: "call_2" },
      { type: "tool-input-end", id: "call_1" },
      { type: "tool-call", toolCallId: "call_2", toolName: "list_files", input: { dir: "." } },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read_file",
        input: { path: "README.md" },
      },
      { type: "finish", finishReason: "tool-calls" },
    ])

    const added = events.filter((event) => event.type === "response.output_item.added")
    expect(added.map((event) => [event.output_index, event.item?.call_id])).toEqual([
      [0, "call_1"],
      [1, "call_2"],
    ])

    const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta")
    expect(deltas.map((event) => [event.output_index, event.delta])).toEqual([
      [0, '{"path":'],
      [1, '{"dir":'],
      [0, '"README.md"}'],
    ])

    const response = expectCompleted(events)
    expect(response.output.map((item) => item.call_id)).toEqual(["call_1", "call_2"])
    expect(response.output.map((item) => item.arguments)).toEqual([
      '{"path":"README.md"}',
      '{"dir":"."}',
    ])
  })

  it("maps Command Code usage into Responses API usage", () => {
    const events = responsesEventsFromCommandCodeEvents([
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 11,
          outputTokens: 7,
          inputTokenDetails: { cacheReadTokens: 3 },
        },
      },
    ])

    expect(expectCompleted(events).usage).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 21,
      input_tokens_details: { cached_tokens: 3 },
    })
  })
})
