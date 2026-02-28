import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentFileEntry,
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentsFilesSetResult,
  AgentsSharedFilesGetResult,
  AgentsSharedFilesListResult,
  AgentsSharedFilesSetResult,
} from "../types.ts";

export type AgentFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentFilesLoading: boolean;
  agentFilesError: string | null;
  agentFilesList: AgentsFilesListResult | null;
  agentFileContents: Record<string, string>;
  agentFileDrafts: Record<string, string>;
  agentFileActive: string | null;
  agentFileSaving: boolean;
};

export type SharedFilesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sharedFilesLoading: boolean;
  sharedFilesError: string | null;
  sharedFilesList: AgentsSharedFilesListResult | null;
  sharedFileContents: Record<string, string>;
  sharedFileDrafts: Record<string, string>;
  sharedFileActive: string | null;
  sharedFileSaving: boolean;
};

function mergeFileEntry(
  list: AgentsFilesListResult | null,
  entry: AgentFileEntry,
): AgentsFilesListResult | null {
  if (!list) {
    return list;
  }
  const hasEntry = list.files.some((file) => file.name === entry.name);
  const nextFiles = hasEntry
    ? list.files.map((file) => (file.name === entry.name ? entry : file))
    : [...list.files, entry];
  return { ...list, files: nextFiles };
}

export async function loadAgentFiles(state: AgentFilesState, agentId: string) {
  if (!state.client || !state.connected || state.agentFilesLoading) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await state.client.request<AgentsFilesListResult | null>("agents.files.list", {
      agentId,
    });
    if (res) {
      state.agentFilesList = res;
      if (state.agentFileActive && !res.files.some((file) => file.name === state.agentFileActive)) {
        state.agentFileActive = null;
      }
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

export async function loadAgentFileContent(
  state: AgentFilesState,
  agentId: string,
  name: string,
  opts?: { force?: boolean; preserveDraft?: boolean },
) {
  if (!state.client || !state.connected || state.agentFilesLoading) {
    return;
  }
  if (!opts?.force && Object.hasOwn(state.agentFileContents, name)) {
    return;
  }
  state.agentFilesLoading = true;
  state.agentFilesError = null;
  try {
    const res = await state.client.request<AgentsFilesGetResult | null>("agents.files.get", {
      agentId,
      name,
    });
    if (res?.file) {
      const content = res.file.content ?? "";
      const previousBase = state.agentFileContents[name] ?? "";
      const currentDraft = state.agentFileDrafts[name];
      const preserveDraft = opts?.preserveDraft ?? true;
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      if (
        !preserveDraft ||
        !Object.hasOwn(state.agentFileDrafts, name) ||
        currentDraft === previousBase
      ) {
        state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
      }
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFilesLoading = false;
  }
}

export async function saveAgentFile(
  state: AgentFilesState,
  agentId: string,
  name: string,
  content: string,
) {
  if (!state.client || !state.connected || state.agentFileSaving) {
    return;
  }
  state.agentFileSaving = true;
  state.agentFilesError = null;
  try {
    const res = await state.client.request<AgentsFilesSetResult | null>("agents.files.set", {
      agentId,
      name,
      content,
    });
    if (res?.file) {
      state.agentFilesList = mergeFileEntry(state.agentFilesList, res.file);
      state.agentFileContents = { ...state.agentFileContents, [name]: content };
      state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
    }
  } catch (err) {
    state.agentFilesError = String(err);
  } finally {
    state.agentFileSaving = false;
  }
}

function mergeSharedFileEntry(
  list: AgentsSharedFilesListResult | null,
  entry: AgentFileEntry,
): AgentsSharedFilesListResult | null {
  if (!list) {
    return list;
  }
  const hasEntry = list.files.some((file) => file.name === entry.name);
  const nextFiles = hasEntry
    ? list.files.map((file) => (file.name === entry.name ? entry : file))
    : [...list.files, entry];
  return { ...list, files: nextFiles };
}

export async function loadSharedFiles(state: SharedFilesState) {
  if (!state.client || !state.connected || state.sharedFilesLoading) {
    return;
  }
  state.sharedFilesLoading = true;
  state.sharedFilesError = null;
  try {
    const res = await state.client.request<AgentsSharedFilesListResult | null>(
      "agents.shared.files.list",
      {},
    );
    if (res) {
      state.sharedFilesList = res;
      if (
        state.sharedFileActive &&
        !res.files.some((file) => file.name === state.sharedFileActive)
      ) {
        state.sharedFileActive = null;
      }
    }
  } catch (err) {
    state.sharedFilesError = String(err);
  } finally {
    state.sharedFilesLoading = false;
  }
}

export async function loadSharedFileContent(
  state: SharedFilesState,
  name: string,
  opts?: { force?: boolean; preserveDraft?: boolean },
) {
  if (!state.client || !state.connected || state.sharedFilesLoading) {
    return;
  }
  if (!opts?.force && Object.hasOwn(state.sharedFileContents, name)) {
    return;
  }
  state.sharedFilesLoading = true;
  state.sharedFilesError = null;
  try {
    const res = await state.client.request<AgentsSharedFilesGetResult | null>(
      "agents.shared.files.get",
      { name },
    );
    if (res?.file) {
      const content = res.file.content ?? "";
      const previousBase = state.sharedFileContents[name] ?? "";
      const currentDraft = state.sharedFileDrafts[name];
      const preserveDraft = opts?.preserveDraft ?? true;
      state.sharedFilesList = mergeSharedFileEntry(state.sharedFilesList, res.file);
      state.sharedFileContents = { ...state.sharedFileContents, [name]: content };
      if (
        !preserveDraft ||
        !Object.hasOwn(state.sharedFileDrafts, name) ||
        currentDraft === previousBase
      ) {
        state.sharedFileDrafts = { ...state.sharedFileDrafts, [name]: content };
      }
    }
  } catch (err) {
    state.sharedFilesError = String(err);
  } finally {
    state.sharedFilesLoading = false;
  }
}

export async function saveSharedFile(state: SharedFilesState, name: string, content: string) {
  if (!state.client || !state.connected || state.sharedFileSaving) {
    return;
  }
  state.sharedFileSaving = true;
  state.sharedFilesError = null;
  try {
    const res = await state.client.request<AgentsSharedFilesSetResult | null>(
      "agents.shared.files.set",
      { name, content },
    );
    if (res?.file) {
      state.sharedFilesList = mergeSharedFileEntry(state.sharedFilesList, res.file);
      state.sharedFileContents = { ...state.sharedFileContents, [name]: content };
      state.sharedFileDrafts = { ...state.sharedFileDrafts, [name]: content };
    }
  } catch (err) {
    state.sharedFilesError = String(err);
  } finally {
    state.sharedFileSaving = false;
  }
}
