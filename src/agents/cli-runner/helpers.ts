import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runExec } from "../../process/exec.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { escapeRegExp, isRecord } from "../../utils.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { detectRuntimeShell } from "../shell-utils.js";
import { buildSystemPromptParams } from "../system-prompt-params.js";
import { buildAgentSystemPrompt } from "../system-prompt.js";

const log = createSubsystemLogger("agent/cli-runner/helpers");

const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

export async function cleanupResumeProcesses(
  backend: CliBackendConfig,
  sessionId: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const resumeArgs = backend.resumeArgs ?? [];
  if (resumeArgs.length === 0) {
    return;
  }
  if (!resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    return;
  }
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return;
  }

  const resumeTokens = resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId));
  const pattern = [commandToken, ...resumeTokens]
    .filter(Boolean)
    .map((token) => escapeRegExp(token))
    .join(".*");
  if (!pattern) {
    return;
  }

  try {
    await runExec("pkill", ["-f", pattern]);
  } catch {
    // ignore missing pkill or no matches
  }
}

function buildSessionMatchers(backend: CliBackendConfig): RegExp[] {
  const commandToken = path.basename(backend.command ?? "").trim();
  if (!commandToken) {
    return [];
  }
  const matchers: RegExp[] = [];
  const sessionArg = backend.sessionArg?.trim();
  const sessionArgs = backend.sessionArgs ?? [];
  const resumeArgs = backend.resumeArgs ?? [];

  const addMatcher = (args: string[]) => {
    if (args.length === 0) {
      return;
    }
    const tokens = [commandToken, ...args];
    const pattern = tokens
      .map((token, index) => {
        const tokenPattern = tokenToRegex(token);
        return index === 0 ? `(?:^|\\s)${tokenPattern}` : `\\s+${tokenPattern}`;
      })
      .join("");
    matchers.push(new RegExp(pattern));
  };

  if (sessionArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(sessionArgs);
  } else if (sessionArg) {
    addMatcher([sessionArg, "{sessionId}"]);
  }

  if (resumeArgs.some((arg) => arg.includes("{sessionId}"))) {
    addMatcher(resumeArgs);
  }

  return matchers;
}

function tokenToRegex(token: string): string {
  if (!token.includes("{sessionId}")) {
    return escapeRegExp(token);
  }
  const parts = token.split("{sessionId}").map((part) => escapeRegExp(part));
  return parts.join("\\S+");
}

/**
 * Cleanup suspended OpenClaw CLI processes that have accumulated.
 * Only cleans up if there are more than the threshold (default: 10).
 */
export async function cleanupSuspendedCliProcesses(
  backend: CliBackendConfig,
  threshold = 10,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const matchers = buildSessionMatchers(backend);
  if (matchers.length === 0) {
    return;
  }

  try {
    const { stdout } = await runExec("ps", ["-ax", "-o", "pid=,stat=,command="]);
    const suspended: number[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const stat = match[2] ?? "";
      const command = match[3] ?? "";
      if (!Number.isFinite(pid)) {
        continue;
      }
      if (!stat.includes("T")) {
        continue;
      }
      if (!matchers.some((matcher) => matcher.test(command))) {
        continue;
      }
      suspended.push(pid);
    }

    if (suspended.length > threshold) {
      // Verified locally: stopped (T) processes ignore SIGTERM, so use SIGKILL.
      await runExec("kill", ["-9", ...suspended.map((pid) => String(pid))]);
    }
  } catch {
    // ignore errors - best effort cleanup
  }
}
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  const tracked = chained.finally(() => {
    if (CLI_RUN_QUEUE.get(key) === tracked) {
      CLI_RUN_QUEUE.delete(key);
    }
  });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

type CliUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliOutput = {
  text?: string;
  texts?: string[];
  /** Tool outputs - each as separate message */
  toolOutputs?: string[];
  /** Assistant texts - final response, separate from tool outputs */
  assistantTexts?: string[];
  /** Message groups in chronological order - preserves tool/assistant sequence */
  messageGroups?: { type: "tool" | "assistant"; texts: string[] }[];
  sessionId?: string;
  usage?: CliUsage;
};

/** Streaming event from a single JSONL line */
export type CliStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool_result"; text: string }
  | { type: "session_id"; sessionId: string }
  | { type: "usage"; usage: CliUsage }
  | null;

