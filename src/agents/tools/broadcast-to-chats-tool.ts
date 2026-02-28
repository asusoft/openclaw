/**
 * broadcast_to_chats tool — fan-out messaging to multiple chats (fork extension).
 *
 * Sends the same message to multiple chat IDs in parallel. Each target is
 * independently alias-resolved and policy-checked via crossContextRoutes.
 * Results are returned per-chat so the agent knows which sends succeeded.
 *
 * Capped at 10 targets per call to prevent accidental spam.
 *
 * Only registered when `crossContextRoutes` is present in the active config.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import {
  evaluateCrossContextRoutePolicy,
  resolveChatAlias,
} from "../../routing/cross-context-routes.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveGatewayOptions } from "./gateway.js";

const MAX_TARGETS = 10;

export type BroadcastToChatsToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  /** Chat/channel ID the current session is bound to (for policy evaluation). */
  currentChannelId?: string;
  /** Channel provider the current session is bound to (e.g. "telegram"). */
  currentChannelProvider?: string;
};

export function createBroadcastToChatsTool(options?: BroadcastToChatsToolOptions): AnyAgentTool {
  return {
    label: "BroadcastToChats",
    name: "broadcast_to_chats",
    description:
      "Send the same message to multiple chats in one call. " +
      "Each chatId is alias-resolved and policy-checked independently. " +
      "Results include per-chat success/failure so you know exactly what was delivered. " +
      `Maximum ${MAX_TARGETS} targets per call. ` +
      "Use CHATS.md to look up available chat IDs and aliases.",
    parameters: Type.Object({
      channel: Type.String({
        description: "Channel provider for all targets, e.g. 'telegram'.",
      }),
      chatIds: Type.Array(Type.String(), {
        description:
          "List of target chat IDs or aliases (e.g. ['-1001234567890', 'dev-team', 'alerts']). " +
          `Maximum ${MAX_TARGETS} entries.`,
        maxItems: MAX_TARGETS,
      }),
      text: Type.Optional(Type.String({ description: "Message text to send to every target." })),
      threadId: Type.Optional(
        Type.Number({
          description: "Forum topic / thread id — applied to all targets that support it.",
        }),
      ),
      media: Type.Optional(
        Type.String({
          description: "Media URL or local file path to attach to every message.",
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
      const text = readStringParam(params, "text");
      const media = readStringParam(params, "media");
      const threadId = readNumberParam(params, "threadId");

      if (!channel) {
        return jsonResult({ ok: false, error: "broadcast_to_chats: 'channel' is required." });
      }
      if (rawChatIds.length === 0) {
        return jsonResult({
          ok: false,
          error: "broadcast_to_chats: 'chatIds' must be a non-empty array.",
        });
      }
      if (rawChatIds.length > MAX_TARGETS) {
        return jsonResult({
          ok: false,
          error: `broadcast_to_chats: too many targets (${rawChatIds.length}). Maximum is ${MAX_TARGETS}.`,
        });
      }
      if (!text && !media) {
        return jsonResult({
          ok: false,
          error: "broadcast_to_chats: provide at least 'text' or 'media'.",
        });
      }

      const gatewayResolved = resolveGatewayOptions({});
      const gateway = {
        url: gatewayResolved.url,
        token: gatewayResolved.token,
        timeoutMs: gatewayResolved.timeoutMs,
        clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        clientDisplayName: "agent",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      };

      const fromChannel = options?.currentChannelProvider ?? channel;
      const fromChatId = options?.currentChannelId ?? "";
      const toolContext =
        options?.currentChannelId || options?.currentChannelProvider
          ? {
              currentChannelId: options.currentChannelId,
              currentChannelProvider: options.currentChannelProvider,
            }
          : undefined;
      const agentId = options?.agentSessionKey
        ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
        : undefined;

      // Send to each target independently; collect results.
      const results = await Promise.allSettled(
        rawChatIds.map(async (rawChatId) => {
          const chatId = resolveChatAlias(cfg, rawChatId);

          // Per-target policy check.
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
            };
          }

          const outboundParams: Record<string, unknown> = {
            channel,
            target: chatId,
            ...(text ? { message: text } : {}),
            ...(media ? { media } : {}),
            ...(threadId != null ? { threadId: String(threadId) } : {}),
          };

          const result = await runMessageAction({
            cfg,
            action: "send",
            params: outboundParams,
            gateway,
            toolContext,
            sessionKey: options?.agentSessionKey,
            agentId,
            abortSignal: signal,
          });

          const toolResult = getToolResult(result);
          if (toolResult) {
            // getToolResult returns a formatted result; extract payload for embedding in our array.
            return { chatId: rawChatId, resolvedId: chatId, ok: true };
          }
          return { chatId: rawChatId, resolvedId: chatId, ok: true, detail: result.payload };
        }),
      );

      // Normalise Promise.allSettled outcomes into a flat array.
      const summary = results.map((r, i) => {
        if (r.status === "fulfilled") {
          return r.value;
        }
        return {
          chatId: rawChatIds[i],
          ok: false,
          error: String(r.reason),
        };
      });

      const allOk = summary.every((s) => s.ok);
      const sent = summary.filter((s) => s.ok).length;
      const failed = summary.filter((s) => !s.ok).length;
      return jsonResult({ ok: allOk, sent, failed, results: summary });
    },
  };
}
