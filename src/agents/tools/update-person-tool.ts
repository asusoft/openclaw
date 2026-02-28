/**
 * update_person tool — enrich a person profile in persistent memory (fork extension).
 *
 * Writes agent notes for a specific person into MEMORY.md under the section
 * "Person: <userId>". The section is visible at session start via system prompt
 * injection alongside the auto-generated PEOPLE.md stubs.
 *
 * This keeps auto-built stubs (PEOPLE.md) cleanly separate from agent-written
 * enrichment notes (MEMORY.md), while letting the agent annotate anyone it knows.
 */

import { Type } from "@sinclair/typebox";
import { updateMemorySection } from "../memory-store.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export function createUpdatePersonTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "UpdatePerson",
    name: "update_person",
    description:
      "Add or update notes about a specific person in persistent memory. " +
      "Notes are stored under 'Person: <userId>' in MEMORY.md and survive restarts. " +
      "Use this to record preferences, role, background, or anything worth remembering about someone. " +
      "The userId comes from PEOPLE.md (e.g. '123456789').",
    parameters: Type.Object({
      userId: Type.String({
        description: "Telegram user ID of the person (numeric string from PEOPLE.md).",
      }),
      notes: Type.String({
        description: "Markdown notes to store for this person.",
      }),
      mode: Type.Optional(
        Type.String({
          description:
            "'replace' (default): overwrite existing notes. 'append': add below existing notes.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const userId = readStringParam(params, "userId", { required: true });
      const notes = readStringParam(params, "notes", { required: true });
      const modeRaw = readStringParam(params, "mode") ?? "replace";
      const mode = (["replace", "append"].includes(modeRaw) ? modeRaw : "replace") as
        | "replace"
        | "append";

      if (!userId) {
        return jsonResult({ ok: false, error: "update_person: 'userId' is required." });
      }
      if (!notes?.trim()) {
        return jsonResult({ ok: false, error: "update_person: 'notes' is required." });
      }

      const section = `Person: ${userId}`;
      await updateMemorySection(workspaceDir, section, notes, mode);
      return jsonResult({ ok: true, userId, section, mode });
    },
  };
}
