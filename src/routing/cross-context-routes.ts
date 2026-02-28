/**
 * Cross-context messaging route policy (fork extension).
 *
 * Evaluates the `crossContextRoutes` config block to decide whether an
 * outbound message that crosses session context boundaries is permitted.
 *
 * Design goals:
 * - When `crossContextRoutes` is absent from config, this module is a no-op
 *   and all existing policy behaviour is preserved identically to upstream.
 * - When present, the allow list is checked first; the default action applies
 *   only when no rule matches.
 * - The whitelist is config-only and cannot be modified at runtime (prompt
 *   injection safe).
 *
 * Pattern syntax for `from` / `to`:
 *   "telegram"         – any chat on the telegram channel
 *   "telegram:*"       – same as above (explicit wildcard)
 *   "telegram:-100123" – exactly the chat with id "-100123"
 *   "discord"          – any target on the discord channel
 */

import type { OpenClawConfig } from "../config/config.js";

/**
 * Resolve a chat alias to its underlying chat ID.
 *
 * Looks up `aliasOrId` in `cfg.chatAliases`. If found, returns the configured
 * chat ID; otherwise returns `aliasOrId` unchanged (already a raw numeric ID).
 */
export function resolveChatAlias(cfg: OpenClawConfig, aliasOrId: string): string {
  const aliases = (cfg as { chatAliases?: Record<string, string> }).chatAliases;
  if (!aliases || !aliasOrId) {
    return aliasOrId;
  }
  return aliases[aliasOrId] ?? aliasOrId;
}

export type CrossContextRouteEntry = {
  /** Source pattern: channel name, or "channel:chatId", or "channel:*". */
  from: string;
  /** Target pattern: channel name, or "channel:chatId", or "channel:*". */
  to: string;
  /**
   * Optional explicit chat ID allowlist applied on top of the `to` pattern.
   * When provided, the target chat ID must appear in this array.
   */
  chatIds?: string[];
};

export type CrossContextRoutePolicyResult = {
  allowed: boolean;
  /** Human-readable reason string, used in error messages and audit logs. */
  reason: string;
};

/**
 * Evaluate whether a cross-context send is permitted by the
 * `crossContextRoutes` config block.
 *
 * Returns `undefined` when `crossContextRoutes` is not configured, signalling
 * that the caller should fall through to the existing upstream policy logic.
 */
export function evaluateCrossContextRoutePolicy(params: {
  /** Channel provider the current session is bound to (e.g. "telegram"). */
  fromChannel: string;
  /** Chat/channel ID the current session is bound to. */
  fromChatId: string;
  /** Channel provider of the send target (e.g. "telegram"). */
  toChannel: string;
  /** Chat/channel ID of the send target. */
  toChatId: string;
  cfg: OpenClawConfig;
}): CrossContextRoutePolicyResult | undefined {
  const routes = (params.cfg as { crossContextRoutes?: unknown }).crossContextRoutes as
    | { allow?: CrossContextRouteEntry[]; default?: "deny" | "allow" }
    | undefined;

  // No config block → defer to upstream policy (no behaviour change).
  if (!routes) {
    return undefined;
  }

  const allowList = Array.isArray(routes.allow) ? routes.allow : [];
  const defaultAction = routes.default ?? "deny";

  for (const entry of allowList) {
    if (!matchesChannelPattern(entry.from, params.fromChannel, params.fromChatId, params.cfg)) {
      continue;
    }
    if (!matchesChannelPattern(entry.to, params.toChannel, params.toChatId, params.cfg)) {
      continue;
    }
    // If an explicit chatIds allowlist is set, target must be in it.
    if (entry.chatIds && entry.chatIds.length > 0) {
      const normalizedTarget = params.toChatId.trim();
      if (!entry.chatIds.some((id) => id.trim() === normalizedTarget)) {
        continue;
      }
    }
    return {
      allowed: true,
      reason: `crossContextRoutes allow: from="${entry.from}" to="${entry.to}"`,
    };
  }

  // No rule matched — apply default action.
  if (defaultAction === "allow") {
    return { allowed: true, reason: "crossContextRoutes default=allow" };
  }
  return {
    allowed: false,
    reason: `crossContextRoutes default=deny, no allow rule matched for from="${params.fromChannel}:${params.fromChatId}" to="${params.toChannel}:${params.toChatId}"`,
  };
}

/**
 * Match a route pattern against an actual (channel, chatId) pair.
 *
 * Pattern forms:
 *   "telegram"          → matches channel="telegram", any chatId
 *   "telegram:*"        → same
 *   "telegram:-1001"    → matches channel="telegram", chatId="-1001" exactly
 *   "telegram:dev-team" → matches if "dev-team" is a chatAliases key resolving to chatId
 */
function matchesChannelPattern(
  pattern: string,
  channel: string,
  chatId: string,
  cfg?: OpenClawConfig,
): boolean {
  const p = pattern.trim().toLowerCase();
  const colonIdx = p.indexOf(":");

  if (colonIdx === -1) {
    // No colon: matches the named channel regardless of chat ID.
    return p === channel.trim().toLowerCase();
  }

  const patternChannel = p.slice(0, colonIdx);
  const patternChatId = p.slice(colonIdx + 1);

  if (patternChannel !== channel.trim().toLowerCase()) {
    return false;
  }

  // Wildcard or empty suffix matches any chat ID.
  if (!patternChatId || patternChatId === "*") {
    return true;
  }

  // Resolve the pattern's chat ID portion as an alias if cfg is available.
  const resolvedPatternChatId = cfg
    ? resolveChatAlias(cfg, patternChatId).toLowerCase()
    : patternChatId;
  return resolvedPatternChatId === chatId.trim().toLowerCase();
}
