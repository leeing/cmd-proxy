import { describe, expect, it } from "vitest"

import { parseCommandCodeStreamChunk } from "../src/command-code-stream.ts"

describe("parseCommandCodeStreamChunk", () => {
  it("parses plain JSON lines and SSE data lines while carrying partial buffers", () => {
    const first = parseCommandCodeStreamChunk(
      'data: {"type":"text-delta","text":"he"}\n{"type":"text-delta"',
      "",
    )
    const second = parseCommandCodeStreamChunk(',"text":"llo"}\n: keepalive\n', first.buffer)

    expect(first.events).toEqual([{ type: "text-delta", text: "he" }])
    expect(second.events).toEqual([{ type: "text-delta", text: "llo" }])
    expect(second.buffer).toBe("")
  })
})
