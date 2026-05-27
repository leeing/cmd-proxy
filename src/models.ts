const MODEL_MAP = {
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "kimi-k2.6": "moonshotai/Kimi-K2.6",
  "glm-5.1": "zai-org/GLM-5.1",
  "qwen-3.6-max": "Qwen/Qwen3.6-Max-Preview",
  "qwen-3.7-max": "Qwen/Qwen3.7-Max-Preview",
  "qwen-3.6-plus": "Qwen/Qwen3.6-Plus",
} as const

export function resolveModel(model: string): string {
  const exact = MODEL_MAP[model as keyof typeof MODEL_MAP]
  if (exact) return exact
  if (model.includes("/")) return model

  const lower = model.toLowerCase()
  for (const [alias, value] of Object.entries(MODEL_MAP)) {
    if (alias.toLowerCase() === lower) return value
  }
  return model
}

export function modelList(): Array<{
  id: string
  object: "model"
  created: number
  owned_by: string
}> {
  return Object.keys(MODEL_MAP).map((id) => ({
    id,
    object: "model",
    created: 1_700_000_000,
    owned_by: "commandcode",
  }))
}
