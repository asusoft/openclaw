/**
 * manage_agents tool — admin-only agent configuration tool (fork extension).
 *
 * Allows the main/admin agent to inspect and update other agents' roles and
 * tool access. Only available when the current session's agent has `role: "admin"`.
 *
 * Supported actions:
 * - list: show all configured agents with their roles and tool policies
 * - get: show a specific agent's full config
 * - set_role: set an agent's role to "admin" or "standard"
 * - set_tool_deny: set an agent's tools.deny list (blocked tool names)
 * - set_tool_allow: set an agent's tools.allow list (explicit allowlist, null to clear)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { writeConfigFile } from "../../config/io.js";
import { listAgentEntries } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export type ManageAgentsTool = {
  config?: OpenClawConfig;
};

export function createManageAgentsTool(options?: ManageAgentsTool): AnyAgentTool {
  return {
    label: "ManageAgents",
    name: "manage_agents",
    description:
      "Admin-only: inspect and configure other agents. " +
      "Actions: 'list' (all agents + roles), 'get' (one agent's full config), " +
      "'set_role' (set agent role to admin/standard), " +
      "'set_tool_deny' (block specific tools for an agent), " +
      "'set_tool_allow' (restrict agent to an explicit tool allowlist, pass empty array to clear). " +
      "Changes are written to the config file immediately.",
    parameters: Type.Object({
      action: Type.String({
        description: "Action: 'list', 'get', 'set_role', 'set_tool_deny', 'set_tool_allow'.",
      }),
      agentId: Type.Optional(
        Type.String({
          description: "Target agent id. Required for all actions except 'list'.",
        }),
      ),
      role: Type.Optional(
        Type.String({
          description: "For set_role: 'admin' or 'standard'.",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "For set_tool_deny / set_tool_allow: list of tool names. " +
            "Pass an empty array to clear the list.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const cfg = options?.config ?? loadConfig();
      const entries = listAgentEntries(cfg);

      if (action === "list") {
        const agents = entries.map((e) => ({
          id: e.id,
          name: e.name,
          role: e.role ?? "standard",
          toolAllow: (e.tools as { allow?: string[] } | undefined)?.allow,
          toolDeny: (e.tools as { deny?: string[] } | undefined)?.deny,
          workspace: e.workspace,
        }));
        return jsonResult({ ok: true, count: agents.length, agents });
      }

      const agentId = readStringParam(params, "agentId");
      if (!agentId) {
        return jsonResult({
          ok: false,
          error: "manage_agents: 'agentId' is required for this action.",
        });
      }

      const entry = entries.find((e) => e.id === agentId);
      if (action === "get") {
        if (!entry) {
          return jsonResult({ ok: false, error: `manage_agents: agent '${agentId}' not found.` });
        }
        return jsonResult({ ok: true, agent: entry });
      }

      // Mutating actions — write to config.
      if (action === "set_role") {
        const role = readStringParam(params, "role");
        if (role !== "admin" && role !== "standard") {
          return jsonResult({
            ok: false,
            error: "manage_agents: 'role' must be 'admin' or 'standard'.",
          });
        }
        const nextCfg = applyAgentPatch(cfg, agentId, (a) => ({ ...a, role }));
        await writeConfigFile(nextCfg);
        return jsonResult({ ok: true, agentId, role });
      }

      if (action === "set_tool_deny" || action === "set_tool_allow") {
        const tools = Array.isArray(params.tools)
          ? (params.tools as unknown[]).filter((v): v is string => typeof v === "string")
          : undefined;
        if (tools === undefined) {
          return jsonResult({ ok: false, error: "manage_agents: 'tools' (array) is required." });
        }
        const field = action === "set_tool_deny" ? "deny" : "allow";
        const nextCfg = applyAgentPatch(cfg, agentId, (a) => ({
          ...a,
          tools: {
            ...(typeof a.tools === "object" && a.tools !== null ? a.tools : {}),
            [field]: tools.length > 0 ? tools : undefined,
          },
        }));
        await writeConfigFile(nextCfg);
        return jsonResult({ ok: true, agentId, [field]: tools });
      }

      return jsonResult({ ok: false, error: `manage_agents: unknown action '${action}'.` });
    },
  };
}

/**
 * Apply a patch function to a specific agent entry in the config.
 * If the agent doesn't exist, a new entry is appended (only for set_* actions).
 */
function applyAgentPatch(
  cfg: OpenClawConfig,
  agentId: string,
  patch: (entry: Record<string, unknown>) => Record<string, unknown>,
): OpenClawConfig {
  const agentsList = cfg.agents?.list;
  const existingList = Array.isArray(agentsList) ? agentsList : [];
  const idx = existingList.findIndex((e) => (e as { id?: string }).id === agentId);
  let nextList: unknown[];
  if (idx === -1) {
    // New agent entry.
    nextList = [...existingList, patch({ id: agentId })];
  } else {
    nextList = existingList.map((e, i) => (i === idx ? patch(e as Record<string, unknown>) : e));
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: nextList as NonNullable<OpenClawConfig["agents"]>["list"],
    },
  };
}
