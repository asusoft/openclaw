/**
 * update_memory tool — write persistent cross-session notes (fork extension).
 *
 * Writes or deletes named sections in MEMORY.md within the agent workspace.
 * The file is injected into the system prompt at session start so the agent
 * always has access to previously stored notes across all chats and restarts.
 */

import { Type } from "@sinclair/typebox";
import { updateMemorySection } from "../memory-store.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export function createUpdateMemoryTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "UpdateMemory",
    name: "update_memory",
    description:
      "Write or delete a named section in persistent memory (MEMORY.md). " +
      "Memory survives restarts and is visible in every chat and session. " +
      "Use this to remember facts, decisions, team context, or anything worth keeping long-term. " +
      "Sections are markdown — use bullet lists, headings, or free prose.",
    parameters: Type.Object({
      section: Type.String({
        description: "Section name (e.g. 'Project Context', 'Team', 'Decisions', 'Person: Alice').",
      }),
      content: Type.Optional(
        Type.String({
          description: "Markdown content to write. Required for 'replace' and 'append' modes.",
        }),
      ),
      mode: Type.Optional(
        Type.String({
          description:
            "'replace' (default): overwrite the section. 'append': add below existing. 'delete': remove the section.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const section = readStringParam(params, "section", { required: true });
      const content = readStringParam(params, "content") ?? "";
      const modeRaw = readStringParam(params, "mode") ?? "replace";
      const mode = (["replace", "append", "delete"].includes(modeRaw) ? modeRaw : "replace") as
        | "replace"
        | "append"
        | "delete";

      if (!section) {
        return jsonResult({ ok: false, error: "update_memory: 'section' is required." });
      }
      if (mode !== "delete" && !content.trim()) {
        return jsonResult({
          ok: false,
          error: "update_memory: 'content' is required for replace/append.",
        });
      }

      await updateMemorySection(workspaceDir, section, content, mode);
      return jsonResult({ ok: true, section, mode });
    },
  };
}
