export type JsonObject = Record<string, unknown>

export type CommandCodeContent =
  | {
      type: "text"
      text: string
      cache_control?: { type: "ephemeral" }
    }
  | {
      type: "image"
      source: {
        type: "base64"
        media_type: string
        data: string
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
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown }
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
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown }
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
  response?: {
    id: string
    object: "response"
    created_at: number
    model: string
    status: "in_progress" | "completed"
    output: ResponsesOutputItem[]
    usage?: ResponsesUsage
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
