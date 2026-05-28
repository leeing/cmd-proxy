# cmd-proxy

一个本地协议转换代理，将 OpenAI 兼容客户端的请求转换为上游 API 格式，并实时转换流式响应。

同时提供 OpenAI Responses API、Chat Completions API 和 Anthropic Messages API 三种协议，方便各类兼容工具接入。

## 架构

```text
Codex / OpenAI / Anthropic client
  -> http://localhost:8888/v1/responses
  -> http://localhost:8888/v1/chat/completions
  -> http://localhost:8888/v1/messages
      |
      v
cmd-proxy
  - 校验客户端密钥（pass_through 模式）
  - 解析请求（OpenAI / Anthropic）
  - 转换为上游请求格式
  - 读取上游流式事件
  - 转换回对应协议的 SSE / JSON 响应
      |
      v
上游 API (POST /alpha/generate)
      |
      v
DeepSeek / Claude / GPT / 其他后端模型
```

主要模块：

- `src/index.ts`：CLI 入口，只负责读取配置、启动 HTTP server、处理启动失败。
- `src/config.ts`：使用 Zod 校验环境变量，避免深层逻辑里出现未定义配置。
- `src/http.ts`：HTTP 路由、CORS、密钥校验、上游请求、SSE 写回。
- `src/responses.ts`：OpenAI Responses API 与上游格式互转。
- `src/chat-completions.ts`：OpenAI Chat Completions API 与上游格式互转。
- `src/messages.ts`：Anthropic Messages API 与上游格式互转。
- `src/command-code-stream.ts`：解析上游返回的 JSON line / SSE line 流。
- `src/models.ts`：本地模型别名到上游模型 ID 的映射。

## 原理

代理的核心职责是**协议转换**，分三个层面：

### 1. 请求转换

上游接受一个统一的内部请求格式：

```json
{
  "config": { "workingDir": "...", "date": "...", "environment": "..." },
  "memory": "",
  "taste": "",
  "skills": null,
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-pro",
    "messages": [],
    "tools": [],
    "system": "",
    "max_tokens": 32000,
    "stream": true
  }
}
```

三种协议各自映射到这个格式：

- **Responses API**：`input`、`instructions`、`tools` → `messages`、`system`、`tools`
- **Chat Completions**：`messages`、`tools` → `messages`、`system`、`tools`
- **Anthropic Messages**：`system`、`messages`、`tools`、`tool_choice`、`metadata`、`service_tier` → 对应字段

通用参数（`temperature`、`top_p`、`top_k`、`stop`、`tool_choice`、`parallel_tool_calls`、`seed` 等）透传保留。
其中 `temperature` 会按上游能力限制 clamp 到 `0~1`。

### 2. 工具调用转换

三套工具调用体系互相映射：

| 协议 | 调用格式 | 结果格式 |
|------|----------|----------|
| OpenAI | `tool_calls[]` / `function_call` | `tool` role / `function_call_output` |
| Anthropic | `tool_use` content block | `tool_result` content block |
| 上游 | `tool-call` stream event | `tool-result` stream event |

转换中的关键设计：
- `call_id` 是工具调用的唯一标识，贯穿请求-响应全流程
- 当工具结果缺少工具名时，通过历史 `call_id → toolName` 映射补齐
- Anthropic `is_error` 字段映射为上游 `is_error`，确保错误工具调用可识别

### 3. 流式响应转换

上游以 SSE / JSON line 格式返回流式事件，代理逐事件转换为各协议格式：

| 上游事件 | OpenAI Responses | Chat Completions | Anthropic Messages |
|----------|-----------------|------------------|-------------------|
| `text-delta` | `output_text.delta` | `choices[0].delta.content` | `content_block_delta` |
| `tool-input-start/delta/end` | `function_call` / `custom_tool_call` | `tool_calls[]` delta | `content_block_start/delta/stop` (tool_use) |
| `reasoning-delta` / `reasoning-signature-delta` | reasoning item | `reasoning_content` delta | thinking block / signature_delta |
| `usage-start` / `usage` | - | - | early message_start usage |
| `ping` | - | - | `ping` event |
| `error` | `error` event | - | `error` event |
| `finish` | `response.completed` | stop reason + usage | `message_delta` + `message_stop` |

