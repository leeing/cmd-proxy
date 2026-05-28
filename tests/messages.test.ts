import { describe, expect, it } from "vitest"

import {
  anthropicMessagesFromCommandCodeEvents,
  convertAnthropicRequestToCommandCode,
  createAnthropicMessagesStreamTranslator,
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

  it("clamps temperature > 1 to 1", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      temperature: 2,
    })
    expect(result.params.temperature).toBe(1)
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
        { role: "user", content: "Run the command" },
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
    expect(result.params.messages).toHaveLength(4)
    expect(result.params.messages[1]?.role).toBe("assistant")
    expect(result.params.messages[2]?.role).toBe("tool")
    expect(result.params.messages[3]?.role).toBe("user")
    expect(result.params.messages[3]?.content[0]?.type).toBe("text")
  })

  it("converts tool_result with error flag", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "Run ls" },
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

    const toolResult = expectToolResult(result.params.messages[2]?.content[0])
    expect(toolResult.output.type).toBe("error-text")
  })

  it("converts tool_result with content arrays", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "Run command" },
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

    const toolResult = expectToolResult(result.params.messages[2]?.content[0])
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

  it("passes image blocks through as image content", () => {
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
    const imageBlock = result.params.messages[0]?.content[1]
    expect(imageBlock?.type).toBe("image")
    if (imageBlock?.type === "image") {
      expect(imageBlock.source.type).toBe("base64")
      if (imageBlock.source.type === "base64") {
        expect(imageBlock.source.media_type).toBe("image/png")
        expect(imageBlock.source.data).toBe("AAAA")
      }
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

  it("maps thinking config to Command Code params", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 16000 },
      max_tokens: 4096,
    })
    expect(result.params.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    })
  })

  it("forwards top_k to Command Code params", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      top_k: 5,
      max_tokens: 4096,
    })

    expect(result.params.top_k).toBe(5)
  })

  it("passes image URL blocks through as image content", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image",
              source: { type: "url", url: "https://example.com/image.png" },
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.messages[0]?.content[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/image.png" },
    })
  })

  it("converts text document blocks into Command Code text content", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "Spec",
              source: { type: "text", media_type: "text/plain", data: "Line 1\nLine 2" },
            },
          ],
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.messages[0]?.content).toEqual([
      { type: "text", text: "Document: Spec\n\nLine 1\nLine 2" },
    ])
  })

  it("warns and drops unsupported Anthropic content blocks instead of blocking", () => {
    const warnings: string[] = []
    const result = convertAnthropicRequestToCommandCode(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", source: { type: "base64", data: "AAAA" } } as never],
          },
        ],
        max_tokens: 4096,
      },
      { onWarning: (warning) => warnings.push(warning) },
    )

    expect(result.params.messages).toEqual([])
    expect(warnings).toContain("Ignored unsupported Anthropic content block type: input_audio")
  })

  it("requires max_tokens for Anthropic Messages requests", () => {
    expect(() =>
      convertAnthropicRequestToCommandCode({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toThrow("max_tokens is required")
  })

  it("requires at least one Anthropic message", () => {
    expect(() =>
      convertAnthropicRequestToCommandCode({
        model: "claude-sonnet-4-6",
        messages: [],
        max_tokens: 4096,
      }),
    ).toThrow("messages must contain at least one message")
  })

  it("requires the first Anthropic message to use the user role", () => {
    expect(() =>
      convertAnthropicRequestToCommandCode({
        model: "claude-sonnet-4-6",
        messages: [{ role: "assistant", content: "hello" }],
        max_tokens: 4096,
      }),
    ).toThrow("messages: first message must use the user role")
  })

  it("requires Anthropic message roles to alternate", () => {
    expect(() =>
      convertAnthropicRequestToCommandCode({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: "one" },
          { role: "user", content: "two" },
        ],
        max_tokens: 4096,
      }),
    ).toThrow("messages: roles must alternate between user and assistant")
  })

  it("maps built-in Anthropic web_search tool as function tool to upstream", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      max_tokens: 4096,
    })

    expect(result.params.tools).toEqual([
      {
        type: "function",
        name: "web_search",
        description: "Search the web for current information.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "The search query" } },
          required: ["query"],
        },
      },
    ])
  })

  it("forwards lightweight Anthropic request metadata and service tier", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "u_123" },
      service_tier: "standard_only",
      max_tokens: 4096,
    })

    expect(result.params.metadata).toEqual({ user_id: "u_123" })
    expect(result.params.service_tier).toBe("standard_only")
  })

  it("warns and ignores upstream-dependent Anthropic native request fields", () => {
    const warnings: string[] = []
    const result = convertAnthropicRequestToCommandCode(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ type: "url", url: "https://mcp.example" }],
        max_tokens: 4096,
      },
      { onWarning: (warning) => warnings.push(warning) },
    )

    expect(result.params.messages[0]?.role).toBe("user")
    expect(warnings).toContain(
      "Ignored Anthropic request field mcp_servers because it requires anthropic-beta: mcp-client-2025-11-20",
    )
  })

  it("warns when beta fields are enabled but not implemented", () => {
    const warnings: string[] = []
    const result = convertAnthropicRequestToCommandCode(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        mcp_servers: [{ type: "url", url: "https://mcp.example" }],
        max_tokens: 4096,
      },
      { betaHeaders: ["mcp-client-2025-11-20"], onWarning: (warning) => warnings.push(warning) },
    )

    expect(result.params.messages[0]?.role).toBe("user")
    expect(warnings).toContain("Ignored unsupported Anthropic request field: mcp_servers")
  })

  it("accepts context_management when the Anthropic beta is enabled", () => {
    const result = convertAnthropicRequestToCommandCode(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        context_management: {
          edits: [
            {
              type: "clear_tool_uses_20250919",
              trigger: { type: "input_tokens", value: 30000 },
              keep: { type: "tool_uses", value: 5 },
            },
          ],
        },
        max_tokens: 4096,
      },
      { betaHeaders: ["context-management-2025-06-27"] },
    )

    expect(result.params.messages[0]?.role).toBe("user")
  })

  it("preserves cache_control on text blocks, tool results, and tools", () => {
    const result = convertAnthropicRequestToCommandCode({
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Cached prompt", cache_control: { type: "ephemeral" } },
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "result",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral" },
        },
      ],
      max_tokens: 4096,
    })

    expect(result.params.tools[0]?.cache_control).toEqual({ type: "ephemeral" })
    const toolMessage = result.params.messages[0]
    expect(toolMessage?.role).toBe("tool")
    const toolContent = toolMessage?.content[0]
    expect(toolContent).toHaveProperty("cache_control", { type: "ephemeral" })
    const userContent = result.params.messages[1]?.content[0]
    expect(userContent).toHaveProperty("cache_control", { type: "ephemeral" })
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
      expect(response.content[0].input).toEqual({ path: "README.md" })
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

  it("converts reasoning-delta into thinking content block", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        { type: "reasoning-delta", text: "Let me analyze" },
        { type: "reasoning-delta", text: " the problem." },
        { type: "reasoning-end" },
        { type: "text-delta", text: "The answer is 42." },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 5, outputTokens: 10 } },
      ],
      { messageId: "msg_test", model: "claude-sonnet-4-6" },
    )

    expect(response.content).toHaveLength(2)
    expect(response.content[0]?.type).toBe("thinking")
    if (response.content[0]?.type === "thinking") {
      expect(response.content[0].thinking).toBe("Let me analyze the problem.")
    }
    expect(response.content[1]?.type).toBe("text")
  })

  it("adds thinking signature deltas to streaming and final thinking blocks", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    t.push({ type: "reasoning-delta", text: "secret" })
    const signatureEvents = t.push({ type: "reasoning-signature-delta", signature: "sig_123" })
    t.push({ type: "reasoning-end" })
    const { response } = t.finish()

    expect(signatureEvents[0]).toMatchObject({
      type: "content_block_delta",
      delta: { type: "signature_delta", signature: "sig_123" },
    })
    expect(response.content[0]).toEqual({
      type: "thinking",
      thinking: "secret",
      signature: "sig_123",
    })
  })

  it("uses early usage events for message_start usage", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    const usageEvents = t.push({
      type: "usage-start",
      totalUsage: {
        inputTokens: 25,
        outputTokens: 1,
        inputTokenDetails: { cacheCreationTokens: 5, cacheReadTokens: 10 },
      },
    })
    expect(usageEvents).toEqual([])

    const startEvents = t.push({ type: "text-delta", text: "hello" })
    expect(startEvents[0]?.message?.usage).toEqual({
      input_tokens: 25,
      output_tokens: 1,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 10,
    })
  })

  it("preserves extended usage fields in final Anthropic usage", () => {
    const response = anthropicMessagesFromCommandCodeEvents([
      { type: "text-delta", text: "answer" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {
          inputTokens: 8,
          outputTokens: 2,
          cacheCreation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
          serviceTier: "standard",
          inferenceGeo: "global",
          serverToolUse: { web_search_requests: 1 },
        },
      },
    ])

    expect(response.usage).toMatchObject({
      input_tokens: 8,
      output_tokens: 2,
      cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
      service_tier: "standard",
      inference_geo: "global",
      server_tool_use: { web_search_requests: 1 },
    })
  })

  it("maps newer Anthropic stop reasons", () => {
    for (const stopReason of ["pause_turn", "refusal", "model_context_window_exceeded"] as const) {
      const response = anthropicMessagesFromCommandCodeEvents([
        { type: "text-delta", text: "partial" },
        { type: "finish", finishReason: stopReason },
      ])

      expect(response.stop_reason).toBe(stopReason)
    }
  })

  it("closes thinking block before text starts", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        { type: "reasoning-delta", text: "Hmm" },
        { type: "text-delta", text: "Answer" },
        { type: "finish", finishReason: "stop" },
      ],
      { messageId: "msg_test" },
    )

    expect(response.content).toHaveLength(2)
    expect(response.content[0]?.type).toBe("thinking")
    expect(response.content[1]?.type).toBe("text")
  })

  it("includes cache read/creation tokens in usage", () => {
    const response = anthropicMessagesFromCommandCodeEvents(
      [
        { type: "text-delta", text: "cached answer" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 100,
            outputTokens: 10,
            inputTokenDetails: {
              cacheCreationTokens: 30,
              cacheReadTokens: 50,
            },
          },
        },
      ],
      { messageId: "msg_test" },
    )

    expect(response.usage.cache_creation_input_tokens).toBe(30)
    expect(response.usage.cache_read_input_tokens).toBe(50)
  })
})

