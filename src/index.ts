#!/usr/bin/env tsx
import process from "node:process"

import pino from "pino"

import { loadConfig } from "./config.ts"
import { createProxyServer } from "./http.ts"

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = pino({ level: config.logLevel })
  const server = createProxyServer({ config, logger })

  await new Promise<void>((resolve) => {
    server.listen(config.port, resolve)
  })

  logger.info(
    {
      baseUrl: `http://localhost:${config.port}/v1`,
      upstream: config.commandCodeApiBase,
    },
    "cmd-proxy listening",
  )
}

main().catch((error: unknown) => {
  const logger = pino({ level: "error" })
  logger.error({ error }, "cmd-proxy failed to start")
  process.exit(1)
})
