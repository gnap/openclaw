# Cursor backend 与上游 diff 摘要

与 `upstream/main` 的 diff 仅涵盖 **cursor backend 相关** 的移植；完整 diff 含大量合并带来的其它变更（UI、config、extensions 等），此处不列。

## 1. 涉及文件与行数（仅 cursor 相关）

| 文件                                             | 变更                                               |
| ------------------------------------------------ | -------------------------------------------------- |
| `src/agents/cli-runner/helpers.ts`               | +755 / -1（扩展解析、流式、cursor 分支）           |
| `src/agents/cli-runner.ts`                       | +549 / -256（流式回调、onLine、payload 构建）      |
| `src/auto-reply/reply/agent-runner-execution.ts` | +104 / -44（streamCallbacks、onPartialReply 转发） |
| `src/process/exec.ts`                            | +16（onLine 选项与按行回调）                       |
| `src/agents/pi-embedded-runner/types.ts`         | +4（streamingSentToChannel、streamingCharsSent）   |

## 2. 移植内容清单

### 2.1 helpers.ts（cursor 解析与输出形状）

- **parseCliJsonlLine(line, backend)**
  - 仅当 `backend.command.toLowerCase().includes("cursor")` 时解析并返回事件，否则返回 `null`。
  - 事件类型：`thinking` | `assistant` | `tool_result` | `session_id` | `usage`。
- **parseCliJsonl(raw, backend)**
  - **非 cursor**：与上游一致，按 `parsed.item.text` 收集，返回 `{ text, sessionId, usage }`。
  - **cursor**：
    - 按行解析 JSONL，维护 `messageGroups`（tool / assistant 顺序）、`toolOutputs`、`assistantTexts`。
    - 使用 `lastResultText` 做 result 去重，避免 finalize 时重复刷同一段（Feishu 重复段落问题）。
    - 返回扩展的 `CliOutput`：`text?`, `texts?`, `toolOutputs?`, `assistantTexts?`, `messageGroups?`, `sessionId`, `usage`。
- **CliOutput 类型**
  - 上游：`text: string`。
  - 当前：保留 `text`（cursor 分支也填 `text: finalTexts.join("\n\n")`），并增加可选 `texts` / `toolOutputs` / `assistantTexts` / `messageGroups`。
- **createSubsystemLogger**
  - 仅在 helpers 内用于 parseCliJsonl 相关日志。

### 2.2 cli-runner.ts（执行与流式）

- **执行方式**
  - 上游：`getProcessSupervisor().spawn(...)` + `managedRun.wait()`。
  - 当前：`runCommandWithTimeout(..., { onLine, noOutputTimeoutMs })`，不再走 supervisor。
- **streamCallbacks**
  - 新增参数：`onReasoning` / `onAssistant` / `onToolResult` / `flushAndGetSentCount`。
  - 当存在 `streamCallbacks` 时，设置 `onLineCallback`：每行用 `parseCliJsonlLine(line, backend)` 解析，按事件类型调用 `onReasoning` / `onAssistant` / `onToolResult`。
- **parseCliJsonl / parseCliJson**
  - 仍用于超时或非流式时的完整 stdout 解析；cursor 时走扩展的 parseCliJsonl（messageGroups + 去重）。
- **payload 构建**
  - 优先用 `output.messageGroups` 生成 payloads（tool 每组多条、assistant 组内 join）。
  - 无 messageGroups 时回退到 `toolOutputs`/`assistantTexts` 或 `texts` 或 `output.text`。
- **返回值**
  - 在 `EmbeddedPiRunResult` 上增加 `streamingSentToChannel`、`streamingCharsSent`（来自 `flushAndGetSentCount`）。

### 2.3 agent-runner-execution.ts（CLI 分支与通道转发）