/** Parse a single JSONL line and emit streaming events */
export function parseCliJsonlLine(line: string, backend: CliBackendConfig): CliStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const msgType = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

  // Log unknown types for debugging
  if (
    msgType &&
    msgType !== "thinking" &&
    msgType !== "assistant" &&
    msgType !== "tool_call" &&
    msgType !== "session_id" &&
    msgType !== "usage"
  ) {
    console.log(
      `[cli-streaming] Unknown type: ${msgType}, keys: ${Object.keys(parsed).join(", ")}`,
    );
  }

  // Extract session ID
  if (!parsed.session_id && typeof parsed.thread_id === "string") {
    return { type: "session_id", sessionId: parsed.thread_id.trim() };
  }

  // Extract usage
  if (isRecord(parsed.usage)) {
    const usage = toUsage(parsed.usage);
    if (usage) {
      return { type: "usage", usage };
    }
  }

  // Only process cursor-agent output
  if (!backend.command.toLowerCase().includes("cursor")) {
    return null;
  }

  // Thinking events
  if (msgType === "thinking") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : "";
    if (subtype === "delta" && typeof parsed.text === "string") {
      return { type: "thinking", text: parsed.text };
    }
    return null;
  }

  // Assistant events - extract text content
  if (msgType === "assistant") {
    const message = isRecord(parsed.message) ? parsed.message : null;
    const content = message?.content;
    const contentArray = Array.isArray(content) ? content : null;
    const firstContent = contentArray?.[0];
    if (isRecord(firstContent) && typeof firstContent.text === "string") {
      return { type: "assistant", text: firstContent.text };
    }
    return null;
  }

  // Tool call events - extract tool result
  if (msgType === "tool_call") {
    const toolCall = isRecord(parsed.tool_call) ? parsed.tool_call : null;

    // Debug: log tool_call keys
    if (toolCall) {
      console.log(`[cli-streaming] tool_call keys: ${Object.keys(toolCall).join(", ")}`);
    }

    // Try shell tool call first
    const shellToolCall = isRecord(toolCall?.shellToolCall) ? toolCall.shellToolCall : null;
    if (shellToolCall) {
      const args = isRecord(shellToolCall.args) ? shellToolCall.args : null;
      const command = typeof args?.command === "string" ? args.command : null;
      const result = isRecord(shellToolCall.result) ? shellToolCall.result : null;

      if (result) {
        let output = "";
        if (command) {
          output += `$ ${command}\n`;
        }

        if (isRecord(result.success)) {
          const stdout =
            typeof result.success.stdout === "string" ? result.success.stdout.trim() : "";
          const stderr =
            typeof result.success.stderr === "string" ? result.success.stderr.trim() : "";
          const exitCode =
            typeof result.success.exitCode === "number" ? result.success.exitCode : 0;

          if (stdout) {
            output += stdout;
          }
          if (stderr) {
            output += (output ? "\n" : "") + `stderr: ${stderr}`;
          }
          output += `\n(exit code: ${exitCode})`;
        } else if (isRecord(result.failure)) {
          const stderr =
            typeof result.failure.stderr === "string" ? result.failure.stderr.trim() : "";
          const exitCode =
            typeof result.failure.exitCode === "number" ? result.failure.exitCode : 1;
          output += `Command failed (exit code: ${exitCode})`;
          if (stderr) {
            output += `\nstderr: ${stderr}`;
          }
        }

        if (output) {
          return { type: "tool_result", text: `\`\`\`\n${output}\n\`\`\`` };
        }
      }
    }

    // Try read file tool call
    const readToolCall = isRecord(toolCall?.readToolCall) ? toolCall.readToolCall : null;
    if (readToolCall) {
      const args = isRecord(readToolCall.args) ? readToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(readToolCall.result) ? readToolCall.result : null;

      if (result && filePath) {
        // Extract relative path from absolute path
        const relativePath = filePath.replace(/^.*\//, "");

        if (typeof result.content === "string") {
          const lines = result.content.split("\n").length;
          return { type: "tool_result", text: `📄 ${relativePath} (${lines} lines)` };
        } else if (typeof result.error === "string") {
          return { type: "tool_result", text: `📄 ${relativePath}: Error - ${result.error}` };
        }
      }
    }

    // Try write file tool call
    const writeToolCall = isRecord(toolCall?.writeToolCall) ? toolCall.writeToolCall : null;
    if (writeToolCall) {
      const args = isRecord(writeToolCall.args) ? writeToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(writeToolCall.result) ? writeToolCall.result : null;

      if (result && filePath) {
        // Extract relative path from absolute path
        const relativePath = filePath.replace(/^.*\//, "");

        if (typeof result.success === "string") {
          // Try to parse diff stats from success message
          const lines = result.success.split("\n").length;
          return { type: "tool_result", text: `📝 ${relativePath} (+${lines} lines)` };
        } else if (typeof result.error === "string") {
          return { type: "tool_result", text: `📝 ${relativePath}: Error - ${result.error}` };
        } else if (result.success === true) {
          return { type: "tool_result", text: `📝 ${relativePath} (written)` };
        }
      }
    }

    // Try edit file tool call
    const editToolCall = isRecord(toolCall?.editToolCall) ? toolCall.editToolCall : null;
    if (editToolCall) {
      const args = isRecord(editToolCall.args) ? editToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(editToolCall.result) ? editToolCall.result : null;

      if (result && filePath) {
        // Extract relative path from absolute path
        const relativePath = filePath.replace(/^.*\//, "");

        if (typeof result.success === "string") {
          // Try to extract diff stats from the success message
          // Format could be like "Applied edit to file.js: +10 -5 lines" or similar
          return { type: "tool_result", text: `✏️ ${relativePath}: ${result.success}` };
        } else if (typeof result.error === "string") {
          return { type: "tool_result", text: `✏️ ${relativePath}: Error - ${result.error}` };
        } else if (result.success === true) {
          return { type: "tool_result", text: `✏️ ${relativePath} (edited)` };
        }
      }
    }

    // Try search files tool call
    const searchToolCall = isRecord(toolCall?.searchToolCall) ? toolCall.searchToolCall : null;
    if (searchToolCall) {
      const result = isRecord(searchToolCall.result) ? searchToolCall.result : null;

      if (result && typeof result.results === "string") {
        // Show file count and match count instead of full results
        const lines = result.results.split("\n").filter((l: string) => l.trim());
        const fileMatches = new Set<string>();
        for (const line of lines) {
          // Try to extract file path from search result lines
          const match = line.match(/^([^:]+):/);
          if (match) {
            fileMatches.add(match[1].replace(/^.*\//, ""));
          }
        }
        const matchCount = lines.length;
        const fileCount = fileMatches.size;
        return {
          type: "tool_result",
          text: `🔍 Search: ${fileCount} files, ${matchCount} matches`,
        };
      }
    }
  }

  return null;
}

function buildModelAliasLines(cfg?: OpenClawConfig) {
  const models = cfg?.agents?.defaults?.models ?? {};
  const entries: Array<{ alias: string; model: string }> = [];
  for (const [keyRaw, entryRaw] of Object.entries(models)) {
    const model = String(keyRaw ?? "").trim();
    if (!model) {
      continue;
    }
    const alias = String((entryRaw as { alias?: string } | undefined)?.alias ?? "").trim();
    if (!alias) {
      continue;
    }
    entries.push({ alias, model });
  }
  return entries
    .toSorted((a, b) => a.alias.localeCompare(b.alias))
    .map((entry) => `- ${entry.alias}: ${entry.model}`);
}

export function buildSystemPrompt(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  heartbeatPrompt?: string;
  docsPath?: string;
  tools: AgentTool[];
  contextFiles?: EmbeddedContextFile[];
  modelDisplay: string;
  agentId?: string;
}) {
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "openclaw",
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: params.modelDisplay,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
    },
  });
  const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    reasoningTagHint: false,
    heartbeatPrompt: params.heartbeatPrompt,
    docsPath: params.docsPath,
    runtimeInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: buildModelAliasLines(params.config),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: params.contextFiles,
    ttsHint,
    memoryCitationsMode: params.config?.memory?.citations,
  });
}

