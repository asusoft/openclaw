/**
 * send_to_chat tool — cross-context Telegram messaging (fork extension).
 *
 * Sends a message to an explicit target chat ID, which may differ from the
 * session's bound chat.  Authorization is enforced by the `crossContextRoutes`
 * config block via `enforceCrossContextPolicy` in the outbound layer.
 *
 * This tool is only registered when `crossContextRoutes` is present in the
 * active config, keeping the agent tool list clean for standard deployments.
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

export type SendToChatToolOptions = {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  /** Chat/channel ID the current session is bound to (for policy evaluation). */
  currentChannelId?: string;
  /** Channel provider the current session is bound to (e.g. "telegram"). */
  currentChannelProvider?: string;
};

export function createSendToChatTool(options?: SendToChatToolOptions): AnyAgentTool {
  return {
    label: "SendToChat",
    name: "send_to_chat",
    description:
      "Send a message to a specific chat (group or DM) that differs from the current session context. " +
      "Requires crossContextRoutes to be configured. " +
      "Use this to post from a DM session to a group, or for agent-to-agent cross-chat communication. " +
      "Provide channel (e.g. 'telegram') and chatId (e.g. '-1001234567890').",
    parameters: Type.Object({
      channel: Type.String({
        description: "Channel provider, e.g. 'telegram'.",
      }),
      chatId: Type.String({
        description:
          "Target chat ID or alias. Use the numeric id (e.g. '-1001234567890') or a configured alias name (e.g. 'dev-team'). Check CHATS.md for available IDs and aliases.",
      }),
      text: Type.Optional(Type.String({ description: "Message text to send." })),
      threadId: Type.Optional(
        Type.Number({ description: "Forum topic / thread id (Telegram supergroup topics)." }),
      ),
      media: Type.Optional(
        Type.String({
          description: "Media URL or local file path to attach alongside the message.",
        }),
      ),
      replyToMessageId: Type.Optional(
        Type.Number({ description: "Message id to reply to in the target chat." }),
      ),
    }),
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();

      const channel = readStringParam(params, "channel", { required: true });
      const rawChatId = readStringParam(params, "chatId", { required: true });
      const text = readStringParam(params, "text");
      const media = readStringParam(params, "media");
      const threadId = readNumberParam(params, "threadId");
      const replyToMessageId = readNumberParam(params, "replyToMessageId");

      if (!channel || !rawChatId) {
        return jsonResult({
          ok: false,
          error: "send_to_chat: 'channel' and 'chatId' are required.",
        });
      }

      // Resolve alias → numeric chat ID (no-op if already a raw ID).
      const chatId = resolveChatAlias(cfg, rawChatId);

      // Pre-flight policy check: give a clear error before the outbound layer fires.
      const fromChannel = options?.currentChannelProvider ?? channel;
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
            `send_to_chat blocked: ${routeResult.reason}. ` +
            "Add an entry to crossContextRoutes.allow in your config to permit this route.",
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

      // Build the outbound params in the same shape the message tool uses.
      const outboundParams: Record<string, unknown> = {
        channel,
        target: chatId,
        ...(text ? { message: text } : {}),
        ...(media ? { media } : {}),
        ...(threadId != null ? { threadId: String(threadId) } : {}),
        ...(replyToMessageId != null ? { replyTo: String(replyToMessageId) } : {}),
      };

      const toolContext =
        options?.currentChannelId || options?.currentChannelProvider
          ? {
              currentChannelId: options.currentChannelId,
              currentChannelProvider: options.currentChannelProvider,
              // Do NOT set skipCrossContextDecoration — the origin-marker prefix is
              // useful so recipients know where the message originated.
            }
          : undefined;

      const result = await runMessageAction({
        cfg,
        action: "send",
        params: outboundParams,
        gateway,
        toolContext,
        sessionKey: options?.agentSessionKey,
        agentId: options?.agentSessionKey
          ? resolveSessionAgentId({ sessionKey: options.agentSessionKey, config: cfg })
          : undefined,
        abortSignal: signal,
      });

      const toolResult = getToolResult(result);
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
  };
}
