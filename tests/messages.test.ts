import { describe, expect, it } from "vitest"

import {
  anthropicMessagesFromCommandCodeEvents,
  convertAnthropicRequestToCommandCode,
} from "../src/messages.ts"
import type { CommandCodeContent } from "../src/types.ts"

function expectToolResult(
  content: CommandCodeContent | undefined,
): Extract<CommandCodeContent, { type: "tool-result" }> {
  if (content?.type !== "tool-result") throw new Error("Expected tool-result content")
  return content
}

describe("convertAnthropicRequestToCommandCode", () => {
  it("converts simple text messages into Command Code messages", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      system: "You are concise.",
      messages: [
        { role: "user", content: "Read the file" },
        { role: "assistant", content: "Sure, let me read it." },
      ],
      max_tokens: 4096,
      temperature: 0.1,
    })

    expect(result.params.system).toBe("You are concise.")
    expect(result.params.messages).toHaveLength(2)
    expect(result.params.messages[0]?.role).toBe("user")
    expect(result.params.messages[0]?.content[0]?.type).toBe("text")
    if (result.params.messages[0]?.content[0]?.type === "text") {
      expect(result.params.messages[0].content[0].text).toBe("Read the file")
    }
    expect(result.params.messages[1]?.role).toBe("assistant")
    expect(result.params.messages[1]?.content[0]?.type).toBe("text")
    expect(result.params.temperature).toBe(0.1)
    expect(result.params.max_tokens).toBe(4096)
  })

  it("converts system as content blocks into joined text", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "Rule 1" },
        { type: "text", text: "Rule 2" },
      ],
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    })

    expect(result.params.system).toBe("Rule 1\nRule 2")
  })

  it("converts tool use and tool result chains", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "file contents here",
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.messages).toHaveLength(3)
    // First message: user text
    expect(result.params.messages[0]?.role).toBe("user")
    // Second message: assistant tool-call
    expect(result.params.messages[1]?.role).toBe("assistant")
    expect(result.params.messages[1]?.content[0]?.type).toBe("tool-call")
    // Third message: role="tool" (Command Code requires tool results in separate messages)
    expect(result.params.messages[2]?.role).toBe("tool")
    const toolResult2 = expectToolResult(result.params.messages[2]?.content[0])
    expect(toolResult2.toolCallId).toBe("toolu_1")
    expect(toolResult2.toolName).toBe("read_file")
    expect(toolResult2.output.value).toBe("file contents here")
  })

  it("converts mixed user text + tool_result into separate messages", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "text", text: "good job" },
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "result",
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    // text goes to user message, tool_result to separate tool message
    expect(result.params.messages).toHaveLength(3)
    expect(result.params.messages[0]?.role).toBe("assistant")
    expect(result.params.messages[1]?.role).toBe("tool")
    expect(result.params.messages[2]?.role).toBe("user")
    expect(result.params.messages[2]?.content[0]?.type).toBe("text")
  })

  it("converts tool_result with error flag", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "Permission denied",
              is_error: true,
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    const toolResult = expectToolResult(result.params.messages[1]?.content[0])
    expect(toolResult.output.type).toBe("error-text")
  })

  it("converts tool_result with content arrays", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    const toolResult = expectToolResult(result.params.messages[1]?.content[0])
    expect(toolResult.output.value).toBe("line1\nline2")
  })

  it("converts anthropic tools to Command Code tools", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.tools).toHaveLength(1)
    expect(result.params.tools[0]?.name).toBe("read_file")
    expect(result.params.tools[0]?.description).toBe("Read a file")
    expect(result.params.tools[0]?.input_schema).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    })
  })

  it("normalizes apply_patch tool schema", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "apply_patch",
          input_schema: {
            type: "object",
            properties: { filePath: { type: "string" }, content: { type: "string" } },
          },
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.tools[0]?.input_schema).toEqual({
      type: "object",
      properties: {
        patch: { type: "string", description: expect.any(String) },
      },
      required: ["patch"],
    })
    expect(result.params.tools[0]?.description).toContain("unified diff")
  })

  it("converts image blocks into text placeholders", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    const userContent = result.params.messages[0]?.content[0]
    expect(userContent?.type).toBe("text")
    if (userContent?.type === "text") {
      expect(userContent.text).toBe("Describe this")
    }
    const imagePlaceholder = result.params.messages[0]?.content[1]
    expect(imagePlaceholder?.type).toBe("text")
    if (imagePlaceholder?.type === "text") {
      expect(imagePlaceholder.text).toContain("[Image:")
      expect(imagePlaceholder.text).toContain("image/png")
    }
  })

  it("maps stop_sequences to Command Code stop", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END", "STOP"],
      max_tokens: 4096,
    })

    expect(result.params.stop).toEqual(["END", "STOP"])
  })

  it("maps tool_choice types correctly", () => {
    // auto
    const r1 = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" },
      max_tokens: 4096,
    })
    expect(r1.params.tool_choice).toBe("auto")

    // any -> required
    const r2 = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
      max_tokens: 4096,
    })
    expect(r2.params.tool_choice).toBe("required")

    // none
    const r3 = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" },
      max_tokens: 4096,
    })
    expect(r3.params.tool_choice).toBe("none")

    // specific tool
    const r4 = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "read_file" },
      max_tokens: 4096,
    })
    expect(r4.params.tool_choice).toEqual({
      type: "function",
      function: { name: "read_file" },
    })
  })
})