export function normalizeCliModel(modelId: string, backend: CliBackendConfig): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const direct = backend.modelAliases?.[trimmed];
  if (direct) {
    return direct;
  }
  const lower = trimmed.toLowerCase();
  const mapped = backend.modelAliases?.[lower];
  if (mapped) {
    return mapped;
  }
  return trimmed;
}

function toUsage(raw: Record<string, unknown>): CliUsage | undefined {
  const pick = (key: string) =>
    typeof raw[key] === "number" && raw[key] > 0 ? raw[key] : undefined;
  const input = pick("input_tokens") ?? pick("inputTokens");
  const output = pick("output_tokens") ?? pick("outputTokens");
  const cacheRead =
    pick("cache_read_input_tokens") ?? pick("cached_input_tokens") ?? pick("cacheRead");
  const cacheWrite = pick("cache_write_input_tokens") ?? pick("cacheWrite");
  const total = pick("total_tokens") ?? pick("total");
  if (!input && !output && !cacheRead && !cacheWrite && !total) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

function collectText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content.map((entry) => collectText(entry)).join("");
  }
  if (isRecord(value.message)) {
    return collectText(value.message);
  }
  return "";
}

function pickSessionId(
  parsed: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  const fields = backend.sessionIdFields ?? [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function parseCliJson(raw: string, backend: CliBackendConfig): CliOutput | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const sessionId = pickSessionId(parsed, backend);
  const usage = isRecord(parsed.usage) ? toUsage(parsed.usage) : undefined;
  const text =
    collectText(parsed.message) ||
    collectText(parsed.content) ||
    collectText(parsed.result) ||
    collectText(parsed);
  return { text: text.trim(), sessionId, usage };
}

export function parseCliJsonl(raw: string, backend: CliBackendConfig): CliOutput | null {
  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  // Detect if this is cursor-agent based on CLI command path
  const isCursorAgent = backend.command.toLowerCase().includes("cursor");

  // If not cursor-agent, use the main branch logic (extract from parsed.item.text)
  if (!isCursorAgent) {
    let sessionId: string | undefined;
    let usage: CliUsage | undefined;
    const texts: string[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      if (!sessionId) {
        sessionId = pickSessionId(parsed, backend);
      }
      if (!sessionId && typeof parsed.thread_id === "string") {
        sessionId = parsed.thread_id.trim();
      }
      if (isRecord(parsed.usage)) {
        usage = toUsage(parsed.usage) ?? usage;
      }
      const item = isRecord(parsed.item) ? parsed.item : null;
      if (item && typeof item.text === "string") {
        const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
        if (!type || type.includes("message")) {
          texts.push(item.text);
        }
      }
    }
    const text = texts.join("\n").trim();
    if (!text) {
      return null;
    }
    return { text, sessionId, usage };
  }

  // === Cursor-agent specific parsing ===
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  // Message groups in chronological order - preserves tool/assistant sequence
  // Each tool output becomes a separate group, assistant texts between tools can be merged
  const messageGroups: { type: "tool" | "assistant"; texts: string[] }[] = [];

  // Current group we're adding to
  let currentGroup: { type: "tool" | "assistant"; texts: string[] } | null = null;

  // Helper to get or create current assistant group
  const getOrCreateAssistantGroup = (): { type: "tool" | "assistant"; texts: string[] } => {
    if (!currentGroup || currentGroup.type !== "assistant") {
      currentGroup = { type: "assistant", texts: [] };
      messageGroups.push(currentGroup);
    }
    return currentGroup;
  };

  // Helper to start a new tool group
  const startToolGroup = (): { type: "tool" | "assistant"; texts: string[] } => {
    currentGroup = { type: "tool", texts: [] };
    messageGroups.push(currentGroup);
    return currentGroup;
  };

  // Legacy arrays for backward compatibility
  const _texts: string[] = [];
  const toolOutputs: string[] = []; // Tool outputs - separate from assistant
  const assistantTexts: string[] = []; // Assistant content - separate from tools
  let lastResultText: string | undefined; // Track the result text to avoid duplicates in finalize

  // Current accumulation state
  let thinkingContent = "";
  let thinkingStartTime: number | null = null; // Track when thinking started
  let assistantContent = "";

  // Helper to extract text from assistant message
  const extractAssistantText = (parsed: Record<string, unknown>): string | null => {
    const message = isRecord(parsed.message) ? parsed.message : null;
    const content = message?.content;
    const contentArray = Array.isArray(content) ? content : null;
    const firstContent = contentArray?.[0];
    return isRecord(firstContent) ? (firstContent.text as string) : null;
  };

  // Helper to extract tool output from tool_call message
  const extractToolOutput = (parsed: Record<string, unknown>): string | null => {
    const toolCall = isRecord(parsed.tool_call) ? parsed.tool_call : null;

    // DEBUG: Log all tool call keys
    if (toolCall) {
      const keys = Object.keys(toolCall).join(", ");
      log.info(`[parseCliJsonl] extractToolOutput: toolCall keys=${keys}`);
    }

    // Try shell tool call first
    const shellToolCall = isRecord(toolCall?.shellToolCall) ? toolCall.shellToolCall : null;
    if (shellToolCall) {
      // Extract the command that was executed
      const args = isRecord(shellToolCall.args) ? shellToolCall.args : null;
      const command = typeof args?.command === "string" ? args.command : null;

      const result = isRecord(shellToolCall.result) ? shellToolCall.result : null;
      if (!result) {
        log.info(`[parseCliJsonl] extractToolOutput: shellToolCall has no result`);
        return null;
      }

      if (isRecord(result.success)) {
        const stdout =
          typeof result.success.stdout === "string" ? result.success.stdout.trim() : "";
        const stderr =
          typeof result.success.stderr === "string" ? result.success.stderr.trim() : "";
        const exitCode = typeof result.success.exitCode === "number" ? result.success.exitCode : 0;

        // Always capture command result - even if no stdout/stderr, show exit code
        let output = "";
        if (command) {
          output += `$ ${command}\n`;
        }
        if (stdout) {
          output += stdout;
        }
        if (stderr) {
          output += (output ? "\n" : "") + `stderr: ${stderr}`;
        }
        output += `\n(exit code: ${exitCode})`;
        return `\`\`\`\n${output}\n\`\`\``;
      }
      if (isRecord(result.failure)) {
        const stderr =
          typeof result.failure.stderr === "string" ? result.failure.stderr.trim() : "";
        const exitCode = typeof result.failure.exitCode === "number" ? result.failure.exitCode : 1;
        let output = "";
        if (command) {
          output += `$ ${command}\n`;
        }
        output += `Command failed (exit code: ${exitCode})`;
        if (stderr) {
          output += `\nstderr: ${stderr}`;
        }
        return `\`\`\`\n${output}\n\`\`\``;
      }
    }

    // Try read tool call
    const readToolCall = isRecord(toolCall?.readToolCall) ? toolCall.readToolCall : null;
    if (readToolCall) {
      const args = isRecord(readToolCall.args) ? readToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(readToolCall.result) ? readToolCall.result : null;

      // DEBUG: log result structure
      if (readToolCall && !result) {
        log.info(
          `[parseCliJsonl] readToolCall has no result, full keys=${Object.keys(readToolCall).join(", ")}`,
        );
      }

      if (result) {
        let output = "";
        if (filePath) {
          output += `# ${filePath}\n`;
        }

        if (typeof result.content === "string") {
          output += result.content;
        } else if (typeof result.error === "string") {
          output += `Error: ${result.error}`;
        }

        if (output) {
          return `\`\`\`\n${output}\n\`\`\``;
        }
      }
    }

    // Try write tool call
    const writeToolCall = isRecord(toolCall?.writeToolCall) ? toolCall.writeToolCall : null;
    if (writeToolCall) {
      const args = isRecord(writeToolCall.args) ? writeToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(writeToolCall.result) ? writeToolCall.result : null;

      if (result) {
        let output = "";
        if (filePath) {
          output += `# ${filePath}\n`;
        }

        if (typeof result.success === "string") {
          output += result.success;
        } else if (typeof result.error === "string") {
          output += `Error: ${result.error}`;
        } else if (result.success === true) {
          output += "File written successfully";
        }

        if (output) {
          return `\`\`\`\n${output}\n\`\`\``;
        }
      }
    }

    // Try edit tool call
    const editToolCall = isRecord(toolCall?.editToolCall) ? toolCall.editToolCall : null;
    if (editToolCall) {
      const args = isRecord(editToolCall.args) ? editToolCall.args : null;
      const filePath = typeof args?.file_path === "string" ? args.file_path : null;
      const result = isRecord(editToolCall.result) ? editToolCall.result : null;

      // DEBUG: log full result structure including success type
      log.info(
        `[parseCliJsonl] editToolCall: argsKeys=${args ? Object.keys(args).join(", ") : "none"}, resultKeys=${result ? Object.keys(result).join(", ") : "none"}, resultSuccessType=${result ? typeof result.success : "N/A"}, resultSuccessValue=${result ? JSON.stringify(result.success) : "N/A"}`,
      );

      // DEBUG: log result structure
      if (editToolCall && !result) {
        log.info(
          `[parseCliJsonl] editToolCall has no result, full keys=${Object.keys(editToolCall).join(", ")}`,
        );
      }

      if (result) {
        let output = "";
        if (filePath) {
          output += `# ${filePath}\n`;
        }

        // Handle various result formats
        const successVal = result?.success;
        if (typeof successVal === "string" && successVal) {
          output += successVal;
        } else if (typeof result?.error === "string") {
          output += `Error: ${result.error}`;
        } else if (successVal === true) {
          output += "File edited successfully";
        } else if (successVal === false) {
          output += "File edit failed";
        } else if (typeof successVal === "object" && successVal !== null) {
          // Handle object format: { path, linesAdded, linesRemoved, diffString, ... }
          const editResult = successVal as Record<string, unknown>;
          if (editResult.path) {
            output += `# ${editResult.path}\n`;
          }
          if (
            typeof editResult.linesAdded === "number" &&
            typeof editResult.linesRemoved === "number"
          ) {
            output += `+${editResult.linesAdded} -${editResult.linesRemoved}\n`;
          }
          if (typeof editResult.diffString === "string") {
            output += editResult.diffString;
          } else {
            output += JSON.stringify(editResult, null, 2);
          }
        } else if (successVal !== undefined) {
          // Handle other truthy values
          output += String(successVal);
        } else {
          // DEBUG: log unknown result format
          log.info(
            `[parseCliJsonl] editToolCall result has unknown format, keys=${Object.keys(result).join(", ")}, successVal=${successVal}, successType=${typeof successVal}`,
          );
        }

        if (output) {
          return `\`\`\`\n${output}\n\`\`\``;
        }
      }
    }

    // Try search tool call
    const searchToolCall = isRecord(toolCall?.searchToolCall) ? toolCall.searchToolCall : null;
    if (searchToolCall) {
      const result = isRecord(searchToolCall.result) ? searchToolCall.result : null;

      if (result && typeof result.results === "string") {
        return `\`\`\`\n${result.results}\n\`\`\``;
      }
    }

    // DEBUG: Log unknown tool type
    if (toolCall && Object.keys(toolCall).length > 0) {
      const keys = Object.keys(toolCall).join(", ");
      log.info(`[parseCliJsonl] extractToolOutput returning null: unknown tool type, keys=${keys}`);
    }

    return null;
  };

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const msgType = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";
    const toolSubtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : "";

    // DEBUG: Log all tool_call events with their subtypes
    if (msgType === "tool_call") {
      log.info(
        `[parseCliJsonl] tool_call event: subtype=${toolSubtype}, hasToolCall=${!!parsed.tool_call}`,
      );
    }

    if (!sessionId) {
      sessionId = pickSessionId(parsed, backend);
    }
    if (!sessionId && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id.trim();
    }
    if (isRecord(parsed.usage)) {
      usage = toUsage(parsed.usage) ?? usage;
    }

    // const msgType = typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

    // Thinking: accumulate deltas
    if (msgType === "thinking") {
      const subtype = typeof parsed.subtype === "string" ? parsed.subtype.toLowerCase() : "";
      if (subtype === "delta" && typeof parsed.text === "string") {
        // Track start time on first thinking delta
        if (thinkingStartTime === null) {
          thinkingStartTime = Date.now();
        }
        thinkingContent += parsed.text;
      }
      continue;
    }

    // Assistant: accumulate deltas, handle consolidation
    if (msgType === "assistant") {
      const text = extractAssistantText(parsed);
      if (typeof text === "string" && text.trim()) {
        const currentKey = parsed.model_call_id as string | undefined;

        // Check if this is a consolidated message (has model_call_id)
        // Consolidated messages replace accumulated content, not append
        if (currentKey) {
          // This is a consolidated message - replace accumulated content
          assistantContent = text;
        } else {
          // This is a delta message - accumulate it
          // Check if we already have content and if so, check for consolidation
          if (
            assistantContent &&
            (text.includes(assistantContent) || assistantContent.includes(text))
          ) {
            // Already have this content, skip to avoid duplicates
          } else {
            assistantContent += text;
          }
        }
      }
      continue;
    }

    // Tool call completed: flush assistant, add tool output
    if (msgType === "tool_call" && toolSubtype === "completed") {
      const toolCall = isRecord(parsed.tool_call) ? parsed.tool_call : null;
      const isShellTool = isRecord(toolCall?.shellToolCall);

      // Only flush assistant content for shell tool calls (user commands)
      // Skip flushing for read tool calls (workspace file reads are preparation, not response)
      if (assistantContent.trim() && isShellTool) {
        const assistantGroup = getOrCreateAssistantGroup();
        assistantGroup.texts.push(assistantContent.trim());
        assistantTexts.push(assistantContent.trim());
        log.info(
          `[parseCliJsonl] pushed assistant content to group, assistantGroup.texts.length=${assistantGroup.texts.length}`,
        );
      }

      // Only clear assistant content for shell tool calls, not for read tools
      // This preserves assistant content across multiple read tool calls
      if (isShellTool) {
        assistantContent = "";
      }

      // Add tool output - start a new tool group
      const toolOutput = extractToolOutput(parsed);
      if (toolOutput) {
        const toolGroup = startToolGroup();
        toolGroup.texts.push(toolOutput);
        toolOutputs.push(toolOutput);
      }
      continue;
    }

    // Result: final consolidated output
    // Always include the final result (it may contain a summary after tool calls)
    if (msgType === "result" && typeof parsed.result === "string") {
      const resultPreview =
        parsed.result.length > 80
          ? parsed.result.slice(0, 80).replace(/\n/g, "\\n") + "..."
          : parsed.result.replace(/\n/g, "\\n");
      log.info(
        `[parseCliJsonl] result event: toolOutputs.length=${toolOutputs.length}, assistantTexts.length=${assistantTexts.length}, resultPreview=${resultPreview}`,
      );

      // Only flush remaining assistant content if we have no tool output
      // (assistant content after tool call is not useful)
      if (assistantContent.trim() && toolOutputs.length === 0) {
        const assistantGroup = getOrCreateAssistantGroup();
        assistantGroup.texts.push(assistantContent.trim());
        assistantTexts.push(assistantContent.trim());
      }

      // Check if result is duplicate of last assistant text (avoid sending same content twice)
      const lastAssistantText =
        assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : "";
      const resultTrimmed = parsed.result.trim();

      // Only add result if it's substantially different from the last assistant text
      // (use length difference as a heuristic - if lengths are very different, it's different content)
      const isDuplicate =
        lastAssistantText &&
        (resultTrimmed === lastAssistantText.trim() ||
          (resultTrimmed.includes(lastAssistantText.trim()) &&
            Math.abs(resultTrimmed.length - lastAssistantText.trim().length) < 100) ||
          (lastAssistantText.trim().includes(resultTrimmed) &&
            Math.abs(lastAssistantText.trim().length - resultTrimmed.length) < 100));

      // DEBUG: log duplicate check details
      log.info(
        `[parseCliJsonl] result duplicate check: lastAssistantText_len=${lastAssistantText.length}, result_len=${resultTrimmed.length}, isDuplicate=${isDuplicate}, toolOutputs_len=${toolOutputs.length}`,
      );

      if (!isDuplicate) {
        const assistantGroup = getOrCreateAssistantGroup();
        assistantGroup.texts.push(parsed.result);
        assistantTexts.push(parsed.result);
        lastResultText = parsed.result.trim();
        log.info(
          `[parseCliJsonl] result added to assistant group, group_id=${messageGroups.length - 1}`,
        );
      } else {
        log.info(`[parseCliJsonl] skipping duplicate result text`);
      }

      // Clear thinking content
      thinkingContent = "";
      continue;
    }
  }

  // Finalize: flush remaining thinking (show timing instead of content)
  const finalTexts: string[] = [];

  // Flush any remaining assistant content after the last tool call
  // This handles the case where the final assistant message comes after the last tool
  // BUT only if we haven't already added the result (to avoid duplicates)
  const hasResultText = lastResultText
    ? messageGroups.some(
        (g) => g.type === "assistant" && g.texts.some((t) => t.includes(lastResultText!)),
      )
    : false;
  if (assistantContent.trim() && !hasResultText) {
    const assistantGroup = getOrCreateAssistantGroup();
    assistantGroup.texts.push(assistantContent.trim());
    assistantTexts.push(assistantContent.trim());
  }

  // Show thinking duration instead of full content
  if (thinkingContent.trim() && thinkingStartTime !== null) {
    const thinkingDurationMs = Date.now() - thinkingStartTime;
    const thinkingDurationSec = (thinkingDurationMs / 1000).toFixed(1);
    finalTexts.push(`🤔 Thinking for ${thinkingDurationSec}s`);
  }

  // Build finalTexts from messageGroups for backward compatibility
  // Each group becomes one text (tool = single, assistant = joined)
  for (const group of messageGroups) {
    if (group.type === "tool") {
      // Tool outputs: each tool is a separate entry
      for (const text of group.texts) {
        if (text.trim()) {
          finalTexts.push(text.trim());
        }
      }
    } else {
      // Assistant texts: merge texts within the group
      const joined = group.texts.join("\n\n");
      if (joined.trim()) {
        finalTexts.push(joined.trim());
      }
    }
  }

  // Debug log message groups
  log.info(`[parseCliJsonl] final messageGroups: count=${messageGroups.length}`);
  for (let i = 0; i < messageGroups.length; i++) {
    const g = messageGroups[i];
    const preview = g.texts.join(" | ").slice(0, 100).replace(/\n/g, "\\n");
    log.info(
      `[parseCliJsonl] group[${i}]: type=${g.type}, textsCount=${g.texts.length}, preview=${preview}...`,
    );
  }

  if (finalTexts.length > 0) {
    return { texts: finalTexts, toolOutputs, assistantTexts, messageGroups, sessionId, usage };
  }

  return null;
}

