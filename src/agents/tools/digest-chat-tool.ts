/**
 * digest_chat tool — multi-chat history digest (fork extension).
 *
 * Reads recent message history from one or more chats and returns a
 * structured digest. The agent can use this to build a daily/hourly
 * summary across multiple groups or DMs without opening separate
 * read_chat_history calls in a loop.
 *
 * Optionally sends the formatted digest to a target chat via the gateway.
 *
 * Only registered when `crossContextRoutes` is present in the active config.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
} from "../../config/sessions.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  evaluateCrossContextRoutePolicy,
  resolveChatAlias,
} from "../../routing/cross-context-routes.js";
import { findSessionEntryForChat, readTranscriptMessages } from "./chat-history-reader.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveGatewayOptions } from "./gateway.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SOURCES = 10;

export type DigestChatToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  /** Chat/channel ID the current session is bound to (for policy evaluation). */
  currentChannelId?: string;
  /** Channel provider the current session is bound to (e.g. "telegram"). */
  currentChannelProvider?: string;
};

export function createDigestChatTool(options?: DigestChatToolOptions): AnyAgentTool {
  return {
    label: "DigestChat",
    name: "digest_chat",
    description:
      "Read recent message history from one or more chats and return a structured digest. " +
      "Use this to build a summary of activity across multiple groups or DMs. " +
      `Maximum ${MAX_SOURCES} source chats per call. ` +
      "Optionally send the digest to a target chat. " +
      "Only works for chats allowed by crossContextRoutes config.",
    parameters: Type.Object({
      channel: Type.String({
        description: "Channel provider for all sources, e.g. 'telegram'.",
      }),
      chatIds: Type.Array(Type.String(), {
        description: `List of source chat IDs or aliases to include in the digest. Maximum ${MAX_SOURCES} entries.`,
        maxItems: MAX_SOURCES,
      }),
      limit: Type.Optional(
        Type.Number({
          description: `Max messages to read per chat (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        }),
      ),
      sendTo: Type.Optional(
        Type.String({
          description:
            "If provided, send the formatted digest text to this chat ID or alias after building it.",
        }),
      ),
      sendToThreadId: Type.Optional(
        Type.Number({
          description: "Forum topic / thread id for the sendTo target (if applicable).",
        }),
      ),
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();

      const channel = readStringParam(params, "channel", { required: true });
      const rawChatIds = Array.isArray(params.chatIds)
        ? (params.chatIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const rawLimit = readNumberParam(params, "limit");
      const limit = Math.min(rawLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const sendTo = readStringParam(params, "sendTo");
      const sendToThreadId = readNumberParam(params, "sendToThreadId");

      if (!channel) {
        return jsonResult({ ok: false, error: "digest_chat: 'channel' is required." });
      }
      if (rawChatIds.length === 0) {
        return jsonResult({
          ok: false,
          error: "digest_chat: 'chatIds' must be a non-empty array.",
        });
      }
      if (rawChatIds.length > MAX_SOURCES) {
        return jsonResult({
          ok: false,
          error: `digest_chat: too many sources (${rawChatIds.length}). Maximum is ${MAX_SOURCES}.`,
        });
      }

      const fromChannel = options?.currentChannelProvider ?? channel;
      const fromChatId = options?.currentChannelId ?? "";
      const storePath = resolveDefaultSessionStorePath();
      const store = loadSessionStore(storePath);

      // Read each source chat in parallel.
      const chatDigests = await Promise.all(
        rawChatIds.map(async (rawChatId) => {
          const chatId = resolveChatAlias(cfg, rawChatId);

          // Policy check per source chat.
          const routeResult = evaluateCrossContextRoutePolicy({
            fromChannel,
            fromChatId,
            toChannel: channel,
            toChatId: chatId,
            cfg,
          });
          if (routeResult !== undefined && !routeResult.allowed) {
            return {
              chatId: rawChatId,
              resolvedId: chatId,
              ok: false,
              error: `blocked: ${routeResult.reason}`,
              messages: [],
            };
          }

          const found = findSessionEntryForChat(store, channel, chatId);
          if (!found) {
            return {
              chatId: rawChatId,
              resolvedId: chatId,
              ok: true,
              messages: [],
              note: "no session found",
            };
          }

          let filePath: string;
          try {
            filePath = resolveSessionFilePath(found.entry.sessionId, found.entry);
          } catch {
            return {
              chatId: rawChatId,
              resolvedId: chatId,
              ok: false,
              error: "could not resolve session file",
              messages: [],
            };
          }

          const messages = await readTranscriptMessages(filePath, limit);
          return {
            chatId: rawChatId,
            resolvedId: chatId,
            ok: true,
            messages,
          };
        }),
      );

      // Build a human-readable digest text.
      const sections: string[] = [];
      for (const chat of chatDigests) {
        if (!chat.ok) {
          sections.push(`## Chat ${chat.chatId}\n(skipped — ${chat.error ?? "unknown error"})`);
          continue;
        }
        if (chat.messages.length === 0) {
          sections.push(`## Chat ${chat.chatId}\n(no messages)`);
          continue;
        }
        const lines = chat.messages.map((m) => {
          const prefix = m.timestamp ? `[${m.timestamp}] ` : "";
          return `${prefix}${m.role === "user" ? "User" : "Assistant"}: ${m.text}`;
        });
        sections.push(`## Chat ${chat.chatId}\n${lines.join("\n\n")}`);
      }

      const digestText = sections.join("\n\n---\n\n");
      const totalMessages = chatDigests.reduce((sum, c) => sum + c.messages.length, 0);

      // Optionally forward digest to a target chat.
      let sendResult: { ok: boolean; error?: string } | undefined;
      if (sendTo) {
        const targetChatId = resolveChatAlias(cfg, sendTo);

        const sendRouteResult = evaluateCrossContextRoutePolicy({
          fromChannel,
          fromChatId,
          toChannel: channel,
          toChatId: targetChatId,
          cfg,
        });
        if (sendRouteResult !== undefined && !sendRouteResult.allowed) {
          sendResult = { ok: false, error: `send blocked: ${sendRouteResult.reason}` };
        } else {
          const gatewayResolved = resolveGatewayOptions({});
          const gateway = {
            url: gatewayResolved.url,
            token: gatewayResolved.token,
            timeoutMs: gatewayResolved.timeoutMs,
            clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
            clientDisplayName: "agent",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          };
          const outboundParams: Record<string, unknown> = {
            channel,
            target: targetChatId,
            message: digestText,
            ...(sendToThreadId != null ? { threadId: String(sendToThreadId) } : {}),
          };
          try {
            await runMessageAction({
              cfg,
              action: "send",
              params: outboundParams,
              gateway,
              abortSignal: signal,
            });
            sendResult = { ok: true };
          } catch (err) {
            sendResult = { ok: false, error: String(err) };
          }
        }
      }

      return jsonResult({
        ok: true,
        totalMessages,
        chats: chatDigests.map((c) => ({
          chatId: c.chatId,
          resolvedId: c.resolvedId,
          ok: c.ok,
          messageCount: c.messages.length,
          ...(c.error ? { error: c.error } : {}),
        })),
        digest: digestText,
        ...(sendResult !== undefined ? { sent: sendResult } : {}),
      });
    },
  };
}
