import type { CommandCodeStreamEvent } from "./types.ts"
import { isRecord } from "./utils.ts"

export interface ParsedCommandCodeChunk {
  events: CommandCodeStreamEvent[]
  buffer: string
}

export function parseCommandCodeStreamChunk(
  chunk: string,
  previousBuffer: string,
): ParsedCommandCodeChunk {
  const combined = `${previousBuffer}${chunk}`
  const lines = combined.split("\n")
  const buffer = lines.pop() ?? ""
  const events = lines.flatMap(parseCommandCodeStreamLine)
  return { events, buffer }
}

export function parseCommandCodeStreamRemainder(buffer: string): CommandCodeStreamEvent[] {
  return parseCommandCodeStreamLine(buffer)
}

function parseCommandCodeStreamLine(line: string): CommandCodeStreamEvent[] {
  let trimmed = line.trim()
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return []
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim()
  if (!trimmed || trimmed === "[DONE]") return []

  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? [parsed] : []
  } catch (error) {
    if (error instanceof SyntaxError) return []
    throw error
  }
}
