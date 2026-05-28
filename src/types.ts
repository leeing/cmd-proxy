export type JsonObject = Record<string, unknown>

export type CommandCodeContent =
  | {
      type: "text"
      text: string
      cache_control?: { type: "ephemeral" }
    }
  | {
      type: "image"
      source:
        | {
            type: "base64"
            media_type: string
            data: string
          }
        | {
            type: "url"
            url: string
          }
    }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: JsonObject
    }
  | {
      type: "tool-result"
      toolCallId: string
      toolName: string
      output: {
        type: "text" | "error-text"
        value: string
      }
      cache_control?: { type: "ephemeral" }
    }
  | {
      type: "reasoning"
      text: string
      signature?: string
    }

export interface CommandCodeMessage {
  role: "user" | "assistant" | "tool"
  content: CommandCodeContent[]
}

export interface CommandCodeParams {
  model: string
  messages: CommandCodeMessage[]
  tools: CommandCodeTool[]
  system: string
  max_tokens: number
  stream: true
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  frequency_penalty?: number
  presence_penalty?: number
  thinking?: { type: "enabled"; budget_tokens: number }
  context_management?: unknown
  response_format?: unknown
  seed?: number
  top_k?: number
  metadata?: Record<string, unknown>
  service_tier?: string
}

export interface CommandCodePayload {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: "standard"
  params: CommandCodeParams
}

export interface CommandCodeTool {
  type: "function"
  name: string
  description?: string
  input_schema: unknown
  cache_control?: { type: "ephemeral" }
}

export interface ResponsesRequest {
  id?: string
  model?: string
  instructions?: string
  input?: unknown
  tools?: unknown
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  previous_response_id?: string
  frequency_penalty?: number
  presence_penalty?: number
  response_format?: unknown
  text?: { format?: unknown }
  seed?: number
}

export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens: number
  }
}

export interface ResponsesOutputItem {
  type: "message" | "function_call" | "custom_tool_call" | "reasoning"
  id: string
  status: "in_progress" | "completed"
  role?: "assistant"
  content?: Array<{ type: "output_text"; text: string }>
  call_id?: string
  name?: string
  arguments?: string
  input?: string
  summary?: Array<{ type: "summary_text"; text: string }>
}

export interface ResponsesStreamEvent {
  type: string
  sequence_number?: number
  error?: {
    message: string
    type: string
    code: string | null
    param?: string | null
  }
  response?: {
    id: string
    object: "response"
    created_at: number
    model: string
    status: "in_progress" | "completed"
    output: ResponsesOutputItem[]
    usage?: ResponsesUsage
    error?: null
    incomplete_details?: null
    instructions?: string | null
    max_output_tokens?: number | null
    parallel_tool_calls?: boolean
    previous_response_id?: string | null
    text?: { format: unknown }
    tool_choice?: unknown
    tools?: unknown[]
    temperature?: number | null
    top_p?: number | null
    truncation?: "disabled"
    metadata?: Record<string, unknown>
  }
  output_index?: number
  content_index?: number
  item?: ResponsesOutputItem
  part?: { type: "output_text"; text: string }
  delta?: string
  text?: string
  arguments?: string
  input?: string
  item_id?: string
}

export type CommandCodeStreamEvent = JsonObject & { type?: unknown }
