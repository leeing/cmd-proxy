import { z } from "zod"

const envSchema = z.object({
  COMMANDCODE_API_KEY: z.string().min(1),
  COMMANDCODE_API_BASE: z.url().default("https://api.commandcode.ai"),
  CMD_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(8888),
  CMD_PROXY_AUTH_MODE: z.enum(["pass_through", "fixed", "none"]).default("pass_through"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CMD_PROXY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(5000).default(300_000),
})

export interface AppConfig {
  apiKey: string
  commandCodeApiBase: string
  port: number
  authMode: "pass_through" | "fixed" | "none"
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"
  upstreamTimeoutMs: number
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.parse(env)
  return {
    apiKey: parsed.COMMANDCODE_API_KEY,
    commandCodeApiBase: parsed.COMMANDCODE_API_BASE,
    port: parsed.CMD_PROXY_PORT,
    authMode: parsed.CMD_PROXY_AUTH_MODE,
    logLevel: parsed.LOG_LEVEL,
    upstreamTimeoutMs: parsed.CMD_PROXY_UPSTREAM_TIMEOUT_MS,
  }
}
