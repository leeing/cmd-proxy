import { once } from "node:events"
import type { Server } from "node:http"

import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../src/config.ts"
import { createProxyServer } from "../src/http.ts"

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

async function startProxy(fetchImpl: typeof fetch): Promise<string> {
  const config: AppConfig = {
    apiKey: "user_fixed",
    commandCodeApiBase: "https://commandcode.test",
    port: 0,
    logLevel: "silent",
    authMode: "fixed",
  }
  const server = createProxyServer({ config, logger: pino({ level: "silent" }), fetchImpl })
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

  it("returns explicit unsupported errors for Responses storage endpoints", async () => {
    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch
    const baseUrl = await startProxy(fetchImpl)

    for (const path of [
      "/v1/responses/resp_test",
      "/v1/responses/resp_test/input_items",
      "/v1/responses/resp_test/cancel",
      "/v1/responses/compact",
      "/v1/responses/input_tokens",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method:
          path.endsWith("/cancel") || path.endsWith("/compact") || path.endsWith("/input_tokens")
            ? "POST"
            : "GET",
      })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: {
          message: "Responses storage endpoints are not supported by cmd-proxy",
          type: "invalid_request_error",
          code: "unsupported_endpoint",
          param: null,
        },
      })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
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
})
