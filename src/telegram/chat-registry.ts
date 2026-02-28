/**
 * Cross-context chat registry.
 *
 * Maintains CHATS.md in the agent workspace directory so agents can resolve
 * natural language names ("the dev group") to Telegram chat IDs when using
 * the send_to_chat tool with crossContextRoutes configured.
 *
 * The file is updated lazily (fire-and-forget) on every inbound message.
 * Agents can reference it to discover available chat IDs without needing
 * the operator to hard-code them in the tool call.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/config.js";

export const CHAT_REGISTRY_FILENAME = "CHATS.md";

export type ChatRegistryEntry = {
  chatId: string;
  title: string;
  type: "group" | "supergroup" | "dm" | "channel";
  /** Optional alias name from chatAliases config. */
  alias?: string;
};

const REGISTRY_HEADER = [
  "# Chat Registry",
  "",
  "Known Telegram chats this assistant has seen. Use these IDs (or alias names) with `send_to_chat`.",
  "",
].join("\n");

function buildEntryLine(entry: ChatRegistryEntry): string {
  const typeLabel =
    entry.type === "dm"
      ? "DM"
      : entry.type === "supergroup"
        ? "supergroup"
        : entry.type === "channel"
          ? "channel"
          : "group";
  const aliasSuffix = entry.alias ? ` | alias: **${entry.alias}**` : "";
  return `- **${entry.chatId}** — ${entry.title} (${typeLabel})${aliasSuffix}`;
}

/**
 * Upserts a chat entry in CHATS.md within the given workspace directory.
 * Idempotent: same chatId updates title/type in-place; new chatId appends.
 * Writes are atomic — the file is read then replaced only when content changes.
 */
export async function updateChatRegistry(
  workspaceDir: string,
  entry: ChatRegistryEntry,
): Promise<void> {
  const filePath = path.join(workspaceDir, CHAT_REGISTRY_FILENAME);

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // File doesn't exist yet — will create below.
  }

  const newLine = buildEntryLine(entry);
  const idPrefix = `- **${entry.chatId}**`;

  if (existing.trim()) {
    const lines = existing.split("\n");
    const idx = lines.findIndex((l) => l.startsWith(idPrefix));
    if (idx !== -1) {
      if (lines[idx] === newLine) {
        return; // Nothing changed.
      }
      lines[idx] = newLine;
      await fs.writeFile(filePath, lines.join("\n"));
      return;
    }
    // Append new entry.
    const trimmed = existing.trimEnd();
    await fs.writeFile(filePath, `${trimmed}\n${newLine}\n`);
    return;
  }

  // Bootstrap empty file with header.
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(filePath, `${REGISTRY_HEADER}${newLine}\n`);
}

/**
 * Upserts a chat entry in CHATS.md for every configured agent workspace.
 *
 * In multi-agent setups each agent may have a distinct workspace directory.
 * This ensures all agents can resolve chat IDs by name regardless of which
 * workspace they are bound to.  The default workspace is always included so
 * single-agent deployments keep working without any agents config.
 *
 * All writes are fire-and-forget; individual failures are silently swallowed
 * so a bad custom workspace path never blocks message processing.
 */
export async function updateChatRegistryForAllWorkspaces(
  cfg: OpenClawConfig,
  entry: ChatRegistryEntry,
): Promise<void> {
  // Resolve alias for this chatId from the chatAliases config map.
  const aliases = (cfg as { chatAliases?: Record<string, string> }).chatAliases;
  const alias = aliases
    ? Object.entries(aliases).find(([, id]) => id === entry.chatId)?.[0]
    : undefined;
  const enrichedEntry: ChatRegistryEntry = alias ? { ...entry, alias } : entry;

  // Collect the unique set of workspace dirs for all configured agents plus
  // the default workspace (covers deployments with no explicit agents config).
  const dirs = new Set<string>([DEFAULT_AGENT_WORKSPACE_DIR]);
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId));
  }
  await Promise.all(
    [...dirs].map((dir) => updateChatRegistry(dir, enrichedEntry).catch(() => void 0)),
  );
}

/**
 * Loads CHATS.md from the workspace directory as an embedded context file
 * suitable for injection into the agent system prompt.
 * Returns null if the file doesn't exist or is empty.
 */
export async function loadChatRegistryAsContextFile(workspaceDir: string): Promise<{
  path: string;
  content: string;
} | null> {
  const filePath = path.join(workspaceDir, CHAT_REGISTRY_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) {
      return null;
    }
    return { path: filePath, content };
  } catch {
    return null;
  }
}
