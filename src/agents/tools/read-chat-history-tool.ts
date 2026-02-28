/**
 * read_chat_history tool — cross-context session transcript reader (fork extension).
 *
 * Reads recent conversation history from a different Telegram chat's session
 * transcript.  Authorization is enforced by the same `crossContextRoutes` policy
 * used by `send_to_chat`.
 *
 * This tool is only registered when `crossContextRoutes` is present in the
 * active config.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
} from "../../config/sessions.js";
import { evaluateCrossContextRoutePolicy } from "../../routing/cross-context-routes.js";
import { findSessionEntryForChat, readTranscriptMessages } from "./chat-history-reader.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export type ReadChatHistoryToolOptions = {
  config?: OpenClawConfig;
  /** Chat/channel ID the current session is bound to (for policy evaluation). */
  currentChannelId?: string;
  /** Channel provider the current session is bound to (e.g. "telegram"). */
  currentChannelProvider?: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function createReadChatHistoryTool(options?: ReadChatHistoryToolOptions): AnyAgentTool {
  return {
    label: "ReadChatHistory",
    name: "read_chat_history",
    description:
      "Read recent conversation history from a different Telegram chat. " +
      "Returns the last N user/assistant turns from that chat's session transcript. " +
      "Use this to understand context before sending a cross-context message, or to " +
      "summarize recent activity in another group/DM. " +
      "Only works for chats allowed by crossContextRoutes config.",
    parameters: Type.Object({
      chatId: Type.String({
        description:
          "Telegram chat ID to read history from (e.g. '-1001234567890' for a group, " +
          "or a numeric user ID for a DM). Look up IDs in CHATS.md if available.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: `Max number of recent messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        }),
      ),
      channel: Type.Optional(
        Type.String({ description: "Channel provider. Defaults to 'telegram'." }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();

      const chatId = readStringParam(params, "chatId", { required: true });
      const channel = readStringParam(params, "channel") ?? "telegram";
      const rawLimit = readNumberParam(params, "limit");
      const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);

      if (!chatId) {
        return jsonResult({ ok: false, error: "read_chat_history: 'chatId' is required." });
      }

      // Policy check — same route evaluation as send_to_chat.
      const fromChannel = options?.currentChannelProvider ?? "telegram";
      const fromChatId = options?.currentChannelId ?? "";
      const routeResult = evaluateCrossContextRoutePolicy({
        fromChannel,
        fromChatId,
        toChannel: channel,
        toChatId: chatId,
        cfg,
      });
      if (routeResult !== undefined && !routeResult.allowed) {
        return jsonResult({
          ok: false,
          error:
            `read_chat_history blocked: ${routeResult.reason}. ` +
            "Add an entry to crossContextRoutes.allow in your config to permit reading this chat.",
        });
      }

      // Locate the session in the store.
      const storePath = resolveDefaultSessionStorePath();
      const store = loadSessionStore(storePath);
      const found = findSessionEntryForChat(store, channel, chatId);

      if (!found) {
        return jsonResult({
          ok: true,
          chatId,
          messageCount: 0,
          transcript:
            "(no session found — the bot may not have received any messages from this chat yet)",
        });
      }

      // Resolve the JSONL file path.
      let filePath: string;
      try {
        filePath = resolveSessionFilePath(found.entry.sessionId, found.entry);
      } catch (err) {
        return jsonResult({
          ok: false,
          error: `read_chat_history: could not resolve session file for ${channel}:${chatId} — ${String(err)}`,
        });
      }

      const messages = await readTranscriptMessages(filePath, limit);

      if (messages.length === 0) {
        return jsonResult({
          ok: true,
          chatId,
          messageCount: 0,
          transcript: "(session exists but transcript is empty)",
        });
      }

      const transcript = messages
        .map((m) => {
          const prefix = m.timestamp ? `[${m.timestamp}] ` : "";
          return `${prefix}${m.role === "user" ? "User" : "Assistant"}: ${m.text}`;
        })
        .join("\n\n");

      return jsonResult({
        ok: true,
        chatId,
        sessionKey: found.key,
        messageCount: messages.length,
        transcript,
      });
    },
  };
}
