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
   - CC `reasoning-delta` 默认不混入正文，避免客户端把思考过程当作最终回答显示。

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

- Responses 请求转换 + 流式事件转换
- Chat Completions 请求转换 + 流式和非流式聚合
- Anthropic Messages 请求转换 + 流式和非流式聚合
- HTTP 路由、SSE 输出、错误格式、认证模式
- Command Code 流解析
- 环境变量校验

## 当前限制

- WebSocket 端点尚未实现。
- `reasoning-delta` 目前默认隐藏，不会输出为 Codex 原生 reasoning block。
- Responses storage 周边端点暂不支持，包括 `/v1/responses/{id}`、`/v1/responses/{id}/input_items`、`/v1/responses/{id}/cancel`、`/v1/responses/compact`、`/v1/responses/input_tokens`。
- 图片、多模态、web search、结构化输出等能力取决于 Command Code 上游模型和接口支持。
