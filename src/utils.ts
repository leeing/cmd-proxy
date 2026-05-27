import { randomUUID } from "node:crypto"
import process from "node:process"

import type { JsonObject } from "./types.ts"

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function recordOrEmpty(value: unknown): JsonObject {
  if (isRecord(value)) return value
  if (typeof value !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch (error) {
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

export function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value ?? "")
}

export function idWithPrefix(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

export function toJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return {}

  const kind = stringValue(schema.kind) ?? stringValue(schema.type)
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues) return { type: typeof enumValues[0], enum: enumValues }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" }
    case "number":
    case "Number":
      return { type: "number" }
    case "boolean":
    case "Boolean":
      return { type: "boolean" }
    case "object":
    case "Object":
      return objectSchema(schema)
    case "array":
    case "Array":
      return { type: "array", items: toJsonSchema(schema.items ?? schema.element) }
    case "union":
    case "Union":
      return firstUnionVariant(schema)
    case "optional":
    case "Optional":
      return toJsonSchema(schema.wrapped ?? schema.inner)
    default:
      return {}
  }
}

export function toObjectJsonSchema(schema: unknown): JsonObject {
  const converted = toJsonSchema(schema)
  if (isRecord(converted) && converted.type === "object") return converted
  return { type: "object", properties: {} }
}

function objectSchema(schema: JsonObject): JsonObject {
  const properties: JsonObject = {}
  const inferredRequired: string[] = []
  const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined
  const optional = Array.isArray(schema.optional)
    ? schema.optional.filter((item): item is string => typeof item === "string")
    : []

  if (sourceProperties) {
    for (const [key, value] of Object.entries(sourceProperties)) {
      properties[key] = toJsonSchema(value)
      const valueRecord = isRecord(value) ? value : undefined
      if (booleanValue(valueRecord?.optional) !== true && !optional.includes(key)) {
        inferredRequired.push(key)
      }
    }
  }

  const explicitRequired = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : undefined
  const output: JsonObject = { type: "object" }
  if (Object.keys(properties).length > 0) output.properties = properties
  const required = explicitRequired ?? inferredRequired
  if (required.length > 0) output.required = required
  return output
}

function firstUnionVariant(schema: JsonObject): unknown {
  const variants = Array.isArray(schema.variants)
    ? schema.variants
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : []

  for (const variant of variants) {
    const converted = toJsonSchema(variant)
    if (isRecord(converted) && Object.keys(converted).length > 0) return converted
  }
  return {}
}

import { execSync } from "node:child_process"

export interface GitContext {
  isGitRepo: boolean
  currentBranch: string
  mainBranch: string
  gitStatus: string
  recentCommits: Array<{
    hash: string
    message: string
    date: string
  }>
}

let _gitContext: GitContext | undefined

export function getGitContext(): GitContext {
  if (_gitContext !== undefined) return _gitContext

  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore", timeout: 2000 })
  } catch {
    _gitContext = {
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    }
    return _gitContext
  }

  const exec = (cmd: string): string => {
    try {
      return execSync(cmd, { encoding: "utf-8", timeout: 3000 }).trim()
    } catch {
      return ""
    }
  }

  const currentBranch = exec("git branch --show-current")
  const mainBranch =
    exec("git remote show origin 2>/dev/null | grep 'HEAD branch' | cut -d: -f2 | xargs") || "main"
  const gitStatus = exec("git status --short")
  const commitLog = exec('git log --oneline -5 --format="%h|||%s|||%ci"')
  const recentCommits = commitLog
    ? commitLog.split("\n").map((line) => {
        const parts = line.split("|||")
        return { hash: parts[0] ?? "", message: parts[1] ?? "", date: parts[2] ?? "" }
      })
    : []

  _gitContext = {
    isGitRepo: true,
    currentBranch,
    mainBranch,
    gitStatus: gitStatus.slice(0, 2000),
    recentCommits: recentCommits.slice(0, 5),
  }
  return _gitContext
}
