import { describe, expect, it } from "vitest"

import { loadConfig } from "../src/config.ts"

describe("loadConfig", () => {
  it("validates and normalizes environment configuration", () => {
    const config = loadConfig({
      CMD_API_KEY: "user_test",
      CMD_PROXY_PORT: "8899",
      CMD_API_BASE: "https://example.test",
      LOG_LEVEL: "debug",
    })

    expect(config.apiKey).toBe("user_test")
    expect(config.port).toBe(8899)
    expect(config.apiBase).toBe("https://example.test")
    expect(config.logLevel).toBe("debug")
    expect(config.authMode).toBe("pass_through")
  })

  it("rejects missing Command Code credentials at startup", () => {
    expect(() => loadConfig({})).toThrow(/CMD_API_KEY/)
  })

  it("supports fixed upstream authentication mode", () => {
    const config = loadConfig({
      CMD_API_KEY: "user_fixed",
      CMD_PROXY_AUTH_MODE: "fixed",
    })

    expect(config.authMode).toBe("fixed")
  })

  it("supports none authentication mode", () => {
    const config = loadConfig({
      CMD_API_KEY: "user_fixed",
      CMD_PROXY_AUTH_MODE: "none",
    })

    expect(config.authMode).toBe("none")
  })

  it("applies default upstream timeout", () => {
    const config = loadConfig({ CMD_API_KEY: "user_fixed" })

    expect(config.upstreamTimeoutMs).toBe(300_000)
  })

  it("applies custom upstream timeout", () => {
    const config = loadConfig({
      CMD_API_KEY: "user_fixed",
      CMD_PROXY_UPSTREAM_TIMEOUT_MS: "60000",
    })

    expect(config.upstreamTimeoutMs).toBe(60000)
  })
})
