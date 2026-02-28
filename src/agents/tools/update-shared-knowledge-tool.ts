/**
 * update_shared_knowledge tool — write company-wide shared knowledge files (fork extension).
 *
 * Writes or deletes named sections in a shared markdown file stored in the default
 * agent workspace (e.g. COMPANY.md, KNOWLEDGE.md, TEAMS.md). Unlike MEMORY.md
 * (which is per-agent), shared knowledge files are visible to ALL agents at session
 * start. Use this to store facts, policies, org structure, or context that every
 * department agent should know.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/** Filenames that must not be targeted by this tool (reserved by other systems). */
const RESERVED_FILENAMES = new Set(["MEMORY.md", "CHATS.md", "PEOPLE.md"]);

const H2 = "## ";

type Section = { name: string; content: string };

function parseFileSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith(H2)) {
      if (current) {
        sections.push({ name: current.name, content: current.lines.join("\n").trimEnd() });
      }
      current = { name: line.slice(H2.length).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    sections.push({ name: current.name, content: current.lines.join("\n").trimEnd() });
  }
  return sections;
}

function buildFileContent(filename: string, sections: Section[]): string {
  const title = filename.replace(/\.md$/i, "");
  const header = `# ${title}\n\nShared company knowledge — visible to all agents.\n\n`;
  if (sections.length === 0) {
    return header;
  }
  return header + sections.map((s) => `${H2}${s.name}\n${s.content}`).join("\n\n") + "\n";
}

async function updateSharedSection(
  sharedDir: string,
  filename: string,
  section: string,
  content: string,
  mode: "replace" | "append" | "delete",
): Promise<void> {
  const filePath = path.join(sharedDir, filename);
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // Will create below.
  }
  const sections = parseFileSections(existing);
  const idx = sections.findIndex((s) => s.name.toLowerCase() === section.toLowerCase());

  if (mode === "delete") {
    if (idx === -1) {
      return;
    }
    sections.splice(idx, 1);
  } else if (mode === "append") {
    if (idx === -1) {
      sections.push({ name: section, content: content.trimEnd() });
    } else {
      const sep = sections[idx].content.trim() ? "\n" : "";
      sections[idx] = {
        name: sections[idx].name,
        content: sections[idx].content + sep + "\n" + content.trimEnd(),
      };
    }
  } else {
    if (idx === -1) {
      sections.push({ name: section, content: content.trimEnd() });
    } else {
      sections[idx] = { name: sections[idx].name, content: content.trimEnd() };
    }
  }

  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(filePath, buildFileContent(filename, sections));
}

export function createUpdateSharedKnowledgeTool(): AnyAgentTool {
  return {
    label: "UpdateSharedKnowledge",
    name: "update_shared_knowledge",
    description:
      "Write or delete a named section in a shared company knowledge file " +
      "(e.g. COMPANY.md, KNOWLEDGE.md, TEAMS.md). " +
      "These files live in the shared workspace and are injected into every agent's " +
      "system prompt at session start — so all agents (main, finance, HR, etc.) can see them. " +
      "Use this for org structure, policies, team rosters, glossaries, or any company-wide facts. " +
      "Do NOT use this for personal agent notes — use update_memory for those.",
    parameters: Type.Object({
      file: Type.String({
        description:
          "Target filename (e.g. 'COMPANY.md', 'KNOWLEDGE.md', 'TEAMS.md'). " +
          "Must end in .md. MEMORY.md, CHATS.md, and PEOPLE.md are reserved.",
      }),
      section: Type.String({
        description: "Section name within the file (e.g. 'Mission', 'Finance Team', 'Glossary').",
      }),
      content: Type.Optional(
        Type.String({
          description: "Markdown content to write. Required for 'replace' and 'append' modes.",
        }),
      ),
      mode: Type.Optional(
        Type.String({
          description:
            "'replace' (default): overwrite the section. 'append': add below existing content. 'delete': remove the section.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const file = readStringParam(params, "file", { required: true });
      const section = readStringParam(params, "section", { required: true });
      const content = readStringParam(params, "content") ?? "";
      const modeRaw = readStringParam(params, "mode") ?? "replace";
      const mode = (["replace", "append", "delete"].includes(modeRaw) ? modeRaw : "replace") as
        | "replace"
        | "append"
        | "delete";

      if (!file) {
        return jsonResult({ ok: false, error: "update_shared_knowledge: 'file' is required." });
      }
      if (!section) {
        return jsonResult({ ok: false, error: "update_shared_knowledge: 'section' is required." });
      }
      if (!file.endsWith(".md")) {
        return jsonResult({
          ok: false,
          error: "update_shared_knowledge: 'file' must end in .md.",
        });
      }
      const normalizedFile = path.basename(file);
      if (RESERVED_FILENAMES.has(normalizedFile)) {
        return jsonResult({
          ok: false,
          error: `update_shared_knowledge: '${normalizedFile}' is reserved. Use update_memory or the dedicated tool.`,
        });
      }
      if (mode !== "delete" && !content.trim()) {
        return jsonResult({
          ok: false,
          error: "update_shared_knowledge: 'content' is required for replace/append.",
        });
      }

      await updateSharedSection(
        DEFAULT_AGENT_WORKSPACE_DIR,
        normalizedFile,
        section,
        content,
        mode,
      );
      return jsonResult({ ok: true, file: normalizedFile, section, mode });
    },
  };
}
