#!/usr/bin/env tsx
import process from "node:process"

import pino from "pino"

import { loadConfig } from "./config.ts"
import { createProxyServer } from "./http.ts"

const SHUTDOWN_TIMEOUT_MS = 10_000

async function main(): Promise<void> {
  const config = loadConfig(process.env)
  const logger = pino({ level: config.logLevel })
  const server = createProxyServer({ config, logger })

  const activeConnections = new Set<{ destroy(): void }>()

  server.on("connection", (conn) => {
    activeConnections.add(conn)
    conn.once("close", () => activeConnections.delete(conn))
  })

  await new Promise<void>((resolve) => {
    server.listen(config.port, resolve)
  })

  logger.info(
    {
      baseUrl: `http://localhost:${config.port}/v1`,
      upstream: config.apiBase,
    },
    "cmd-proxy listening",
  )

  let shuttingDown = false

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    logger.info({ signal }, "Shutting down gracefully")

    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )

    if (activeConnections.size > 0) {
      logger.info({ count: activeConnections.size }, "Waiting for active connections to finish")
      await Promise.race([
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (activeConnections.size === 0) {
              clearInterval(check)
              resolve()
            }
          }, 100)
        }),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ])

      for (const conn of activeConnections) {
        conn.destroy()
      }
    }

    logger.info("Shutdown complete")
    process.exit(0)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((error: unknown) => {
  const logger = pino({ level: "error" })
  logger.error({ error }, "cmd-proxy failed to start")
  process.exit(1)
})
