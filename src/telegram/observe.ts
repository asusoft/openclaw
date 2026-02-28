/**
 * Observe Mode — see all group messages, respond selectively.
 *
 * When a group has `activationMode: "observe"`, the agent ingests every message
 * into its history buffer but only triggers the LLM reasoning loop when one of
 * the configured `respondOn` conditions is met.
 *
 * This enables full group context awareness at zero LLM cost for casual messages.
 */

export type ObserveRespondOn = "mention" | "reply" | "command" | "keyword" | "question";

export type ObserveOptions = {
  /** Append all messages to group history (default: true). */
  ingestToHistory?: boolean;
  /** Which conditions trigger a response (default: ["mention", "reply", "command"]). */
  respondOn?: ObserveRespondOn[];
  /** Keyword triggers — respond when any of these appear in a message body. */
  keywords?: string[];
  /** Suppress typing indicator for observe-only (non-response) messages (default: true). */
  silentIngestion?: boolean;
};

export type ShouldRespondParams = {
  /** True if the bot was @mentioned. */
  wasMentioned: boolean;
  /** True if the message is a direct reply to a bot message. */
  implicitMention: boolean;
  /** True if the message contains a recognized /command. */
  hasControlCommand: boolean;
  /** Raw message text (used for keyword matching). */
  rawBody: string;
  /** Which conditions should trigger a response. */
  respondOn: ObserveRespondOn[];
  /** Optional keyword list for keyword-based triggering. */
  keywords: string[];
};

/** Collective address — the speaker is talking to the group as a whole. */
const COLLECTIVE_ADDRESS =
  /\b(everyone|everybody|anyone|anybody|someone|somebody|you all|y'all|the team|the group)\b/i;

/** Explicit invitation for group feedback or input. */
const GROUP_INVITATION =
  /\b(thoughts|opinions?|feedback|your take|weigh in|chime in|what do you think|give me your|looking for input)\b/i;

/**
 * Detect messages directed at the group as a whole.
 * Triggers on: direct questions (?), collective addresses ("everyone", "anyone"),
 * or explicit invitations ("thoughts?", "give me your take").
 */
function isGroupDirectedMessage(body: string): boolean {
  if (body.includes("?")) {
    return true;
  }
  if (COLLECTIVE_ADDRESS.test(body)) {
    return true;
  }
  if (GROUP_INVITATION.test(body)) {
    return true;
  }
  return false;
}

/**
 * Evaluate whether an observed message should trigger an agent response.
 *
 * Returns true when any of the configured `respondOn` conditions is met.
 */
export function shouldRespondInObserveMode(params: ShouldRespondParams): boolean {
  const { wasMentioned, implicitMention, hasControlCommand, rawBody, respondOn, keywords } = params;

  for (const condition of respondOn) {
    if (condition === "mention" && wasMentioned) {
      return true;
    }
    if (condition === "reply" && implicitMention) {
      return true;
    }
    if (condition === "command" && hasControlCommand) {
      return true;
    }
    if (condition === "keyword" && keywords.length > 0) {
      const bodyLower = rawBody.toLowerCase();
      if (keywords.some((kw) => bodyLower.includes(kw.toLowerCase()))) {
        return true;
      }
    }
    if (condition === "question" && isGroupDirectedMessage(rawBody)) {
      return true;
    }
  }
  return false;
}

/** Default respondOn conditions for observe mode when not explicitly configured. */
export const DEFAULT_OBSERVE_RESPOND_ON: ObserveRespondOn[] = ["mention", "reply", "command"];