describe("createAnthropicMessagesStreamTranslator", () => {
  it("emits content_block_start/delta/stop sequence for text", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    const e1 = t.push({ type: "text-delta", text: "hello" })
    expect(e1[0]?.type).toBe("message_start")
    expect(e1[1]?.type).toBe("content_block_start")
    expect(e1[1]?.content_block?.type).toBe("text")
    expect(e1[2]?.type).toBe("content_block_delta")
    expect(e1[2]?.delta).toEqual({ type: "text_delta", text: "hello" })

    const e2 = t.push({ type: "text-delta", text: " world" })
    expect(e2[0]?.type).toBe("content_block_delta")
    expect(e2[0]?.delta).toEqual({ type: "text_delta", text: " world" })

    const e3 = t.push({ type: "text-end" })
    expect(e3[0]?.type).toBe("content_block_stop")
  })

  it("emits content_block_start/delta/stop for thinking", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    const e1 = t.push({ type: "reasoning-delta", text: "Hmm" })
    const types1 = e1.map((e) => e.type)
    expect(types1).toEqual(["message_start", "content_block_start", "content_block_delta"])
    expect(e1[1]?.content_block?.type).toBe("thinking")
    expect(e1[2]?.delta).toEqual({ type: "thinking_delta", thinking: "Hmm" })

    const e2 = t.push({ type: "reasoning-end" })
    expect(e2[0]?.type).toBe("content_block_stop")
  })

  it("closes thinking before starting text", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    t.push({ type: "reasoning-delta", text: "think" })
    t.push({ type: "reasoning-end" })
    const events = t.push({ type: "text-delta", text: "answer" })

    // text block should start at index 1
    expect(events[0]?.type).toBe("content_block_start")
    expect(events[0]?.index).toBe(1)
    expect(events[0]?.content_block?.type).toBe("text")
  })

  it("emits Anthropic error events for upstream stream errors", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    const events = t.push({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    })

    expect(events).toEqual([
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ])
  })

  it("emits Anthropic ping events for upstream ping events", () => {
    const t = createAnthropicMessagesStreamTranslator({ messageId: "msg_test" })

    expect(t.push({ type: "ping" })).toEqual([{ type: "ping" }])
  })
})
