const DEFAULT_MODEL_MAP: Record<string, string> = {
  "claude-opus-4-7": "deepseek/deepseek-v4-pro",
  "claude-sonnet-4-6": "deepseek/deepseek-v4-pro",
  "claude-haiku-4-5": "deepseek/deepseek-v4-flash",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "kimi-k2.6": "moonshotai/Kimi-K2.6",
  "glm-5.1": "zai-org/GLM-5.1",
  "qwen-3.6-max": "Qwen/Qwen3.6-Max-Preview",
  "qwen-3.7-max": "Qwen/Qwen3.7-Max-Preview",
  "qwen-3.6-plus": "Qwen/Qwen3.6-Plus",
}

let _customModelMap: Record<string, string> = {}

export function initModelMap(custom: Record<string, string>): void {
  _customModelMap = custom
}

function mergedModelMap(): Record<string, string> {
  return { ...DEFAULT_MODEL_MAP, ..._customModelMap }
}

export function resolveModel(model: string): string {
  const merged = mergedModelMap()
  const exact = merged[model]
  if (exact) return exact
  if (model.includes("/")) return model

  const lower = model.toLowerCase()
  for (const [alias, value] of Object.entries(merged)) {
    if (alias.toLowerCase() === lower) return value
  }
  return model
}

export function modelList(ownedBy = "commandcode"): Array<{
  id: string
  object: "model"
  created: number
  owned_by: string
}> {
  return Object.keys(mergedModelMap()).map((id) => ({
    id,
    object: "model",
    created: 1_700_000_000,
    owned_by: ownedBy,
  }))
}
