export type JsonObject = Record<string, unknown>

export type CommandCodeContent =
  | {
      type: "text"
      text: string
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
}

export interface ResponsesRequest {
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
  type: "message" | "function_call" | "custom_tool_call"
  id: string
  status: "in_progress" | "completed"
  role?: "assistant"
  content?: Array<{ type: "output_text"; text: string }>
  call_id?: string
  name?: string
  arguments?: string
  input?: string
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