转换器采用 **push/finish 状态机**模式：每个协议实现一个 `createStreamTranslator()` 工厂，返回 `{ push(event), finish() }` 对象。`push()` 累积上游事件并返回自上次调用以来新产生的输出事件，`finish()` 处理流结束收尾。同一转换器可复用于流式和非流式两种路径。

## 鉴权模式

| 模式 | 客户端行为 | 上游行为 |
|------|-----------|----------|
| `pass_through` | 必须提供与 `CMD_API_KEY` 相同的 key；无 key 则放行 | 转发客户端 key，未提供则用 `CMD_API_KEY` |
| `fixed` | 可使用任意 dummy key | 始终使用 `CMD_API_KEY` |
| `none` | 无需提供 key | 始终使用 `CMD_API_KEY` |

## 支持的端点

```text
GET  /v1/models
POST /v1/responses
POST /responses
POST /v1/chat/completions
POST /chat/completions
POST /v1/messages
POST /messages
POST /v1/messages/count_tokens
POST /messages/count_tokens
```

## 环境要求

- Node.js 22+
- pnpm 10+

## 安装

```bash
pnpm install
```

## 启动

```bash
CMD_API_KEY="user_..." pnpm dev
```

默认监听 `http://localhost:8888/v1`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CMD_API_KEY` | 无 | 上游 API key，必填 |
| `CMD_API_BASE` | `https://api.example.ai` | 上游 API 地址 |
| `CMD_PROXY_PORT` | `8888` | 本地监听端口 |
| `CMD_PROXY_AUTH_MODE` | `pass_through` | 鉴权策略：`pass_through`、`fixed`、`none` |
| `CMD_PROXY_UPSTREAM_TIMEOUT_MS` | `300000` | 上游请求超时（毫秒），默认 5 分钟 |
| `LOG_LEVEL` | `info` | `fatal`、`error`、`warn`、`info`、`debug`、`trace`、`silent` |

## Codex 用法

`pass_through` 模式下，客户端的 key 必须与 `CMD_API_KEY` 一致：

```bash
export OPENAI_BASE_URL="http://localhost:8888/v1"
export OPENAI_API_KEY="user_..." # 必须与 CMD_API_KEY 相同
```

本地开发推荐 `fixed` 模式，客户端可使用任意 key：

```bash
CMD_API_KEY="user_..." CMD_PROXY_AUTH_MODE=fixed pnpm dev
export OPENAI_BASE_URL="http://localhost:8888/v1"
export OPENAI_API_KEY="dummy"
```

`none` 模式等同于 `fixed`，适合不在意客户端鉴权的场景。

## Chat Completions 用法

```bash
curl http://localhost:8888/v1/chat/completions \
  -H "Authorization: Bearer user_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [
      { "role": "user", "content": "Say hi in one sentence." }
    ],
    "stream": false
  }'
```

## Responses API 用法

```bash
curl http://localhost:8888/v1/responses \
  -H "Authorization: Bearer user_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "input": "Say hi in one sentence.",
    "stream": false
  }'
```

## Anthropic Messages API 用法

```bash
curl http://localhost:8888/v1/messages \
  -H "Authorization: Bearer user_..." \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful assistant.",
    "messages": [
      { "role": "user", "content": "Say hi in one sentence." }
    ],
    "max_tokens": 4096,
    "stream": false
  }'
```

## 开发

```bash
pnpm check
pnpm typecheck
pnpm test
```

当前测试覆盖：