export function resolveSystemPromptUsage(params: {
  backend: CliBackendConfig;
  isNewSession: boolean;
  systemPrompt?: string;
}): string | null {
  const systemPrompt = params.systemPrompt?.trim();
  if (!systemPrompt) {
    return null;
  }
  const when = params.backend.systemPromptWhen ?? "first";
  if (when === "never") {
    return null;
  }
  if (when === "first" && !params.isNewSession) {
    return null;
  }
  if (!params.backend.systemPromptArg?.trim()) {
    return null;
  }
  return systemPrompt;
}

export function resolveSessionIdToSend(params: {
  backend: CliBackendConfig;
  cliSessionId?: string;
}): { sessionId?: string; isNew: boolean } {
  const mode = params.backend.sessionMode ?? "always";
  const existing = params.cliSessionId?.trim();
  if (mode === "none") {
    return { sessionId: undefined, isNew: !existing };
  }
  if (mode === "existing") {
    return { sessionId: existing, isNew: !existing };
  }
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

export function resolvePromptInput(params: { backend: CliBackendConfig; prompt: string }): {
  argsPrompt?: string;
  stdin?: string;
} {
  const inputMode = params.backend.input ?? "arg";
  if (inputMode === "stdin") {
    return { stdin: params.prompt };
  }
  if (params.backend.maxPromptArgChars && params.prompt.length > params.backend.maxPromptArgChars) {
    return { stdin: params.prompt };
  }
  return { argsPrompt: params.prompt };
}

function resolveImageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  return "bin";
}

