import { describe, expect, it } from "vitest"

import { ResponseStore } from "../src/response-store.ts"

describe("ResponseStore", () => {
  it("stores and retrieves responses by id", () => {
    const store = new ResponseStore()
    const entry = {
      response: { id: "resp_1", object: "response", status: "completed" },
      input: [{ type: "message", role: "user", content: "hello" }],
      instructions: "be brief",
      model: "deepseek-v4-pro",
      createdAt: 12345,
    }

    store.store("resp_1", entry)
    expect(store.get("resp_1")).toEqual(entry)
    expect(store.get("missing")).toBeUndefined()
  })

  it("registers and deregisters active requests", () => {
    const store = new ResponseStore()
    store.registerActive("resp_1", new AbortController())
    store.deregisterActive("resp_1")
    expect(store.cancel("resp_1")).toBe(false)
  })

  it("cancels active requests", () => {
    const store = new ResponseStore()
    const controller = new AbortController()
    store.registerActive("resp_1", controller)
    expect(store.cancel("resp_1")).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it("returns false for cancel on unknown id", () => {
    const store = new ResponseStore()
    expect(store.cancel("nonexistent")).toBe(false)
  })
})