- **CLI 分支**
  - 调用 `runCliAgent` 时传入 `streamCallbacks`：
    - `flushAndGetSentCount: () => 0`（流式只给 Web/通道，最终仍走 reply pipeline）。
    - `onReasoning` / `onAssistant` / `onToolResult` 里 `emitAgentEvent`（Web UI）。
    - **onAssistant** 中：若有 `params.opts?.onPartialReply`，则 `void params.opts.onPartialReply({ text })`，供 Feishu 等通道做卡片流式更新。
- **onToolResult**
  - 当 `isCliProvider(...)` 且存在 `params.opts` 时，将 `onToolResult` 置为 `undefined`，避免 CLI 工具结果重复投递。

### 2.4 exec.ts（按行回调）

- **CommandOptions**
  - 新增 `onLine?: (line: string) => void`。
- **stdout 处理**
  - 有 `onLine` 时：维护 `stdoutLineBuffer`，按 `\r?\n` 拆行，对每个完整行调用 `onLine(line)`；最后一行未结束时留在 buffer。

### 2.5 pi-embedded-runner/types.ts

- **EmbeddedPiRunResult**
  - 新增可选字段：`streamingSentToChannel?: boolean`，`streamingCharsSent?: number`。

## 3. 移植完整性检查

| 能力                     | 状态    | 说明                                                                                                    |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| cursor 检测              | ✅      | 以 `backend.command` 含 `"cursor"` 判断；无需新 backend id。                                            |
| 流式事件                 | ✅      | parseCliJsonlLine → thinking/assistant/tool_result → streamCallbacks。                                  |
| 非 cursor 兼容           | ✅      | 非 cursor 时 parseCliJsonlLine 返回 null；parseCliJsonl 非 cursor 分支与上游一致。                      |
| 去重（lastResultText）   | ✅      | 避免 result 与 finalize 重复刷同一段。                                                                  |
| messageGroups → payloads | ✅      | cli-runner 中按 messageGroups 生成 payloads，并有多层 fallback。                                        |
| onPartialReply 转发      | ✅      | agent-runner-execution 的 onAssistant 中转发到 `params.opts.onPartialReply`。                           |
| 执行方式                 | ⚠️      | 所有 CLI 均改为 runCommandWithTimeout（不再用 supervisor）；与上游行为不同，但为 cursor 流式所需。      |
| 默认 cursor backend      | ❌ 未做 | 上游无默认 cursor；当前仍通过配置 `agents.defaults.cliBackends["<id>"]` 且 `command` 含 `cursor` 使用。 |

## 4. 可选后续

- **默认 cursor backend**：若希望 `provider: "cursor-cli"` 开箱即用，可在 `cli-backends.ts` 中增加 `DEFAULT_CURSOR_BACKEND` 并在 `resolveCliBackendConfig` 中解析（与 codex 类似）。
- **文档**：在 [Channels](/channels) 或 [Configuration](/configuration) 中简短说明：CLI backend 的 `command` 若包含 `cursor`，将启用 JSONL 流式解析与卡片流式（如 Feishu）。

## 5. 备注：飞书插件

飞书（Feishu）插件原为第三方，后由官方吸收，现位于仓库 `extensions/feishu/`。若用户曾在 `~/.openclaw/extensions/feishu` 安装过旧版或第三方拷贝，插件发现会同时看到「仓库版」与「全局扩展目录」两份；网关日志中的 “feishu: loaded without install/load-path provenance” 即来自全局目录下的那份。只保留仓库内 `extensions/feishu` 并删掉 `~/.openclaw/extensions/feishu` 即可统一为官方实现。

## 6. 如何查看完整 diff

```bash
git diff upstream/main -- \
  src/agents/cli-runner/helpers.ts \
  src/agents/cli-runner.ts \
  src/auto-reply/reply/agent-runner-execution.ts \
  src/process/exec.ts \
  src/agents/pi-embedded-runner/types.ts
```

文档链接（如需要）：

- [Configuration](https://docs.openclaw.ai/configuration)
- [Channels](https://docs.openclaw.ai/channels)
