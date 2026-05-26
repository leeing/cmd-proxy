import { once } from "node:events"
import type { Server } from "node:http"

import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../src/config.ts"
import { createProxyServer } from "../src/http.ts"
import { ResponseStore } from "../src/response-store.ts"

const servers: Server[] = []

function commandCodeResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
        controller.close()
      },
    }),
    { status },
  )
}

async function startProxy(
  fetchImpl: typeof fetch,
  store?: ResponseStore,
  overrides: Partial<AppConfig> = {},
): Promise<string> {
  const config: AppConfig = {
    apiKey: "user_fixed",
    commandCodeApiBase: "https://commandcode.test",
    port: 0,
    logLevel: "silent",
    authMode: "fixed",
    upstreamTimeoutMs: 300_000,
    ...overrides,
  }
  const server = createProxyServer({
    config,
    logger: pino({ level: "silent" }),
    fetchImpl,
    ...(store ? { store } : {}),
  })
  servers.push(server)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address")
  return `http://127.0.0.1:${address.port}`
}

async function sseEvents(response: Response): Promise<unknown[]> {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter(Boolean)
    .flatMap((frame) => {
      const lines = frame.split("\n").filter(Boolean)
      const dataLine = lines.find((line) => line.startsWith("data: "))
      return dataLine ? [dataLine.slice(6)] : []
    })
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown)
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

