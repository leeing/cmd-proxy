import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable, Writable } from "node:stream"

import pino from "pino"
import { describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../src/config.ts"
import { handleRequest } from "../src/http.ts"
import { ResponseStore } from "../src/response-store.ts"

function mockConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "user_fixed",
    apiBase: "https://commandcode.test",
    port: 8888,
    logLevel: "silent",
    authMode: "fixed",
    upstreamTimeoutMs: 300_000,
    memory: "",
    taste: "",
    cliVersion: "0.24.1",
    cliEnvironment: "production",
    tasteLearning: "false",
    coFlag: "false",
    ...overrides,
  }
}

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

interface MockRes {
  status: number
  headers: Record<string, string>
  body: string
}

function mockResponse(): { res: ServerResponse; result: () => MockRes } {
  const state: MockRes = { status: 200, headers: {}, body: "" }
  const chunks: Buffer[] = []

  const writable = new Writable({
    write(chunk, _enc, cb) {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk))
      else if (Buffer.isBuffer(chunk)) chunks.push(chunk)
      cb()
    },
  })

  const res = writable as unknown as ServerResponse

  res.statusCode = 200

  res.writeHead = ((statusCode: number, headers?: Record<string, string>) => {
    state.status = statusCode
    if (headers) {
      for (const [k, v] of Object.entries(headers)) state.headers[k.toLowerCase()] = v
    }
    return res
  }) as ServerResponse["writeHead"]

  res.setHeader = ((name: string, value: string) => {
    state.headers[name.toLowerCase()] = value
    return res
  }) as ServerResponse["setHeader"]

  res.getHeader = (() => undefined) as ServerResponse["getHeader"]

  res.flushHeaders = (() => {
    /* no-op mock */
  }) as ServerResponse["flushHeaders"]

  return {
    res,
    result: () => {
      state.body = Buffer.concat(chunks).toString()
      return state
    },
  }
}

function mockReq(
  method: string,
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): IncomingMessage {
  const bodyContent = body ?? ""
  const readable = Readable.from([Buffer.from(bodyContent)])
  const req = readable as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = { "content-type": "application/json", ...extraHeaders }
  return req
}