- Responses 请求转换 + 流式事件转换 + 推理 (reasoning) 映射 + 存储端点
- Chat Completions 请求转换 + 流式和非流式聚合 + reasoning_content 映射
- Anthropic Messages 请求转换 + 流式和非流式聚合 + 扩展思考 + prompt caching + 图片直传
- HTTP 路由、SSE ping、错误格式、鉴权模式、超时控制
- Responses 存储（内存）：GET /cancel、previous_response_id 上下文注入
- 上游流解析
- 环境变量校验 + 超时配置

## 已实现功能

- **Anthropic Messages**：extended thinking（含上游 signature delta 时透传）、prompt caching（用户内容/tool/tool_result cache_control 直传 + cache 用量回读）、图片 base64/url 直传、文本 document 转换、metadata/service_tier 转发、top_k、reasoning-delta 映射为 thinking block、流内 ping/error event、`anthropic-version`/`anthropic-beta`/`request-id` 响应头、Anthropic 错误类型映射、Messages 请求严格校验、beta feature gate、本地估算版 `count_tokens`
- **OpenAI Responses**：reasoning 映射为 reasoning item、previous_response_id 对话连续性、responses storage 5 个端点（CRUD + cancel + compact + input_tokens）
- **OpenAI Chat Completions**：reasoning 映射为 reasoning_content、frequency_penalty / presence_penalty / response_format 转发、stream_options.include_usage 控制
- **HTTP**：SSE ping 保活（15s）、上游请求超时（可配）、AbortController 取消、pass_through 密钥校验
- **通用**：3 种鉴权模式、模型别名映射、实时 SSE 协议转换

## 当前限制

- 图片、多模态等能力取决于上游模型支持；OpenAI Chat/Responses 的 data URL 图片会转换为上游 base64 图片块。
- OpenAI Responses 内建工具（如 `web_search_preview`、`file_search`、`code_interpreter`、MCP 等）当前会降级为 warning 并从上游请求中移除，避免阻断 Codex 主流程；待上游提供对应能力后再映射。
- OpenAI Chat Completions 非 `function` 工具当前会降级为 warning 并从上游请求中移除。
- Anthropic server tools / MCP / web search 工具当前会降级为 warning 并从上游请求中移除，避免阻断 Claude Code 主流程；待上游提供对应能力后再映射。
- Anthropic `context_management` 会先检查对应 `anthropic-beta`；beta 已启用时映射至上游 params，是否实际裁剪由上游决定。
- Anthropic `mcp_servers`、`container` 依赖 Anthropic 原生后端语义，当前会降级为 warning 并安全忽略。
- 不支持的 Anthropic content block 或非文本 document 会降级为 warning 并跳过，不再阻断请求。
- Anthropic `count_tokens` 当前是本地估算，不代表 Anthropic 官方 tokenizer 或上游模型 tokenizer 的精确结果；主要用于 Claude SDK/Claude Code 的协议探测和预算粗估。
- Anthropic document 目前只支持 `source.type = "text"` 并折叠为文本上下文；PDF、base64 document、URL document、citations 不做伪造。
- prompt caching 需上游模型实际支持 `cache_control`，否则参数被忽略；Anthropic system block 的 `cache_control` 目前无法在上游 string-only system 字段中完整保留。
- Anthropic `message_start.usage` 只有在上游先发送 `usage-start`/`usage` 事件时才可准确；若上游只在 finish 事件返回 usage，最终 response usage 准确，但 `message_start` 会先显示 0。
- Anthropic extended thinking 的 `signature_delta` 依赖上游提供 `reasoning-signature-delta` 或 `reasoning-end.signature`；未提供时无法完整模拟官方签名。
- `n > 1`（多选）、`logprobs`、`logit_bias` 暂不转发（上游不支持）。

## Docker 部署

使用 docker-compose：

```bash
cp .env.example .env
docker compose up -d
```

或直接使用 Docker：

```bash
docker build -t cmd-proxy .
docker run -d -p 8888:8888 \
  -e CMD_API_KEY \
  -e CMD_PROXY_AUTH_MODE=fixed \
  cmd-proxy
```

所有环境变量均支持通过 `-e` 传入，见上方配置表格。
