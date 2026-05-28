# Spec 合规性待修复项

> 基于 OpenAI Responses API、Chat Completions API 和 Anthropic Messages API 官方 Spec 的对比分析。

---

## 🔴 重要偏差

### 1. Anthropic `message_start` 的 `input_tokens` 始终为 0

- **文件**: `src/messages.ts:454`
- **问题**: `createAnthropicState` 中 `inputTokens` 初始化为 `0`，直到 `message_delta` 才更新。但 Anthropic Spec 要求 `message_start` 事件必须携带准确的 `usage.input_tokens`。
- **影响**: Anthropic SDK 在连接建立时显示的 token 使用量始终为 0，只在流结束时才更新。
- **修复方向**: 在上游请求返回 `finish` 事件前无法获取真实 token 数，需考虑在上游协议中加入早期 token 计数，或接受此偏差并文档说明。

### 2. Streamed tool call 的 `input` 在非流式响应中丢失

- **文件**: `src/messages.ts:529-550`
- **问题**: `tool-input-delta` 的 partial JSON 被转发为 `input_json_delta`，但 `currentToolUseBlock.input` 始终是初始化的空对象 `{}`——deltas 从未被累积解析后写入 `input` 字段。
- **影响**: 非流式路径中，通过 streaming delta 方式返回的工具调用，其 `tool_use.input` 为空对象。流式 SSE 路径不受影响（SDK 自行从 `input_json_delta` 累积）。
- **修复方向**: 在 `tool-input-delta` 和 `tool-input-end` 中累积 delta 字符串，`tool-input-end` 时 `JSON.parse` 写入 `currentToolUseBlock.input`。

### 3. `stream_options.include_usage` 形同虚设

- **文件**: `src/http.ts:513`、`src/chat-completions.ts:414`
- **问题**: `_includeUsage` 参数以下划线前缀标记为未使用。实际上 `pushChunk()` 在 `finishReason` 存在时**无条件**附加 usage。OpenAI Spec 规定只有 `stream_options.include_usage: true` 时才发送额外 usage chunk。
- **影响**: 未请求 usage 的客户端可能收到含 `usage` 字段的 chunk，严格校验的 SDK 可能报错。
- **修复方向**: 将 `state.usage` 保持内部累积，仅在 `includeUsage` 为 true 时才在最终 chunk 中输出。

---

## 🟡 中等偏差

### 4. 缺少 `response.in_progress` 事件

- **文件**: `src/responses.ts:426-440`
- **问题**: OpenAI Responses API streaming 要求事件序列为 `response.created` → `response.in_progress` → ...。`ensureCreated()` 只发射 `response.created`，无 `response.in_progress`。
- **影响**: 多数 SDK 容错，但严格依赖事件序列的客户端可能卡住。
- **修复方向**: `ensureCreated()` 中在 `response.created` 之后立即追加 `response.in_progress` 事件。

### 5. Anthropic system block 的 `cache_control` 被丢弃

- **文件**: `src/messages.ts:226-234`
- **问题**: `normalizeSystem()` 将 system 文本块合并为纯字符串，丢失 `cache_control` 标记。
- **影响**: Anthropic 允许在 system prompt 特定位置标记 `cache_control` 实现分层缓存，此信息丢失。
- **修复方向**: 考虑将 system 的 `cache_control` 信息通过其他方式传递，或扩展上游协议以保留 system block 级别标记。

### 6. Thinking block 的 `signature` 为空字符串

- **文件**: `src/messages.ts:639`
- **问题**: thinking block 的 `signature` 硬编码为空字符串。Anthropic Spec 要求此字段存在以验证 thinking 内容完整性。
- **影响**: Anthropic Strict 模式客户端可能拒绝空 signature。
- **修复方向**: 上游需返回 signature，或通过 `reasoning-end` 事件传递。

### 7. Streaming 错误未通过 SSE `error` event 发送

- **文件**: `src/http.ts:327-339`
- **问题**: 上游错误直接转换为 HTTP 错误响应，而非流内 `error` SSE event。Anthropic Spec 规定流式错误应通过 SSE 事件通道发送。
- **影响**: 对于已开始 stream 的客户端，TCP 断开可被检测，但丢失了 `error` event 的结构化错误信息。
- **修复方向**: 在流已开始后检测到的上游错误，通过 `event: error` SSE 事件发送，再关闭连接。

---

## 🟢 轻度偏差 / 刻意限制

### 8. `temperature` 被 clamp 到 1

- **文件**: `src/responses.ts:58`、`src/chat-completions.ts:131`、`src/messages.ts:185`
- **说明**: OpenAI/Anthropic 允许 0~2，上游 API 限制为 ≤1。README 未说明此偏差。
- **建议**: 在 README 配置表中注明 temperature 有效范围为 0~1。

### 9. `max_completion_tokens` 未支持

- **文件**: `src/chat-completions.ts:32`
- **说明**: OpenAI 已推荐使用 `max_completion_tokens`（`max_tokens` 被标记为 deprecated）。代码只读 `request.max_tokens`。
- **建议**: 添加 `request.max_completion_tokens` 作为 fallback。

### 10. `seed` 参数缺失

- **文件**: `src/chat-completions.ts`、`src/responses.ts`
- **说明**: Chat Completions 和 Responses API 的 `seed` 参数（确定性输出）未转发。
- **建议**: 确认上游是否支持，支持则透传。

### 11. Responses API `text.format` 未处理

- **文件**: `src/responses.ts`
- **说明**: Responses API 的 `text` input 支持 `format` 字段（结构化输出 hints），代码中未专门处理 input 中的 `text.format`。
- **建议**: 如有实际使用场景则添加支持。

### 12. OpenAI 错误中 `param` 始终为 `null`

- **文件**: `src/http.ts:558`
- **说明**: `sendOpenAiError()` 中 `param` 硬编码 `null`。OpenAI Spec 中 `param` 应指向导致错误的请求参数名。
- **建议**: 低优先级，有助于客户端定位问题的改善项。

---

## 架构改进（非 spec 相关）

### 13. 三个转换器中 `config` 块重复构建

- **文件**: `src/responses.ts:71-91`、`src/chat-completions.ts:144-163`、`src/messages.ts:204-223`
- **说明**: `CommandCodePayload.config` 构建逻辑完全相同（约 15 行 × 3）。
- **建议**: 提取为共享函数 `buildCommandCodePayload(params, options)`。

### 14. 流处理循环代码重复三次

- **文件**: `src/http.ts:388-493`、`http.ts:509-541`、`http.ts:619-662`
- **说明**: 三个 `streamCommandCodeToXxxInner()` 共享相同的 read-parse-push-finish 范式。
- **建议**: 抽象为泛型流处理函数，减少约 100 行重复代码。

### 15. `http.ts` 文件过大（950 行）

- **说明**: 包含路由、鉴权、上游请求、SSE 写入、存储端点、CORS、错误处理、上下文注入。
- **建议**: 抽离 SSE 工具函数、存储端点、上游请求为独立模块。
