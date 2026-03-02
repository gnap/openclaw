import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ExecToolDefaults } from "../bash-tools.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; OpenClaw enables it for specific models.
  if (!level) {
    return "off";
  }
  // "adaptive" maps to "medium" at the pi-agent-core layer.  The Pi SDK
  // provider then translates this to `thinking.type: "adaptive"` with
  // `output_config.effort: "medium"` for models that support it (Opus 4.6,
  // Sonnet 4.6).
  if (level === "adaptive") {
    return "medium";
  }
  return level;
}

export function resolveExecToolDefaults(config?: OpenClawConfig): ExecToolDefaults | undefined {
  const tools = config?.tools;
  if (!tools?.exec) {
    return undefined;
  }
  return tools.exec;
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
