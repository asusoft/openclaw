/**
 * People registry — PEOPLE.md (fork extension).
 *
 * Auto-builds a profile stub for each known Telegram sender. Stubs are created
 * lazily on first message and updated with last-active date on subsequent ones.
 * Agents can enrich stubs via the `update_memory` tool (section "Person: <id>").
 *
 * The file is injected into the agent system prompt so the agent always knows
 * who it's talking to without asking.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";

export const PEOPLE_FILENAME = "PEOPLE.md";

export type PersonRegistryEntry = {
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  /** Display title of the chat where this message was seen. */
  seenInChatTitle?: string;
  /** Chat type for location context. */
  seenInChatType?: "dm" | "group" | "supergroup" | "channel";
};

const REGISTRY_HEADER = [
  "# People",
  "",
  "Known contacts seen across all conversations. Use `update_memory` with section 'Person: <id>' to add notes.",
  "",
].join("\n");

const H2 = "## ";
const LAST_ACTIVE_PREFIX = "- **Last active**:";
const FIRST_SEEN_PREFIX = "- **First seen**:";

function buildDisplayName(entry: PersonRegistryEntry): string {
  const parts = [entry.firstName, entry.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : entry.userId;
}

function buildHeading(entry: PersonRegistryEntry): string {
  const display = buildDisplayName(entry);
  const handle = entry.username ? `@${entry.username} ` : "";
  return `${H2}${handle}(${entry.userId}) — ${display}`;
}

function buildLocation(entry: PersonRegistryEntry, date: string): string {
  const where = entry.seenInChatTitle
    ? ` in ${entry.seenInChatTitle}${entry.seenInChatType === "dm" ? " (DM)" : ""}`
    : "";
  return `${date}${where}`;
}

/**
 * Upserts a person entry in PEOPLE.md within the given workspace directory.
 * On first occurrence: creates a stub with name, username, first/last seen.
 * On subsequent messages: updates the last-active line only.
 */
export async function updatePeopleRegistry(
  workspaceDir: string,
  entry: PersonRegistryEntry,
): Promise<void> {
  const filePath = path.join(workspaceDir, PEOPLE_FILENAME);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const location = buildLocation(entry, today);
  const idMarker = `(${entry.userId})`;

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // Will create below.
  }

  if (existing.trim()) {
    const lines = existing.split("\n");
    const headingIdx = lines.findIndex((l) => l.startsWith(H2) && l.includes(idMarker));

    if (headingIdx !== -1) {
      // Find section bounds.
      let sectionEnd = lines.length;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith(H2)) {
          sectionEnd = i;
          break;
        }
      }
      // Update last-active line.
      const newLastActive = `${LAST_ACTIVE_PREFIX} ${location}`;
      const lastActiveIdx = lines.findIndex(
        (l, i) => i > headingIdx && i < sectionEnd && l.startsWith(LAST_ACTIVE_PREFIX),
      );
      if (lastActiveIdx !== -1) {
        if (lines[lastActiveIdx] === newLastActive) {
          return;
        } // No change.
        lines[lastActiveIdx] = newLastActive;
      } else {
        lines.splice(headingIdx + 1, 0, newLastActive);
      }
      await fs.writeFile(filePath, lines.join("\n"));
      return;
    }

    // Append new person.
    const stub = [
      buildHeading(entry),
      `${FIRST_SEEN_PREFIX} ${location}`,
      `${LAST_ACTIVE_PREFIX} ${location}`,
    ].join("\n");
    const trimmed = existing.trimEnd();
    await fs.writeFile(filePath, `${trimmed}\n\n${stub}\n`);
    return;
  }

  // Bootstrap new file.
  await fs.mkdir(workspaceDir, { recursive: true });
  const stub = [
    buildHeading(entry),
    `${FIRST_SEEN_PREFIX} ${location}`,
    `${LAST_ACTIVE_PREFIX} ${location}`,
  ].join("\n");
  await fs.writeFile(filePath, `${REGISTRY_HEADER}${stub}\n`);
}

/**
 * Upserts a person entry in PEOPLE.md for every configured agent workspace.
 * Fire-and-forget friendly — individual failures are silently swallowed.
 */
export async function updatePeopleRegistryForAllWorkspaces(
  cfg: OpenClawConfig,
  entry: PersonRegistryEntry,
): Promise<void> {
  const dirs = new Set<string>([DEFAULT_AGENT_WORKSPACE_DIR]);
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId));
  }
  await Promise.all([...dirs].map((dir) => updatePeopleRegistry(dir, entry).catch(() => void 0)));
}

/**
 * Load PEOPLE.md as an embedded context file for system prompt injection.
 * Returns null when the file is empty or has no entries.
 */
export async function loadPeopleRegistryAsContextFile(workspaceDir: string): Promise<{
  path: string;
  content: string;
} | null> {
  const filePath = path.join(workspaceDir, PEOPLE_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim() || !content.includes(H2)) {
      return null;
    }
    return { path: filePath, content };
  } catch {
    return null;
  }
}