describe("createProxyServer", () => {
  it("streams Responses API events over HTTP SSE", async () => {
    let upstreamHeaders: NonNullable<Parameters<typeof fetch>[1]>["headers"] | undefined
    const fetchImpl = ((_input, init) => {
      upstreamHeaders = init?.headers
      return Promise.resolve(
        commandCodeResponse([
          JSON.stringify({ type: "text-delta", text: "hello" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ]),
      )
    }) satisfies typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer client_dummy", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", input: "hi", stream: true }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = await sseEvents(response)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response.created" }),
        expect.objectContaining({ type: "response.output_text.delta", delta: "hello" }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    )
    expect(upstreamHeaders).toMatchObject({
      Authorization: "Bearer user_fixed",
    })
  })

  it("returns non-streaming chat completions over HTTP", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    })
  })

  it("maps invalid JSON bodies to OpenAI-style request errors", async () => {
    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "Invalid JSON request body",
        type: "invalid_request_error",
        code: "invalid_json",
        param: null,
      },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("maps upstream failures to OpenAI-style errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 })) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "hi" }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        message: "Command Code API error 401: nope",
        type: "authentication_error",
        code: "upstream_401",
        param: null,
      },
    })
  })

  it("returns 501 for storage endpoints when no store configured", async () => {
    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    for (const [path, method] of [
      ["/v1/responses/resp_test", "GET"],
      ["/v1/responses/resp_test/input_items", "GET"],
      ["/v1/responses/resp_test/cancel", "POST"],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, { method })
      expect(response.status).toBe(501)
      expect(await response.json()).toEqual({
        error: {
          message: "Response storage is not configured for this proxy instance",
          type: "invalid_request_error",
          code: "storage_unavailable",
          param: null,
        },
      })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("returns compact and input_tokens without store", async () => {
    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const compactResponse = await fetch(`${baseUrl}/v1/responses/compact`, { method: "POST" })
    expect(compactResponse.status).toBe(200)
    expect(await compactResponse.json()).toMatchObject({ object: "response.compacted" })

    const tokensResponse = await fetch(`${baseUrl}/v1/responses/input_tokens`, { method: "POST" })
    expect(tokensResponse.status).toBe(200)
    expect(await tokensResponse.json()).toEqual({ input_tokens: 0 })
  })

  it("stores and retrieves Responses via store", async () => {
    const store = new ResponseStore()
    store.store("resp_test", {
      response: { id: "resp_test", object: "response", status: "completed" },
      input: "hello",
      instructions: "Be concise.",
      model: "deepseek-v4-pro",
      createdAt: 1,
    })

    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch
    const baseUrl = await startProxy(fetchImpl, store)

    // GET /v1/responses/resp_test
    const getResponse = await fetch(`${baseUrl}/v1/responses/resp_test`)
    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toEqual({
      id: "resp_test",
      object: "response",
      status: "completed",
    })

    // GET /v1/responses/resp_test/input_items
    const itemsResponse = await fetch(`${baseUrl}/v1/responses/resp_test/input_items`)
    expect(itemsResponse.status).toBe(200)
    expect(await itemsResponse.json()).toEqual({
      object: "list",
      data: ["hello"],
      first_id: "hello",
      last_id: "hello",
      has_more: false,
    })

    // POST /v1/responses/resp_test/cancel
    const cancelResponse = await fetch(`${baseUrl}/v1/responses/resp_test/cancel`, {
      method: "POST",
    })
    expect(cancelResponse.status).toBe(200)
    expect(await cancelResponse.json()).toMatchObject({ id: "resp_test" })

    // GET missing response
    const missing = await fetch(`${baseUrl}/v1/responses/nonexistent`)
    expect(missing.status).toBe(404)
  })

  it("injects previous_response_id output into request context", async () => {
    const store = new ResponseStore()
    store.store("prev_resp", {
      response: {
        id: "prev_resp",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Previous answer" }],
          },
        ],
      },
      input: "original question",
      instructions: "Be helpful.",
      model: "deepseek-v4-pro",
      createdAt: 1,
    })

    let capturedPayload: unknown
    const fetchImpl = ((_input, init) => {
      capturedPayload = JSON.parse((init?.body ?? "{}") as string)
      return Promise.resolve(
        commandCodeResponse([
          JSON.stringify({ type: "text-delta", text: "new answer" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ]),
      )
    }) satisfies typeof fetch
    const baseUrl = await startProxy(fetchImpl, store)

    await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "follow-up",
        previous_response_id: "prev_resp",
        stream: false,
      }),
    })

    // Verify the previous output was injected into messages
    const payload = capturedPayload as Record<string, unknown> | undefined
    const params = payload?.params as Record<string, unknown> | undefined
    const messages = params?.messages as Array<Record<string, unknown>> | undefined
    expect(messages?.length).toBeGreaterThan(1)
    expect(messages?.some((m) => m.role === "assistant")).toBe(true)
  })

  it("streams Messages API events over HTTP SSE", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 3 },
        }),
      ]),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer client_dummy",
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = await sseEvents(response)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message_start" }),
        expect.objectContaining({ type: "content_block_delta" }),
        expect.objectContaining({ type: "content_block_stop" }),
        expect.objectContaining({ type: "message_delta" }),
        expect.objectContaining({ type: "message_stop" }),
      ]),
    )
  })

  it("returns non-streaming Messages response over HTTP", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 10, outputTokens: 5 },
        }),
      ]),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
  })

  it("maps Messages upstream errors to Anthropic error format", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      type: "error",
      error: {
        type: "authentication_error",
      },
    })
  })

  it("forwards x-api-key header to upstream in pass_through mode", async () => {
    let upstreamHeaders: Record<string, string> | undefined
    const fetchImpl = ((_input, init) => {
      upstreamHeaders = init?.headers as Record<string, string> | undefined
      return Promise.resolve(
        commandCodeResponse([
          JSON.stringify({ type: "text-delta", text: "hello" }),
          JSON.stringify({ type: "finish", finishReason: "stop" }),
        ]),
      )
    }) satisfies typeof fetch
    const baseUrl = await startProxy(fetchImpl, undefined, { authMode: "pass_through" })

    await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "client_key_from_sdk",
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      }),
    })

    expect(upstreamHeaders?.Authorization).toBe("Bearer client_key_from_sdk")
  })

  it("streams Chat Completions over HTTP SSE with reasoning_content", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "reasoning-delta", text: "Thinking..." }),
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 3 },
        }),
      ]),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = await sseEvents(response)
    const deltas = events.flatMap((e) => {
      const chunk = e as { choices?: Array<{ delta?: Record<string, unknown> }> }
      return chunk.choices?.[0]?.delta ? [chunk.choices[0].delta] : []
    })
    expect(deltas.some((d) => d.reasoning_content === "Thinking...")).toBe(true)
    expect(deltas.some((d) => d.content === "hello")).toBe(true)
  })

  it("includes usage chunk in chat completions stream when stream_options.include_usage is set", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "text-delta", text: "hi" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 2 },
        }),
      ]),
    ) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const events = await sseEvents(response)
    expect(events.some((e) => (e as Record<string, unknown>).usage !== undefined)).toBe(true)
  })

  it("passes upstream 5xx errors as server_error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 })) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      }),
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { type: "server_error", code: "upstream_502" },
    })
  })
})
