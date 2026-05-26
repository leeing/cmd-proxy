# cmd-proxy

`cmd-proxy` 是一个本地协议转换代理，用来把 OpenAI 兼容客户端的请求转换到 Command Code API。

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
  - 校验环境变量
  - 解析请求（OpenAI / Anthropic）
  - 转换为 Command Code 请求
  - 读取 Command Code 流式事件
  - 转换回对应协议的 SSE / JSON 响应
      |
      v
Command Code API
  -> https://api.commandcode.ai/alpha/generate
      |
      v
DeepSeek / Claude / GPT / other CC routed models
```

主要模块：

- `src/index.ts`：CLI 入口，只负责读取配置、启动 HTTP server、处理启动失败。
- `src/config.ts`：使用 Zod 校验环境变量，避免深层逻辑里出现未定义配置。
- `src/http.ts`：HTTP 路由、CORS、上游请求、SSE 写回。
- `src/responses.ts`：OpenAI Responses API 与 Command Code 格式互转。
- `src/chat-completions.ts`：OpenAI Chat Completions API 与 Command Code 格式互转。
- `src/messages.ts`：Anthropic Messages API 与 Command Code 格式互转。
- `src/command-code-stream.ts`：解析 Command Code 返回的 JSON line / SSE line 流。
- `src/models.ts`：本地模型别名到 Command Code 模型 ID 的映射。

## 原理

Command Code 的上游接口是：

```text
POST /alpha/generate
```

请求体核心结构大致是：

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

`cmd-proxy` 做三件事：

1. **请求转换**
   - Responses API：把 `input`、`instructions`、`tools` 转成 CC 的 `messages`、`system`、`tools`。
   - Chat Completions：把 `messages`、`tools` 转成 CC 的 `messages`、`system`、`tools`。
   - Anthropic Messages：把 `system`、`messages`、`tools`、`tool_choice` 转成 CC 格式。
   - 保留 `temperature`、`top_p`、`stop`、`tool_choice`、`parallel_tool_calls` 等参数。

2. **工具调用转换**
   - OpenAI `function_call` / `tool_calls` 转成 CC `tool-call`。
   - Anthropic `tool_use` 转成 CC `tool-call`。
   - OpenAI `function_call_output` / `tool` message 转成 CC `tool-result`。
   - Anthropic `tool_result` 转成 CC `tool-result`（含 `is_error` 映射）。
   - 当工具结果缺少工具名时，用历史 `call_id -> toolName` 映射补齐。

3. **流式响应转换**
   - CC `text-delta` 转成各协议文本 delta。
   - CC `tool-input-start/delta/end` 转成各协议工具参数增量。
   - CC `finish.totalUsage` 转成各协议 usage。
   - CC `reasoning-delta` 映射为各协议的推理/思考格式（Anthropic thinking block / OpenAI Responses reasoning item / Chat Completions reasoning_content delta）。

## 支持的端点

```text
GET  /v1/models
POST /v1/responses
POST /responses
POST /v1/chat/completions
POST /chat/completions
POST /v1/messages
POST /messages
```

## 环境要求

- Node.js 22+
- pnpm 10+
- Command Code API key

## 安装

```bash
pnpm install
```

## 启动

```bash
COMMANDCODE_API_KEY="user_..." pnpm dev
```

默认监听：

```text
http://localhost:8888/v1
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMMANDCODE_API_KEY` | 无 | Command Code API key，必填 |
| `COMMANDCODE_API_BASE` | `https://api.commandcode.ai` | Command Code 上游地址 |
| `CMD_PROXY_PORT` | `8888` | 本地监听端口 |
| `CMD_PROXY_AUTH_MODE` | `pass_through` | 上游鉴权策略：`pass_through`、`fixed`、`none` |
| `CMD_PROXY_UPSTREAM_TIMEOUT_MS` | `300000` | 上游请求超时（毫秒），默认 5 分钟 |
| `LOG_LEVEL` | `info` | `fatal`、`error`、`warn`、`info`、`debug`、`trace`、`silent` |

## Codex 用法

启动代理后，把 Codex / OpenAI 兼容客户端指向本地地址：

```bash
export OPENAI_BASE_URL="http://localhost:8888/v1"
export OPENAI_API_KEY="user_..."
```

默认 `CMD_PROXY_AUTH_MODE=pass_through`：Codex 的 `OPENAI_API_KEY` 会作为本地代理的 Bearer token 传入，并继续转发给 Command Code；如果请求里没有 Authorization header，代理会使用启动时的 `COMMANDCODE_API_KEY`。

Codex 本地使用更推荐 fixed 模式：

```bash
COMMANDCODE_API_KEY="user_..." CMD_PROXY_AUTH_MODE=fixed pnpm dev
export OPENAI_BASE_URL="http://localhost:8888/v1"
export OPENAI_API_KEY="dummy"
```

`fixed` 模式下，客户端可以使用任意 dummy key，本地代理始终使用 `COMMANDCODE_API_KEY` 访问上游。`none` 模式同样使用 `COMMANDCODE_API_KEY` 访问上游，适合本地开发时不关心客户端 Authorization 的场景。

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
- HTTP 路由、SSE ping、错误格式、认证模式、超时控制
- Responses 存储（内存）：GET /cancel、previous_response_id 上下文注入
- Command Code 流解析
- 环境变量校验 + 超时配置

## 已实现功能

- **Anthropic Messages**：extended thinking、prompt caching（cache_control 直传 + cache 用量回读）、图片 base64 直传、reasoning-delta 映射为 thinking block
- **OpenAI Responses**：reasoning 映射为 reasoning item、previous_response_id 对话连续性、responses storage 5 个端点（CRUD + cancel + compact + input_tokens）
- **OpenAI Chat Completions**：reasoning 映射为 reasoning_content、frequency_penalty / presence_penalty / response_format 转发、stream_options.include_usage 控制
- **HTTP**：SSE ping 保活（15s）、上游请求超时（可配）、AbortController 取消
- **通用**：3 种鉴权模式、模型别名映射、实时 SSE 协议转换

## 当前限制

- 图片、多模态、web search 等能力取决于 Command Code 上游模型和接口支持。
- prompt caching 需 Command Code 上游模型实际支持 `cache_control`，否则参数被忽略。
- `n > 1`（多选）、`logprobs`、`logit_bias` 暂不转发（Command Code 上游不支持）。

## Docker 部署

使用 docker-compose：

```bash
# 将 .env.example 复制为 .env 并填入 key
cp .env.example .env
docker compose up -d
```

或直接使用 Docker：

```bash
docker build -t cmd-proxy .
docker run -d -p 8888:8888 \
  -e COMMANDCODE_API_KEY \
  -e CMD_PROXY_AUTH_MODE=fixed \
  cmd-proxy
```

所有环境变量均支持通过 `-e` 传入，见上方配置表格。
