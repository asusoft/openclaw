import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentsListResult, ToolsCatalogResult } from "../types.ts";
import type { ConfigState } from "./config.ts";
import { loadConfig, saveConfig, updateConfigFormValue } from "./config.ts";

export type AgentsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsLoading: boolean;
  agentsError: string | null;
  agentsList: AgentsListResult | null;
  agentsSelectedId: string | null;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  agentCreateBusy: boolean;
  agentCreateError: string | null;
};

export type AgentCreateForm = {
  name: string;
  workspace: string;
  emoji: string;
  model: string;
  telegramChatId: string;
  telegramChatKind: "group" | "direct";
  toolsProfile: string;
  role: string;
};

export async function loadAgents(state: AgentsState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agentsLoading) {
    return;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  try {
    const res = await state.client.request<AgentsListResult>("agents.list", {});
    if (res) {
      state.agentsList = res;
      const selected = state.agentsSelectedId;
      const known = res.agents.some((entry) => entry.id === selected);
      if (!selected || !known) {
        state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
      }
    }
  } catch (err) {
    state.agentsError = String(err);
  } finally {
    state.agentsLoading = false;
  }
}

export async function createAgent(
  state: AgentsState & ConfigState,
  form: AgentCreateForm,
  onSuccess: (agentId: string) => void,
) {
  if (!state.client || !state.connected || state.agentCreateBusy) {
    return;
  }
  const name = form.name.trim();
  const workspace = form.workspace.trim();
  if (!name || !workspace) {
    state.agentCreateError = "Name and workspace are required.";
    return;
  }
  state.agentCreateBusy = true;
  state.agentCreateError = null;
  try {
    // Step 1: create the agent
    const res = await state.client.request<{ ok: true; agentId: string } | null>("agents.create", {
      name,
      workspace,
      ...(form.emoji.trim() ? { emoji: form.emoji.trim() } : {}),
    });
    if (!res?.ok) {
      return;
    }
    const agentId = res.agentId;

    // Step 2: reload config so the new agent entry is present in configForm
    await loadAgents(state);
    await loadConfig(state);

    // Step 3: apply optional fields via config form updates
    const list = (
      (state.configForm ?? state.configSnapshot?.config) as {
        agents?: { list?: Array<{ id?: string }> };
      }
    )?.agents?.list;
    const idx = Array.isArray(list)
      ? list.findIndex((entry) => entry && typeof entry === "object" && entry.id === agentId)
      : -1;

    let hasConfigChanges = false;

    if (idx >= 0) {
      const model = form.model.trim();
      if (model) {
        updateConfigFormValue(state, ["agents", "list", idx, "model"], model);
        hasConfigChanges = true;
      }
      const role = form.role.trim();
      if (role) {
        updateConfigFormValue(state, ["agents", "list", idx, "role"], role);
        hasConfigChanges = true;
      }
      const toolsProfile = form.toolsProfile.trim();
      if (toolsProfile) {
        updateConfigFormValue(state, ["agents", "list", idx, "tools", "profile"], toolsProfile);
        hasConfigChanges = true;
      }
    }

    // Step 4: add telegram binding if a chat ID was provided
    const chatId = form.telegramChatId.trim();
    if (chatId) {
      const configBase = (state.configForm ?? state.configSnapshot?.config ?? {}) as {
        bindings?: Array<unknown>;
      };
      const existingBindings = Array.isArray(configBase.bindings) ? configBase.bindings : [];
      const newBinding = {
        agentId,
        match: {
          channel: "telegram",
          peer: { kind: form.telegramChatKind, id: chatId },
        },
      };
      updateConfigFormValue(state, ["bindings"], [...existingBindings, newBinding]);
      hasConfigChanges = true;
    }

    // Step 5: persist config changes if any
    if (hasConfigChanges) {
      await saveConfig(state);
    }

    state.agentsSelectedId = agentId;
    onSuccess(agentId);
  } catch (err) {
    state.agentCreateError = String(err);
  } finally {
    state.agentCreateBusy = false;
  }
}

export async function loadToolsCatalog(state: AgentsState, agentId?: string | null) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.toolsCatalogLoading) {
    return;
  }
  state.toolsCatalogLoading = true;
  state.toolsCatalogError = null;
  try {
    const res = await state.client.request<ToolsCatalogResult>("tools.catalog", {
      agentId: agentId ?? state.agentsSelectedId ?? undefined,
      includePlugins: true,
    });
    if (res) {
      state.toolsCatalogResult = res;
    }
  } catch (err) {
    state.toolsCatalogError = String(err);
  } finally {
    state.toolsCatalogLoading = false;
  }
}
