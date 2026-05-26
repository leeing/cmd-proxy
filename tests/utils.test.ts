import { describe, expect, it } from "vitest"

import {
  booleanValue,
  idWithPrefix,
  isRecord,
  numberValue,
  recordOrEmpty,
  stringValue,
  textFromUnknown,
  toJsonSchema,
  toObjectJsonSchema,
} from "../src/utils.ts"

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it("returns false for arrays, null, and primitives", () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("string")).toBe(false)
    expect(isRecord(42)).toBe(false)
    expect(isRecord(true)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
  })
})

describe("stringValue", () => {
  it("returns string values as-is", () => {
    expect(stringValue("hello")).toBe("hello")
  })

  it("returns undefined for non-strings", () => {
    expect(stringValue(42)).toBeUndefined()
    expect(stringValue(null)).toBeUndefined()
    expect(stringValue({})).toBeUndefined()
  })
})

describe("numberValue", () => {
  it("returns finite numbers", () => {
    expect(numberValue(42)).toBe(42)
    expect(numberValue(0)).toBe(0)
    expect(numberValue(-1)).toBe(-1)
  })

  it("returns undefined for NaN and Infinity", () => {
    expect(numberValue(Number.NaN)).toBeUndefined()
    expect(numberValue(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it("returns undefined for non-numbers", () => {
    expect(numberValue("42")).toBeUndefined()
    expect(numberValue(null)).toBeUndefined()
  })
})

describe("booleanValue", () => {
  it("returns boolean values as-is", () => {
    expect(booleanValue(true)).toBe(true)
    expect(booleanValue(false)).toBe(false)
  })

  it("returns undefined for non-booleans", () => {
    expect(booleanValue(1)).toBeUndefined()
    expect(booleanValue("true")).toBeUndefined()
  })
})

describe("recordOrEmpty", () => {
  it("returns records as-is", () => {
    expect(recordOrEmpty({ a: 1 })).toEqual({ a: 1 })
  })

  it("parses JSON strings into records", () => {
    expect(recordOrEmpty('{"a":1}')).toEqual({ a: 1 })
  })

  it("returns empty object for non-JSON strings", () => {
    expect(recordOrEmpty("not json")).toEqual({})
  })

  it("returns empty object for non-record JSON", () => {
    expect(recordOrEmpty("42")).toEqual({})
    expect(recordOrEmpty("[]")).toEqual({})
    expect(recordOrEmpty("null")).toEqual({})
  })

  it("returns empty object for non-string non-record values", () => {
    expect(recordOrEmpty(42)).toEqual({})
    expect(recordOrEmpty(null)).toEqual({})
  })
})

describe("textFromUnknown", () => {
  it("returns strings as-is", () => {
    expect(textFromUnknown("hello")).toBe("hello")
  })

  it("JSON-stringifies other values", () => {
    expect(textFromUnknown(42)).toBe("42")
    expect(textFromUnknown({ a: 1 })).toBe('{"a":1}')
    expect(textFromUnknown(null)).toBe('""')
    expect(textFromUnknown(undefined)).toBe('""')
  })
})

describe("idWithPrefix", () => {
  it("generates IDs with given prefix", () => {
    const id = idWithPrefix("test")
    expect(id.startsWith("test_")).toBe(true)
    expect(id.length).toBeGreaterThan("test_".length)
  })

  it("generates unique IDs each time", () => {
    const ids = new Set(Array.from({ length: 100 }, () => idWithPrefix("test")))
    expect(ids.size).toBe(100)
  })
})

describe("toJsonSchema", () => {
  it("returns empty object for non-records", () => {
    expect(toJsonSchema(42)).toEqual({})
    expect(toJsonSchema(null)).toEqual({})
  })

  it("converts enum to type+enum", () => {
    expect(toJsonSchema({ kind: "enum", enum: ["a", "b"] })).toEqual({
      type: "string",
      enum: ["a", "b"],
    })
  })

  it("converts string kind", () => {
    expect(toJsonSchema({ kind: "string" })).toEqual({ type: "string" })
    expect(toJsonSchema({ kind: "String" })).toEqual({ type: "string" })
    expect(toJsonSchema({ type: "string" })).toEqual({ type: "string" })
  })

  it("converts number kind", () => {
    expect(toJsonSchema({ kind: "number" })).toEqual({ type: "number" })
  })

  it("converts boolean kind", () => {
    expect(toJsonSchema({ kind: "boolean" })).toEqual({ type: "boolean" })
  })

  it("converts object with properties and required inference", () => {
    const result = toJsonSchema({
      kind: "object",
      properties: { name: { kind: "string" }, age: { kind: "number" } },
    })
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    })
  })

  it("respects optional property hints", () => {
    const result = toJsonSchema({
      kind: "object",
      properties: { name: { kind: "string" }, note: { kind: "string", optional: true } },
    })
    expect(result).toMatchObject({
      type: "object",
      required: ["name"],
    })
  })

  it("respects explicit required array", () => {
    const result = toJsonSchema({
      kind: "object",
      properties: { a: { kind: "string" }, b: { kind: "string" } },
      required: ["a"],
    })
    expect(result).toMatchObject({
      type: "object",
      required: ["a"],
    })
  })

  it("converts array kind", () => {
    const result = toJsonSchema({
      kind: "array",
      items: { kind: "string" },
    })
    expect(result).toEqual({ type: "array", items: { type: "string" } })
  })

  it("converts array kind with element key", () => {
    const result = toJsonSchema({
      kind: "Array",
      element: { kind: "number" },
    })
    expect(result).toEqual({ type: "array", items: { type: "number" } })
  })

  it("converts union to first valid variant", () => {
    const result = toJsonSchema({
      kind: "union",
      variants: [{ kind: "string" }, { kind: "number" }],
    })
    expect(result).toEqual({ type: "string" })
  })

  it("supports anyOf as union variant source", () => {
    const result = toJsonSchema({
      kind: "Union",
      anyOf: [{ type: "number" }, { type: "string" }],
    })
    expect(result).toEqual({ type: "number" })
  })

  it("converts optional kind", () => {
    expect(toJsonSchema({ kind: "optional", wrapped: { kind: "string" } })).toEqual({
      type: "string",
    })
    expect(toJsonSchema({ kind: "Optional", inner: { kind: "number" } })).toEqual({
      type: "number",
    })
  })

  it("returns empty object for unknown kind", () => {
    expect(toJsonSchema({ kind: "unknown" })).toEqual({})
  })
})

describe("toObjectJsonSchema", () => {
  it("returns object schema for object input", () => {
    expect(toObjectJsonSchema({ kind: "object", properties: {} })).toMatchObject({
      type: "object",
    })
  })

  it("wraps non-object schemas in an object", () => {
    expect(toObjectJsonSchema({ kind: "string" })).toEqual({
      type: "object",
      properties: {},
    })
  })
})