const logger = pino({ level: "silent" })

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

    const { res, result } = mockResponse()
    const req = mockReq(
      "POST",
      "/v1/responses",
      JSON.stringify({ model: "deepseek-v4-pro", input: "hi", stream: true }),
    )

    await handleRequest(req, res, mockConfig(), logger, fetchImpl, null)
    const r = result()

    expect(r.status).toBe(200)
    expect(r.headers["content-type"]).toContain("text/event-stream")
    expect(r.body).toContain("response.created")
    expect(r.body).toContain("response.output_text.delta")
    expect(r.body).toContain("hello")
    expect(r.body).toContain("response.completed")
    expect(upstreamHeaders).toMatchObject({ Authorization: "Bearer user_fixed" })
  })

  it("returns non-streaming chat completions over HTTP", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([
        JSON.stringify({ type: "text-delta", text: "hello" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]),
    ) as typeof fetch

    const { res, result } = mockResponse()
    const req = mockReq(
      "POST",
      "/v1/chat/completions",
      JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    )

    await handleRequest(req, res, mockConfig(), logger, fetchImpl, null)
    const r = result()
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    })
  })

  it("maps invalid JSON bodies to OpenAI-style request errors", async () => {
    const fetchImpl = vi.fn(async () => commandCodeResponse([])) as typeof fetch

    const { res, result } = mockResponse()
    const req = mockReq("POST", "/v1/responses", "{")

    await handleRequest(req, res, mockConfig(), logger, fetchImpl, null)
    const r = result()
    expect(r.status).toBe(400)
    expect(JSON.parse(r.body)).toEqual({
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

    const { res, result } = mockResponse()
    const req = mockReq("POST", "/v1/responses", JSON.stringify({ input: "hi" }))

    await handleRequest(req, res, mockConfig(), logger, fetchImpl, null)
    const r = result()
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toEqual({
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

    for (const [p, method] of [
      ["/v1/responses/resp_test", "GET"],
      ["/v1/responses/resp_test/input_items", "GET"],
      ["/v1/responses/resp_test/cancel", "POST"],
    ] as const) {
      const { res, result } = mockResponse()
      await handleRequest(mockReq(method, p), res, mockConfig(), logger, fetchImpl, null)
      const r = result()
      expect(r.status).toBe(501)
      expect(JSON.parse(r.body)).toEqual({
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

    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("POST", "/v1/responses/compact"),
        res,
        mockConfig(),
        logger,
        fetchImpl,
        null,
      )
      expect(result().status).toBe(200)
      expect(JSON.parse(result().body)).toMatchObject({ object: "response.compacted" })
    }
    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("POST", "/v1/responses/input_tokens"),
        res,
        mockConfig(),
        logger,
        fetchImpl,
        null,
      )
      expect(result().status).toBe(200)
      expect(JSON.parse(result().body)).toEqual({ input_tokens: 0 })
    }
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
    const cfg = mockConfig()

    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("GET", "/v1/responses/resp_test"),
        res,
        cfg,
        logger,
        fetchImpl,
        store,
      )
      expect(result().status).toBe(200)
      expect(JSON.parse(result().body)).toEqual({
        id: "resp_test",
        object: "response",
        status: "completed",
      })
    }
    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("GET", "/v1/responses/resp_test/input_items"),
        res,
        cfg,
        logger,
        fetchImpl,
        store,
      )
      expect(result().status).toBe(200)
      expect(JSON.parse(result().body)).toMatchObject({ object: "list", data: ["hello"] })
    }
    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("POST", "/v1/responses/resp_test/cancel"),
        res,
        cfg,
        logger,
        fetchImpl,
        store,
      )
      expect(result().status).toBe(200)
      expect(JSON.parse(result().body)).toMatchObject({ id: "resp_test" })
    }
    {
      const { res, result } = mockResponse()
      await handleRequest(
        mockReq("GET", "/v1/responses/nonexistent"),
        res,
        cfg,
        logger,
        fetchImpl,
        store,
      )
      expect(result().status).toBe(404)
    }
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

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/responses",
        JSON.stringify({ input: "follow-up", previous_response_id: "prev_resp", stream: false }),
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      store,
    )
    expect(result().status).toBe(200)

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

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/messages",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
          stream: true,
        }),
        { "anthropic-version": "2023-06-01" },
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    const r = result()
    expect(r.status).toBe(200)
    expect(r.body).toContain("message_start")
    expect(r.body).toContain("content_block_delta")
    expect(r.body).toContain("content_block_stop")
    expect(r.body).toContain("message_delta")
    expect(r.body).toContain("message_stop")
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

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/messages",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
          stream: false,
        }),
        { "anthropic-version": "2023-06-01" },
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    expect(result().status).toBe(200)
    expect(JSON.parse(result().body)).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    })
  })

  it("maps Messages upstream errors to Anthropic error format", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as typeof fetch

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/messages",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
        }),
        { "anthropic-version": "2023-06-01" },
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    const r = result()
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    })
  })

  it("forwards matching x-api-key to upstream in pass_through mode", async () => {
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

    const { res } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/messages",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
        }),
        { "x-api-key": "user_fixed", "anthropic-version": "2023-06-01" },
      ),
      res,
      mockConfig({ authMode: "pass_through" }),
      logger,
      fetchImpl,
      null,
    )
    expect(upstreamHeaders?.Authorization).toBe("Bearer user_fixed")
  })

  it("rejects mismatched x-api-key in pass_through mode", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([JSON.stringify({ type: "text-delta", text: "hello" })]),
    ) as typeof fetch

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/messages",
        JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
        }),
        { "x-api-key": "wrong_key", "anthropic-version": "2023-06-01" },
      ),
      res,
      mockConfig({ authMode: "pass_through" }),
      logger,
      fetchImpl,
      null,
    )
    const r = result()
    expect(r.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects mismatched Bearer token in pass_through mode", async () => {
    const fetchImpl = vi.fn(async () =>
      commandCodeResponse([JSON.stringify({ type: "text-delta", text: "hello" })]),
    ) as typeof fetch

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
        { authorization: "Bearer wrong_key" },
      ),
      res,
      mockConfig({ authMode: "pass_through" }),
      logger,
      fetchImpl,
      null,
    )
    expect(result().status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("allows pass_through with no client key (falls through to config key)", async () => {
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

    const { res } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      ),
      res,
      mockConfig({ authMode: "pass_through" }),
      logger,
      fetchImpl,
      null,
    )
    expect(upstreamHeaders?.Authorization).toBe("Bearer user_fixed")
  })

  it("always uses config key in fixed mode regardless of client key", async () => {
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

    const { res } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
        { authorization: "Bearer random_client_key" },
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    expect(upstreamHeaders?.Authorization).toBe("Bearer user_fixed")
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

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    const r = result()
    expect(r.status).toBe(200)
    expect(r.body).toContain("reasoning_content")
    expect(r.body).toContain("Thinking...")
    expect(r.body).toContain("hello")
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

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    expect(result().status).toBe(200)
    expect(result().body).toContain("usage")
  })

  it("passes upstream 5xx errors as server_error", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 })) as typeof fetch

    const { res, result } = mockResponse()
    await handleRequest(
      mockReq(
        "POST",
        "/v1/chat/completions",
        JSON.stringify({ model: "deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
      ),
      res,
      mockConfig(),
      logger,
      fetchImpl,
      null,
    )
    const r = result()
    expect(r.status).toBe(502)
    expect(JSON.parse(r.body)).toMatchObject({
      error: { type: "server_error", code: "upstream_502" },
    })
  })
})
