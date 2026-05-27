import { describe, expect, it } from "vitest"

import { modelList, resolveModel } from "../src/models.ts"

describe("resolveModel", () => {
  it("resolves known aliases to full provider paths", () => {
    expect(resolveModel("deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro")
    expect(resolveModel("deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash")
    expect(resolveModel("kimi-k2.6")).toBe("moonshotai/Kimi-K2.6")
    expect(resolveModel("glm-5.1")).toBe("zai-org/GLM-5.1")
    expect(resolveModel("qwen-3.7-max")).toBe("Qwen/Qwen3.7-Max-Preview")
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
