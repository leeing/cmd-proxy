import { describe, expect, it } from "vitest"

import { modelList, resolveModel } from "../src/models.ts"

describe("resolveModel", () => {
  it("resolves known aliases to full provider paths", () => {
    expect(resolveModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro")
    expect(resolveModel("deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash")
    expect(resolveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4-7")
    expect(resolveModel("gpt-5.5")).toBe("gpt-5.5")
  })

  it("resolves short aliases", () => {
    expect(resolveModel("deepseek-pro")).toBe("deepseek/deepseek-v4-pro")
    expect(resolveModel("deepseek-flash")).toBe("deepseek/deepseek-v4-flash")
  })

  it("resolves version-agnostic aliases to latest", () => {
    expect(resolveModel("claude-sonnet-4")).toBe("claude-sonnet-4-6")
    expect(resolveModel("claude-opus-4")).toBe("claude-opus-4-7")
  })

  it("resolves case-insensitively", () => {
    expect(resolveModel("DeepSeek-V4-Pro")).toBe("deepseek/deepseek-v4-pro")
  })

  it("passes through unknown models as-is", () => {
    expect(resolveModel("some-unknown-model")).toBe("some-unknown-model")
  })

  it("passes through strings containing '/' directly", () => {
    expect(resolveModel("some-provider/some-model")).toBe("some-provider/some-model")
  })
})

describe("modelList", () => {
  it("returns a list of model objects with correct shape", () => {
    const list = modelList()
    expect(list.length).toBeGreaterThan(0)
    for (const model of list) {
      expect(model).toMatchObject({
        object: "model",
        owned_by: "commandcode",
      })
      expect(typeof model.id).toBe("string")
      expect(typeof model.created).toBe("number")
    }
  })
})
