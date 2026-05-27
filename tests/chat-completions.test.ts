import { describe, expect, it } from "vitest"

import {
  chatCompletionChunksFromCommandCodeEvents,
  chatCompletionFromChunks,
  convertChatCompletionRequestToCommandCode,
} from "../src/chat-completions.ts"
import type { CommandCodeContent } from "../src/types.ts"

function expectToolResult(
  content: CommandCodeContent | undefined,
): Extract<CommandCodeContent, { type: "tool-result" }> {
  if (content?.type !== "tool-result") throw new Error("Expected tool-result content")
  return content
}

describe("convertChatCompletionRequestToCommandCode", () => {
  it("converts OpenAI chat messages and tool results into Command Code messages", () => {
    const result = convertChatCompletionRequestToCommandCode({
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
      temperature: 0.1,
    })

    expect(result.params.system).toBe("You are concise.")
    expect(result.params.messages[0]?.role).toBe("user")
    expect(result.params.messages[1]?.content[0]?.type).toBe("tool-call")
    expect(expectToolResult(result.params.messages[2]?.content[0]).toolName).toBe("read_file")
    expect(result.params.tools[0]?.name).toBe("read_file")
    expect(result.params.temperature).toBe(0.1)
  })

  it("does not forward string tool_choice values to Command Code", () => {
    const result = convertChatCompletionRequestToCommandCode({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "auto",
    })

    expect(result.params.tool_choice).toBeUndefined()
  })

  it("normalizes non-object function parameters to object schemas for Command Code", () => {
    const result = convertChatCompletionRequestToCommandCode({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "noop", parameters: { type: null } } }],
    })

    expect(result.params.tools[0]?.input_schema).toEqual({ type: "object", properties: {} })
  })

  it("forwards sampling parameters to Command Code", () => {
    const result = convertChatCompletionRequestToCommandCode({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      stop: ["END"],
    })

    expect(result.params.temperature).toBe(0.7)
    expect(result.params.top_p).toBe(0.9)
    expect(result.params.frequency_penalty).toBe(0.5)
    expect(result.params.presence_penalty).toBe(0.3)
    expect(result.params.stop).toEqual(["END"])
  })

  it("forwards response_format to Command Code", () => {
    const jsonSchema = { type: "object", properties: { name: { type: "string" } } }
    const result = convertChatCompletionRequestToCommandCode({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: jsonSchema },
    })

    expect(result.params.response_format).toEqual({
      type: "json_schema",
      json_schema: jsonSchema,
    })
  })
})

describe("chatCompletionChunksFromCommandCodeEvents", () => {
  it("converts text, streamed tool arguments, and usage into chat completion chunks", () => {
    const chunks = chatCompletionChunksFromCommandCodeEvents(
      [
        { type: "text-delta", text: "hello" },
        { type: "tool-input-start", id: "call_1", toolName: "read_file" },
        { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
        { type: "tool-input-delta", id: "call_1", delta: '"README.md"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 5, outputTokens: 3 },
        },
      ],
      { completionId: "chatcmpl_test", model: "deepseek-v4-pro", created: 1 },
    )

    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant")
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === "hello")).toBe(true)
    expect(
      chunks
        .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
        .map((toolCall) => toolCall.function?.arguments ?? "")
        .join(""),
    ).toContain('{"path":"README.md"}')
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    })
  })

  it("aggregates streamed tool calls into non-streaming chat completion responses", () => {
    const response = chatCompletionFromChunks(
      chatCompletionChunksFromCommandCodeEvents(
        [
          { type: "tool-input-start", id: "call_1", toolName: "read_file" },
          { type: "tool-input-delta", id: "call_1", delta: '{"path":"README.md"}' },
          { type: "tool-input-end", id: "call_1" },
          { type: "finish", finishReason: "tool-calls" },
        ],
        { completionId: "chatcmpl_test", model: "deepseek-v4-pro", created: 1 },
      ),
    )

    const firstChoice = response.choices[0]
    if (!firstChoice) throw new Error("Expected first choice")
    expect(firstChoice.message.tool_calls?.[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    })
    expect(firstChoice.finish_reason).toBe("tool_calls")
  })

  it("forwards reasoning-delta as reasoning_content in delta chunks", () => {
    const chunks = chatCompletionChunksFromCommandCodeEvents(
      [
        { type: "reasoning-delta", text: "Let me think" },
        { type: "reasoning-delta", text: " about this." },
        { type: "reasoning-end" },
        { type: "text-delta", text: "Answer" },
        { type: "finish", finishReason: "stop" },
      ],
      { completionId: "chatcmpl_test", model: "deepseek-v4-pro", created: 1 },
    )

    const reasoningChunks = chunks.filter(
      (c) => c.choices[0]?.delta.reasoning_content !== undefined,
    )
    expect(reasoningChunks).toHaveLength(2)
    expect(reasoningChunks[0]?.choices[0]?.delta.reasoning_content).toBe("Let me think")
    expect(reasoningChunks[1]?.choices[0]?.delta.reasoning_content).toBe(" about this.")
    expect(chunks.some((c) => c.choices[0]?.delta.content === "Answer")).toBe(true)
  })
})