describe("anthropicMessagesFromCommandCodeEvents", () => {
  it("converts text events into a complete Anthropic message", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " World" },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 5 } },
      ],
      { messageId: "msg_test", model: "claude-sonnet-4-6" },
    )

    expect(response.id).toBe("msg_test")
    expect(response.type).toBe("message")
    expect(response.role).toBe("assistant")
    expect(response.model).toBe("claude-sonnet-4-6")
    expect(response.stop_reason).toBe("end_turn")
    expect(response.content).toEqual([{ type: "text", text: "Hello World" }])
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it("converts tool use events into Anthropic tool_use blocks", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        {
          type: "tool-input-start",
          id: "call_1",
          toolName: "read_file",
        },
        { type: "tool-input-delta", id: "call_1", delta: '{"path":' },
        { type: "tool-input-delta", id: "call_1", delta: '"README.md"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 5, outputTokens: 3 },
        },
      ],
      { messageId: "msg_test", model: "claude-sonnet-4-6" },
    )

    expect(response.stop_reason).toBe("tool_use")
    expect(response.content).toHaveLength(1)
    expect(response.content[0]?.type).toBe("tool_use")
    if (response.content[0]?.type === "tool_use") {
      expect(response.content[0].id).toBe("call_1")
      expect(response.content[0].name).toBe("read_file")
      expect(response.content[0].input).toEqual({})
    }
  })

  it("handles mixed text + tool use events", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        { type: "text-delta", text: "Let me check." },
        { type: "text-end" },
        {
          type: "tool-input-start",
          id: "call_1",
          toolName: "read_file",
        },
        { type: "tool-input-delta", id: "call_1", delta: '{"path":"a.txt"}' },
        { type: "tool-input-end", id: "call_1" },
        { type: "finish", finishReason: "tool-calls" },
      ],
      { messageId: "msg_test", model: "claude-sonnet-4-6" },
    )

    expect(response.content).toHaveLength(2)
    expect(response.content[0]).toEqual({ type: "text", text: "Let me check." })
    expect(response.content[1]?.type).toBe("tool_use")
  })

  it("handles complete tool-call event (non-streamed)", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "bash",
          input: { cmd: "ls -la" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 5, outputTokens: 2 },
        },
      ],
      { messageId: "msg_test", model: "claude-sonnet-4-6" },
    )

    expect(response.stop_reason).toBe("tool_use")
    expect(response.content).toHaveLength(1)
    if (response.content[0]?.type === "tool_use") {
      expect(response.content[0].id).toBe("call_2")
      expect(response.content[0].name).toBe("bash")
      expect(response.content[0].input).toEqual({ cmd: "ls -la" })
    }
  })

  it("maps max_tokens finish reason correctly", () => {
    const response = anthropicMessagesFromCommandCodeEvents([
      { type: "text-delta", text: "truncated" },
      {
        type: "finish",
        finishReason: "max_tokens",
        totalUsage: { inputTokens: 100, outputTokens: 500 },
      },
    ])

    expect(response.stop_reason).toBe("max_tokens")
  })
})
