import type { ImageContent } from "@mariozechner/pi-ai";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { shouldLogVerbose } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import {
  appendImagePathsToPrompt,
  buildCliArgs,
  buildSystemPrompt,
  enqueueCliRun,
  normalizeCliModel,
  parseCliJson,
  parseCliJsonl,
  parseCliJsonlLine,
  resolveCliNoOutputTimeoutMs,
  resolvePromptInput,
  resolveSessionIdToSend,
  resolveSystemPromptUsage,
  writeCliImages,
} from "./cli-runner/helpers.js";
import { resolveOpenClawDocsPath } from "./docs-path.js";
import { FailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "./workspace-run.js";

const log = createSubsystemLogger("agent/claude-cli");

/** Streaming callbacks for CLI agent output */
export type CliAgentStreamCallbacks = {
  /** Called when reasoning/thinking content is received */
  onReasoning?: (text: string) => void;
  /** Called when assistant message content is received */
  onAssistant?: (text: string) => void;
  /** Called when tool result is received */
  onToolResult?: (text: string) => void;
  /** Flush buffer and return total characters sent via streaming */
  flushAndGetSentCount?: () => number;
};

export async function runCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  streamParams?: import("../commands/agent/types.js").AgentStreamParams;
  ownerNumbers?: string[];
  cliSessionId?: string;
  images?: ImageContent[];
  /** Streaming callbacks for real-time output */
  streamCallbacks?: CliAgentStreamCallbacks;
}): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const workspaceResolution = resolveRunWorkspaceDir({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  const resolvedWorkspace = workspaceResolution.workspaceDir;
  const redactedSessionId = redactRunIdentifier(params.sessionId);
  const redactedSessionKey = redactRunIdentifier(params.sessionKey);
  const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
  if (workspaceResolution.usedFallback) {
    log.warn(
      `[workspace-fallback] caller=runCliAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
    );
  }
  const workspaceDir = resolvedWorkspace;

  const backendResolved = resolveCliBackendConfig(params.provider, params.config);
  if (!backendResolved) {
    throw new Error(`Unknown CLI backend: ${params.provider}`);
  }
  const backend = backendResolved.config;
  const modelId = (params.model ?? "default").trim() || "default";
  const normalizedModel = normalizeCliModel(modelId, backend);
  const modelDisplay = `${params.provider}/${modelId}`;

  const extraSystemPrompt = [
    params.extraSystemPrompt?.trim(),
    "Tools are disabled in this session. Do not call tools.",
  ]
    .filter(Boolean)
    .join("\n");

  const sessionLabel = params.sessionKey ?? params.sessionId;
  const { contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    warn: makeBootstrapWarn({ sessionLabel, warn: (message) => log.warn(message) }),
  });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const heartbeatPrompt =
    sessionAgentId === defaultAgentId
      ? resolveHeartbeatPrompt(params.config?.agents?.defaults?.heartbeat?.prompt)
      : undefined;
  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  const systemPrompt = buildSystemPrompt({
    workspaceDir,
    config: params.config,
    defaultThinkLevel: params.thinkLevel,
    extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    heartbeatPrompt,
    docsPath: docsPath ?? undefined,
    tools: [],
    contextFiles,
    modelDisplay,
    agentId: sessionAgentId,
  });

  const { sessionId: cliSessionIdToSend, isNew } = resolveSessionIdToSend({
    backend,
    cliSessionId: params.cliSessionId,
  });
  const useResume = Boolean(
    params.cliSessionId &&
    cliSessionIdToSend &&
    backend.resumeArgs &&
    backend.resumeArgs.length > 0,
  );
  const sessionIdSent = cliSessionIdToSend
    ? useResume || Boolean(backend.sessionArg) || Boolean(backend.sessionArgs?.length)
      ? cliSessionIdToSend
      : undefined
    : undefined;
  const systemPromptArg = resolveSystemPromptUsage({
    backend,
    isNewSession: isNew,
    systemPrompt,
  });

  let imagePaths: string[] | undefined;
  let cleanupImages: (() => Promise<void>) | undefined;
  let prompt = params.prompt;
  if (params.images && params.images.length > 0) {
    const imagePayload = await writeCliImages(params.images);
    imagePaths = imagePayload.paths;
    cleanupImages = imagePayload.cleanup;
    if (!backend.imageArg) {
      prompt = appendImagePathsToPrompt(prompt, imagePaths);
    }
  }

  const { argsPrompt, stdin } = resolvePromptInput({
    backend,
    prompt,
  });
  const stdinPayload = stdin ?? "";
  const baseArgs = useResume ? (backend.resumeArgs ?? backend.args ?? []) : (backend.args ?? []);
  const resolvedArgs = useResume
    ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", cliSessionIdToSend ?? ""))
    : baseArgs;
  const args = buildCliArgs({
    backend,
    baseArgs: resolvedArgs,
    modelId: normalizedModel,
    sessionId: cliSessionIdToSend,
    systemPrompt: systemPromptArg,
    imagePaths,
    promptArg: argsPrompt,
    useResume,
  });

  const serialize = backend.serialize ?? true;
  const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;

  try {
    const output = await enqueueCliRun(queueKey, async () => {
      log.info(
        `cli exec: provider=${params.provider} model=${normalizedModel} promptChars=${params.prompt.length}`,
      );
      const logOutputText = isTruthyEnvValue(process.env.OPENCLAW_CLAUDE_CLI_LOG_OUTPUT);
      if (logOutputText) {
        const logArgs: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i] ?? "";
          if (arg === backend.systemPromptArg) {
            const systemPromptValue = args[i + 1] ?? "";
            logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
            i += 1;
            continue;
          }
          if (arg === backend.sessionArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.modelArg) {
            logArgs.push(arg, args[i + 1] ?? "");
            i += 1;
            continue;
          }
          if (arg === backend.imageArg) {
            logArgs.push(arg, "<image>");
            i += 1;
            continue;
          }
          logArgs.push(arg);
        }
        if (argsPrompt) {
          const promptIndex = logArgs.indexOf(argsPrompt);
          if (promptIndex >= 0) {
            logArgs[promptIndex] = `<prompt:${argsPrompt.length} chars>`;
          }
        }
        log.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
      }

      const env = (() => {
        const next = { ...process.env, ...backend.env };
        for (const key of backend.clearEnv ?? []) {
          delete next[key];
        }
        return next;
      })();

      // Set up streaming callbacks if provided
      const streamCallbacks = params.streamCallbacks;
      const onLineCallback = streamCallbacks
        ? (line: string) => {
            const event = parseCliJsonlLine(line, backend);
            if (!event || !("text" in event)) {
              return;
            }
            if (shouldLogVerbose()) {
              log.debug(
                `[cli-streaming] event type: ${event.type}, text: ${event.text?.substring(0, 80)}...`,
              );
            }
            switch (event.type) {
              case "thinking":
                streamCallbacks.onReasoning?.(event.text);
                break;
              case "assistant":
                streamCallbacks.onAssistant?.(event.text);
                break;
              case "tool_result":
                streamCallbacks.onToolResult?.(event.text);
                break;
              // session_id and usage events are handled in final parse
            }
          }
        : undefined;

      const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
        backend,
        timeoutMs: params.timeoutMs,
        useResume,
      });
      const result = await runCommandWithTimeout([backend.command, ...args], {
        timeoutMs: params.timeoutMs,
        cwd: workspaceDir,
        env,
        input: stdinPayload,
        onLine: onLineCallback,
        noOutputTimeoutMs,
      });

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (logOutputText) {
        if (stdout) {
          log.info(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.info(`cli stderr:\n${stderr}`);
        }
      }
      if (shouldLogVerbose()) {
        if (stdout) {
          log.debug(`cli stdout:\n${stdout}`);
        }
        if (stderr) {
          log.debug(`cli stderr:\n${stderr}`);
        }
      }

      // Check if process was killed due to timeout
      if (result.killed) {
        log.warn(`cli process killed (timeout after ${params.timeoutMs}ms)`);
        // Try to parse partial output, but don't return raw incomplete JSON
        if (backend.output === "jsonl") {
          const parsed = parseCliJsonl(stdout, backend);
          if (parsed) {
            return {
              ...parsed,
              text: parsed.text
                ? `${parsed.text}\n\n⏳ 任务超时但仍在后台运行，可用 /resume 继续`
                : undefined,
            };
          }
        }
        // Return a clear message about timeout instead of garbled partial JSON
        return {
          text: "⏳ 任务执行超时，但任务可能仍在后台运行。请等待片刻后发送消息继续对话，或使用 /resume 继续之前的任务。",
          sessionId: undefined,
        };
      }

      if (result.code !== 0) {
        const err = stderr || stdout || "CLI failed.";
        const reason = classifyFailoverReason(err) ?? "unknown";
        const status = resolveFailoverStatus(reason);
        throw new FailoverError(err, {
          reason,
          provider: params.provider,
          model: modelId,
          status,
        });
      }

      const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;

      if (outputMode === "text") {
        return { text: stdout, sessionId: undefined };
      }
      if (outputMode === "jsonl") {
        const parsed = parseCliJsonl(stdout, backend);
        return parsed ?? { text: stdout };
      }

      const parsed = parseCliJson(stdout, backend);
      return parsed ?? { text: stdout };
    });

    // Flush streaming buffer and get count of characters already sent to channel
    const charsSentViaStreaming = params.streamCallbacks?.flushAndGetSentCount?.() ?? 0;
    if (charsSentViaStreaming > 0) {
      log.debug(`[cli-streaming] flushed ${charsSentViaStreaming} chars sent via streaming`);
    }

    const text = output.text?.trim();

    // DEBUG: Log what parseCliJsonl returned - show all texts
    if (output.texts && output.texts.length > 0) {
      log.info(`[cli-streaming] parseCliJsonl returned texts: count=${output.texts.length}`);
      for (let i = 0; i < output.texts.length; i++) {
        const t = output.texts[i];
        log.info(
          `[cli-streaming] text[${i}] length=${t.length}, preview=${t.slice(0, 150).replace(/\n/g, "\\n")}`,
        );
      }
    }

    // DEBUG: Log tool outputs and assistant texts separately
    if (output.toolOutputs && output.toolOutputs.length > 0) {
      log.info(`[cli-streaming] toolOutputs: count=${output.toolOutputs.length}`);
    }
    if (output.assistantTexts && output.assistantTexts.length > 0) {
      log.info(`[cli-streaming] assistantTexts: count=${output.assistantTexts.length}`);
    }

    // DEBUG: Log message groups
    if (output.messageGroups && output.messageGroups.length > 0) {
      log.info(`[cli-streaming] messageGroups: count=${output.messageGroups.length}`);
      for (let i = 0; i < output.messageGroups.length; i++) {
        const g = output.messageGroups[i];
        const preview = g.texts.join(" | ").slice(0, 100).replace(/\n/g, "\\n");
        log.info(
          `[cli-streaming] group[${i}]: type=${g.type}, textsCount=${g.texts.length}, preview=${preview}...`,
        );
      }
    }

    // Build payloads from messageGroups: each group = 1 message
    // - tool group: each text is a separate message
    // - assistant group: texts within the group are joined together
    let payloads: { text: string }[] = [];

    if (output.messageGroups && output.messageGroups.length > 0) {
      for (const group of output.messageGroups) {
        if (group.type === "tool") {
          // Tool: each text is a separate message
          for (const text of group.texts) {
            if (text.trim()) {
              payloads.push({ text: text.trim() });
            }
          }
        } else {
          // Assistant: join texts within the group
          const joined = group.texts.join("\n\n");
          if (joined.trim()) {
            payloads.push({ text: joined.trim() });
          }
        }
      }
    }

    // Fallback: if no messageGroups but we have toolOutputs/assistantTexts (legacy format)
    if (payloads.length === 0 && output.toolOutputs && output.assistantTexts) {
      // Legacy handling - use toolOutputs and assistantTexts
      // Add tool outputs as separate messages
      for (const toolOutput of output.toolOutputs) {
        if (toolOutput.trim()) {
          payloads.push({ text: toolOutput });
        }
      }

      // Add assistant texts as a combined message
      const combinedAssistant = output.assistantTexts.join("\n\n");
      if (combinedAssistant.trim()) {
        payloads.push({ text: combinedAssistant });
      }
    }

    // Fallback: if no messageGroups or toolOutputs/assistantTexts but we have texts (legacy format)
    if (payloads.length === 0 && output.texts && output.texts.length > 0) {
      // Legacy handling - deduplicate and combine
      const seen = new Set<string>();
      const uniqueTexts: string[] = [];
      for (const t of output.texts) {
        const trimmed = t.trim();
        if (!trimmed) {
          continue;
        }
        if (seen.has(trimmed)) {
          continue;
        }

        // Check subset
        const isSubset = uniqueTexts.some((existing) => {
          const existingTrimmed = existing.trim();
          return existingTrimmed.includes(trimmed) && existingTrimmed.length > trimmed.length;
        });
        if (isSubset) {
          continue;
        }

        // Check reverse subset
        const existingIsSubset = uniqueTexts.findIndex((existing) => {
          const existingTrimmed = existing.trim();
          return trimmed.includes(existingTrimmed) && trimmed.length > existingTrimmed.length;
        });
        if (existingIsSubset !== -1) {
          uniqueTexts.splice(existingIsSubset, 1);
        }

        seen.add(trimmed);
        uniqueTexts.push(t);
      }

      const combinedText = uniqueTexts.join("\n\n");
      if (combinedText) {
        payloads = [{ text: combinedText }];
      }
    } else if (payloads.length === 0 && text) {
      payloads = [{ text }];
    }

    return {
      payloads,
      meta: {
        durationMs: Date.now() - started,
        agentMeta: {
          sessionId:
            output.sessionId ?? sessionIdSent ?? params.cliSessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: modelId,
          usage: output.usage,
        },
      },
      // Flag to indicate streaming sent to channel - used to avoid duplicates
      streamingSentToChannel: charsSentViaStreaming > 0,
      streamingCharsSent: charsSentViaStreaming,
    };
  } catch (err) {
    if (err instanceof FailoverError) {
      // Check if this is a session expired error and we have a session to clear
      if (err.reason === "session_expired" && params.cliSessionId && params.sessionKey) {
        log.warn(
          `CLI session expired, clearing session ID and retrying: provider=${params.provider} session=${redactRunIdentifier(params.cliSessionId)}`,
        );

        // Clear the expired session ID from the session entry
        // This requires access to the session store, which we don't have here
        // We'll need to modify the caller to handle this case

        // Retry without the session ID to create a new session
        return runCliAgent({
          ...params,
          cliSessionId: undefined,
        });
      }
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isFailoverErrorMessage(message)) {
      const reason = classifyFailoverReason(message) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: modelId,
        status,
      });
    }
    throw err;
  } finally {
    if (cleanupImages) {
      await cleanupImages();
    }
  }
}

export async function runClaudeCliAgent(params: {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  prompt: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  timeoutMs: number;
  runId: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  claudeSessionId?: string;
  images?: ImageContent[];
}): Promise<EmbeddedPiRunResult> {
  return runCliAgent({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    cliSessionId: params.claudeSessionId,
    images: params.images,
  });
}
