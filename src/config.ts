import { z } from "zod"

const envSchema = z.object({
  CMD_API_KEY: z.string().min(1),
  CMD_API_BASE: z.url().default("https://api.commandcode.ai"),
  CMD_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(8888),
  CMD_PROXY_MEMORY: z.string().default(""),
  CMD_PROXY_TASTE: z.string().default(""),
  CMD_PROXY_AUTH_MODE: z.enum(["pass_through", "fixed", "none"]).default("pass_through"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CMD_PROXY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(5000).default(300_000),
  CMD_PROXY_CLI_VERSION: z.string().default("0.24.1"),
  CMD_PROXY_CLI_ENVIRONMENT: z.string().default("production"),
  CMD_PROXY_TASTE_LEARNING: z.string().default("false"),
  CMD_PROXY_CO_FLAG: z.string().default("false"),
  CMD_PROXY_MODEL_MAP: z.string().default(""),
})

export interface AppConfig {
  apiKey: string
  apiBase: string
  port: number
  memory: string
  taste: string
  authMode: "pass_through" | "fixed" | "none"
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent"
  upstreamTimeoutMs: number
  cliVersion: string
  cliEnvironment: string
  tasteLearning: string
  coFlag: string
  customModelMap: Record<string, string>
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.parse(env)
  return {
    apiKey: parsed.CMD_API_KEY,
    apiBase: parsed.CMD_API_BASE,
    memory: parsed.CMD_PROXY_MEMORY,
    taste: parsed.CMD_PROXY_TASTE,
    port: parsed.CMD_PROXY_PORT,
    authMode: parsed.CMD_PROXY_AUTH_MODE,
    logLevel: parsed.LOG_LEVEL,
    upstreamTimeoutMs: parsed.CMD_PROXY_UPSTREAM_TIMEOUT_MS,
    cliVersion: parsed.CMD_PROXY_CLI_VERSION,
    cliEnvironment: parsed.CMD_PROXY_CLI_ENVIRONMENT,
    tasteLearning: parsed.CMD_PROXY_TASTE_LEARNING,
    coFlag: parsed.CMD_PROXY_CO_FLAG,
    customModelMap: parseModelMap(parsed.CMD_PROXY_MODEL_MAP),
  }
}

function parseModelMap(raw: string): Record<string, string> {
  if (!raw) return {}
  const map: Record<string, string> = {}
  for (const pair of raw.split(";")) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf("=")
    if (eq < 1) continue
    const alias = trimmed.slice(0, eq).trim()
    const upstream = trimmed.slice(eq + 1).trim()
    if (alias && upstream) map[alias] = upstream
  }
  return map
}
