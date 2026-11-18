import { resolveHighlightLanguage } from "../lib/highlightLanguage";

// Fences enriched-markdown colours itself: cpp/highlight/CodeBlockLanguages.cpp entries with a default grammar.
const NATIVE_HIGHLIGHT_FENCES = new Set([
  "bash",
  "c",
  "css",
  "go",
  "golang",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "jsx",
  "markdown",
  "md",
  "py",
  "python",
  "rs",
  "rust",
  "sh",
  "shell",
  "ts",
  "tsx",
  "typescript",
  "yaml",
  "yml",
  "zsh",
]);

/** A fenced code block for `code`, with a backtick fence longer than any backtick run inside it. */
export function fencedCodeMarkdown(code: string, language: string): string {
  let longestRun = 0;
  for (const [run] of code.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * Above this a finished fence in a message stays plain: every token becomes a nested Text in the
 * feed, highlighted on the JS thread, and 16,000 characters is about 400 lines of code.
 */
export const MAX_CHAT_HIGHLIGHT_CHARACTERS = 16_000;

const FENCE_LINE = /^ {0,3}(?<marker>`{3,}|~{3,})(?<rest>.*)$/;

/** The code of a fence the markdown leaves open at its end (a message still streaming), else null. */
export function openFenceCode(markdown: string): string | null {
  let open: { readonly marker: string; readonly start: number } | null = null;
  const lines = markdown.split("\n");
  for (const [index, line] of lines.entries()) {
    const fence = FENCE_LINE.exec(line)?.groups;
    if (fence?.marker === undefined) continue;
    const marker = fence.marker;
    if (open === null) open = { marker, start: index + 1 };
    else if (
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      (fence.rest ?? "").trim() === ""
    )
      open = null;
  }
  return open === null ? null : lines.slice(open.start).join("\n");
}

/** Colours a fence once it is finished and small enough; `openCode` is openFenceCode's answer. */
export function fenceHighlightable(code: string, openCode: string | null): boolean {
  return code.length <= MAX_CHAT_HIGHLIGHT_CHARACTERS && openCode?.trimEnd() !== code.trimEnd();
}

/** Colours a message's fence once it is finished and small enough; until then it shows plain. */
export function shouldHighlightFence(code: string, markdown: string): boolean {
  return fenceHighlightable(code, openFenceCode(markdown));
}

type CodeFenceRenderer =
  | { readonly kind: "mermaid" }
  | { readonly kind: "math" }
  | { readonly kind: "highlight"; readonly language: string }
  | { readonly kind: "native" };

/** Mermaid and math fences first: highlights knows `mermaid` too, and would claim it as code. */
export function codeFenceRenderer(fence: string, mathRenderingEnabled: boolean): CodeFenceRenderer {
  if (fence === "mermaid") return { kind: "mermaid" };
  if (fence === "math" && mathRenderingEnabled) return { kind: "math" };
  const name = fence.toLowerCase();
  if (NATIVE_HIGHLIGHT_FENCES.has(name)) return { kind: "native" };
  const language = resolveHighlightLanguage({ language: name });
  return language === "text" ? { kind: "native" } : { kind: "highlight", language };
}
