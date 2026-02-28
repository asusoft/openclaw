/**
 * Config-driven message forwarding router (fork extension).
 *
 * Evaluates `messageRoutes` config rules against an inbound message and fans
 * out matching messages to their configured target chats via the gateway.
 * Runs entirely without LLM involvement — pure config → send pipeline.
 *
 * Pattern syntax for the `from` field:
 *   "*"                   — any channel, any chat
 *   "telegram"            — any Telegram chat
 *   "telegram:*"          — any Telegram chat (explicit wildcard)
 *   "telegram:-100123456" — specific Telegram chat ID
 *
 * Template variables in transform.prefix / transform.suffix:
 *   {chatTitle}  — display name of the source chat
 *   {chatId}     — numeric chat ID of the source chat
 *   {sender}     — display name of the sender (first + last name)
 *   {username}   — @username of the sender (empty string if not set)
 */

import { resolveGatewayOptions } from "../agents/tools/gateway.js";
import type { OpenClawConfig } from "../config/config.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../gateway/protocol/client-info.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { resolveChatAlias } from "./cross-context-routes.js";

export type MessageRouteContext = {
  /** Raw message text (may be undefined for media-only messages). */
  text?: string;
  /** Numeric source chat ID as string. */
  chatId: string;
  /** Display title of the source chat. */
  chatTitle: string;
  /** Telegram user ID of the sender. */
  senderId: string;
  /** First name of the sender. */
  senderFirstName?: string;
  /** Last name of the sender. */
  senderLastName?: string;
  /** @username of the sender (without @). */
  senderUsername?: string;
  /** Channel provider (e.g. "telegram"). */
  channel: string;
};

/** Returns true if the route's `from` pattern matches the incoming context. */
function matchesFromPattern(from: string, ctx: MessageRouteContext): boolean {
  if (from === "*") {
    return true;
  }

  const colonIdx = from.indexOf(":");
  if (colonIdx === -1) {
    // Channel-only pattern: "telegram" matches any chat on that channel.
    return from.toLowerCase() === ctx.channel.toLowerCase();
  }

  const patternChannel = from.slice(0, colonIdx).toLowerCase();
  const patternChatId = from.slice(colonIdx + 1).toLowerCase();

  if (patternChannel !== ctx.channel.toLowerCase()) {
    return false;
  }
  if (patternChatId === "*" || patternChatId === "") {
    return true;
  }
  return patternChatId === ctx.chatId.toLowerCase();
}

/** Apply keyword + sender filters. Returns true if the message should be forwarded. */
function passesFilter(
  filter: { keywords?: string[]; senders?: string[] } | undefined,
  ctx: MessageRouteContext,
): boolean {
  if (!filter) {
    return true;
  }

  // Sender whitelist — skip if sender not in list.
  if (filter.senders && filter.senders.length > 0) {
    if (!filter.senders.includes(ctx.senderId)) {
      return false;
    }
  }

  // Keyword match — at least one keyword must appear in the text.
  if (filter.keywords && filter.keywords.length > 0) {
    const body = (ctx.text ?? "").toLowerCase();
    const hasKeyword = filter.keywords.some((kw) => body.includes(kw.toLowerCase()));
    if (!hasKeyword) {
      return false;
    }
  }

  return true;
}

/** Replace template variables in a string. */
function applyTemplate(template: string, ctx: MessageRouteContext): string {
  const senderName =
    [ctx.senderFirstName, ctx.senderLastName].filter(Boolean).join(" ") || ctx.senderId;
  const username = ctx.senderUsername ? `@${ctx.senderUsername}` : "";
  return template
    .replaceAll("{chatTitle}", ctx.chatTitle)
    .replaceAll("{chatId}", ctx.chatId)
    .replaceAll("{sender}", senderName)
    .replaceAll("{username}", username);
}

/** Build the forwarded message text, applying optional prefix/suffix templates. */
function buildForwardedText(
  originalText: string | undefined,
  transform: { prefix?: string; suffix?: string } | undefined,
  ctx: MessageRouteContext,
): string | undefined {
  let text = originalText ?? "";

  if (transform?.prefix) {
    text = applyTemplate(transform.prefix, ctx) + text;
  }
  if (transform?.suffix) {
    text = text + applyTemplate(transform.suffix, ctx);
  }

  return text.trim() || undefined;
}

/**
 * Evaluate all enabled `messageRoutes` rules against the given context.
 * For each matching rule, forward the message to the configured target.
 * Returns the number of forwards attempted (not necessarily successful).
 *
 * This function is designed to be called fire-and-forget; errors per-route
 * are swallowed so one bad rule never blocks others.
 */
export async function runMessageRoutes(
  cfg: OpenClawConfig,
  ctx: MessageRouteContext,
): Promise<number> {
  const routes = (cfg as { messageRoutes?: unknown[] }).messageRoutes;
  if (!routes || routes.length === 0) {
    return 0;
  }

  const gatewayResolved = resolveGatewayOptions({});
  const gateway = {
    url: gatewayResolved.url,
    token: gatewayResolved.token,
    timeoutMs: gatewayResolved.timeoutMs,
    clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    clientDisplayName: "router",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  };

  let attempted = 0;

  await Promise.allSettled(
    routes.map(async (rawRule) => {
      const rule = rawRule as {
        from: string;
        to: string;
        channel?: string;
        filter?: { keywords?: string[]; senders?: string[] };
        transform?: { prefix?: string; suffix?: string };
        enabled?: boolean;
      };

      // Skip disabled rules.
      if (rule.enabled === false) {
        return;
      }

      const ruleChannel = rule.channel ?? "telegram";

      // Only match rules whose channel aligns with the current context channel.
      if (ruleChannel.toLowerCase() !== ctx.channel.toLowerCase()) {
        return;
      }

      if (!matchesFromPattern(rule.from, ctx)) {
        return;
      }
      if (!passesFilter(rule.filter, ctx)) {
        return;
      }

      // Resolve target alias → chat ID.
      const targetChatId = resolveChatAlias(cfg, rule.to);
      // Don't forward to ourselves.
      if (targetChatId === ctx.chatId) {
        return;
      }

      const forwardedText = buildForwardedText(ctx.text, rule.transform, ctx);
      if (!forwardedText) {
        return;
      } // Nothing to forward (media-only + no transform text).

      attempted++;

      const outboundParams: Record<string, unknown> = {
        channel: ruleChannel,
        target: targetChatId,
        message: forwardedText,
      };

      await runMessageAction({
        cfg,
        action: "send",
        params: outboundParams,
        gateway,
      }).catch(() => void 0); // Swallow per-route errors — best-effort delivery.
    }),
  );

  return attempted;
}
