/**
 * Shared JSONL session-transcript reading helpers used by
 * `read_chat_history` and `digest_chat` tools.
 */

import fs from "node:fs/promises";
import type { SessionEntry } from "../../config/sessions/types.js";

type ParsedSessionLine = {
  type: "message";
  message: {
    role: "user" | "assistant";
    content: Array<{ type: string; text?: string }>;
    timestamp?: number;
  };
};

export type TranscriptMessage = {
  role: string;
  text: string;
  timestamp: string;
};

export function extractTextFromContent(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text ?? "")
    .join(" ")
    .trim();
}

export function formatTimestamp(ts: number | undefined): string {
  if (!ts) {
    return "";
  }
  return new Date(ts)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "UTC");
}

/**
 * Find the best session store key for a given chatId.
 * Session keys take forms like:
 *   agent:main:telegram:group:-1001234567890
 *   agent:main:telegram:direct:123456789
 *   agent:main:telegram:12345
 * We search by chatId substring within channel keys and return the
 * most-recently-updated match (topic sub-sessions are skipped).
 */
export function findSessionEntryForChat(
  store: Record<string, SessionEntry>,
  channel: string,
  chatId: string,
): { key: string; entry: SessionEntry } | null {
  const needle = `:${chatId.trim()}`;
  let best: { key: string; entry: SessionEntry; updatedAt: number } | null = null;

  for (const [key, entry] of Object.entries(store)) {
    if (!key.includes(channel)) {
      continue;
    }
    if (!key.includes(needle)) {
      continue;
    }
    // Skip topic sub-sessions — prefer the parent group session for history.
    if (key.includes(":topic:")) {
      continue;
    }
    const updatedAt = entry?.updatedAt ?? 0;
    if (!best || updatedAt > best.updatedAt) {
      best = { key, entry, updatedAt };
    }
  }

  return best ? { key: best.key, entry: best.entry } : null;
}

export async function readTranscriptMessages(
  filePath: string,
  limit: number,
): Promise<TranscriptMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = parsed as ParsedSessionLine;
    if (msg?.type !== "message") {
      continue;
    }
    const role = msg.message?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(msg.message?.content);
    if (!text) {
      continue;
    }
    messages.push({
      role,
      text,
      timestamp: formatTimestamp(msg.message?.timestamp),
    });
  }

  return messages.slice(-limit);
}