export function appendImagePathsToPrompt(prompt: string, paths: string[]): string {
  if (!paths.length) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  const separator = trimmed ? "\n\n" : "";
  return `${trimmed}${separator}${paths.join("\n")}`;
}

export async function writeCliImages(
  images: ImageContent[],
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-images-"));
  const paths: string[] = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const ext = resolveImageExtension(image.mimeType);
    const filePath = path.join(tempDir, `image-${i + 1}.${ext}`);
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
    paths.push(filePath);
  }
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };
  return { paths, cleanup };
}

export function buildCliArgs(params: {
  backend: CliBackendConfig;
  baseArgs: string[];
  modelId: string;
  sessionId?: string;
  systemPrompt?: string | null;
  imagePaths?: string[];
  promptArg?: string;
  useResume: boolean;
}): string[] {
  const args: string[] = [...params.baseArgs];
  if (!params.useResume && params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (!params.useResume && params.systemPrompt && params.backend.systemPromptArg) {
    args.push(params.backend.systemPromptArg, params.systemPrompt);
  }
  if (!params.useResume && params.sessionId) {
    if (params.backend.sessionArgs && params.backend.sessionArgs.length > 0) {
      for (const entry of params.backend.sessionArgs) {
        args.push(entry.replaceAll("{sessionId}", params.sessionId));
      }
    } else if (params.backend.sessionArg) {
      args.push(params.backend.sessionArg, params.sessionId);
    }
  }
  if (params.imagePaths && params.imagePaths.length > 0) {
    const mode = params.backend.imageMode ?? "repeat";
    const imageArg = params.backend.imageArg;
    if (imageArg) {
      if (mode === "list") {
        args.push(imageArg, params.imagePaths.join(","));
      } else {
        for (const imagePath of params.imagePaths) {
          args.push(imageArg, imagePath);
        }
      }
    }
  }
  if (params.promptArg !== undefined) {
    args.push(params.promptArg);
  }
  return args;
}
