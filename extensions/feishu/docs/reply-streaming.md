# 飞书回复与流式卡片

## 发送优先级

- **优先**：使用 **Card 流式发送**（`renderMode: "card"` 且 `streaming !== false` 时）。建卡 → 流式 `update` 增量 → 结束时 `close` 收尾。
- **兼容**：**Text 发送**（`sendMessageFeishu`）用于：
  - 配置为 `renderMode: "raw"`（纯文本），或
  - 未走卡片（如卡片未建、流式未启用）时按 chunk 发普通消息。

不要默认改为「仅发 summary 走 text」；text 仅作兼容与兜底。

## 流程简述

1. **onReplyStart**：若 `streamingEnabled && renderMode === "card"`，则 `startStreaming()`，建流式卡片（「Thinking...」）。
2. **onPartialReply**（若提供）：`streamText = payload.text`，排队 `streaming.update(streamText)`，只发增量。
3. **deliver(payload, info)**：
   - 若 `streaming?.isActive()` 且 `info?.kind === "final"`：用当前 `text` 调用 `closeStreaming(text)`，整卡收尾，并设 `deliveredViaStreaming = true`，不再发后续卡片。
   - 否则若未通过流式卡片发送：按 `useCard` 走 `sendMarkdownCardFeishu` 或 `sendMessageFeishu`（chunk 拆分）。

## Card 模式下的实时性

### 能保障实时性的路径（pi-embedded 等）

- **来源**：仅当 run 使用 **pi-embedded**（或其它会调用 `onPartialReply` 的 agent）时，飞书才会在 run 过程中收到 partial；`reply-dispatcher` 的 `onPartialReply` 把 `payload.text` 赋给 `streamText` 并排队调用 `streaming.update(streamText)`。
- **流式卡片**（`streaming-card.ts`）：
  - **增量**：只向 Feishu 发 delta（`text.slice(sentLength)`），并做重复后缀裁剪，避免同段内容发两遍。
  - **节流**：`updateThrottleMs = 100`，即两次 PUT 至少间隔 100ms（约 10 次/秒），避免请求过密。被节流时会把当前 `text` 记在 `pendingText`，`close()` 时会用 `pendingText` 补发剩余 delta，不丢内容。
  - **串行**：`update()` 通过 `this.queue` 串行执行，保证与 Feishu 的「按 sequence 追加」语义一致，不会乱序。
- **结论**：在「agent 持续调用 onPartialReply」的前提下，card 模式能保障**有上限的实时性**：内容不丢、顺序正确，但更新频率被节流到约 10 次/秒，且受网络与 API 延迟影响。

### CLI 后端的实时性（已支持）

- 使用 **CLI 后端**（如 cursor-agent、或配置为 jsonl 输出的 claude-cli）时，子进程按行输出 JSONL，`runCliAgent` 的 `streamCallbacks.onAssistant(text)` 会收到 assistant delta。
- 现已将 **onAssistant 转发到** `params.opts.onPartialReply`，即 CLI 的流式也会推到 Feishu（及其他提供 `onPartialReply` 的渠道），卡片可逐段更新。
- 若 CLI 后端 **output 为 json**（如默认 claude-cli 单次 JSON），进程结束才有一份结果，没有按行 delta，则不会触发 onAssistant，卡片仍是「Thinking...」后一次性 close。

### 可选调优（仅在需要更强实时感时）

- 将 `updateThrottleMs` 从 100 调小（如 50），可提高卡片刷新频率，但会增加 Feishu API 调用次数与失败/限流风险，需按环境权衡。

## 与 Cursor 后端的关系

- **cursor-agent** 的流式输出只到 Web UI（`emitAgentEvent`），**不**经过 Feishu 的 `onPartialReply`。因此飞书侧在 run 结束前只会看到「Thinking...」，结束时收到一次 `deliver(final)`，用整段正文做一次卡片 `close`。
- 上游 **parseCliJsonl** 的消息分组（messageGroups、result 去重、finalize）用于生成最终 payload，保证无重复、tool/assistant 顺序正确。流式卡片优先时仍依赖这份分组结果；text 发送只是用同一 payload 的兼容出口。
