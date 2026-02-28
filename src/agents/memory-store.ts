/**
 * Shared memory store — MEMORY.md (fork extension).
 *
 * A section-based markdown file persisted in the agent workspace. Agents can
 * read it (injected into system prompt at session start) and write it via the
 * `update_memory` tool. Sections survive restarts and are visible across all
 * chats and sessions for the same agent.
 */

import fs from "node:fs/promises";
import path from "node:path";

export const MEMORY_FILENAME = "MEMORY.md";

const MEMORY_HEADER = [
  "# Memory",
  "",
  "Persistent notes across all sessions and conversations.",
  "",
].join("\n");

const H2 = "## ";

type Section = { name: string; content: string };

/** Parse MEMORY.md into ordered sections. Content excludes the heading line. */
function parseSections(text: string): Section[] {
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

function buildFile(sections: Section[]): string {
  if (sections.length === 0) {
    return MEMORY_HEADER;
  }
  return MEMORY_HEADER + sections.map((s) => `${H2}${s.name}\n${s.content}`).join("\n\n") + "\n";
}

/**
 * Update a named section in MEMORY.md.
 *
 * - "replace": set the section content to `content` (creates if absent).
 * - "append": append `content` to the existing content (creates if absent).
 * - "delete": remove the section entirely (no-op if absent).
 */
export async function updateMemorySection(
  workspaceDir: string,
  section: string,
  content: string,
  mode: "replace" | "append" | "delete",
): Promise<void> {
  const filePath = path.join(workspaceDir, MEMORY_FILENAME);

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // Will create below.
  }

  const sections = parseSections(existing);
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
    // replace
    if (idx === -1) {
      sections.push({ name: section, content: content.trimEnd() });
    } else {
      sections[idx] = { name: sections[idx].name, content: content.trimEnd() };
    }
  }

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(filePath, buildFile(sections));
}

/**
 * Load MEMORY.md as an embedded context file for system prompt injection.
 * Returns null when the file is empty or has no sections.
 */
export async function loadMemoryAsContextFile(workspaceDir: string): Promise<{
  path: string;
  content: string;
} | null> {
  const filePath = path.join(workspaceDir, MEMORY_FILENAME);
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim() || !content.includes(H2)) {
      return null;
    }
    return { path: filePath, content };
  } catch {
    return null;
  }
}
