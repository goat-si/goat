import { describe, expect, it } from "vite-plus/test";

import { codexFileCitationMarkdown, resolveCodexFileCitationLink } from "./codexFileCitations.ts";
import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

describe("resolveCodexFileCitationLink", () => {
  it("resolves the attributes emitted by Codex", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
        purpose: "output",
      }),
    ).toEqual({
      path: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      href: "/workspace/outputs/issue-2387-sparse-diagonal.xlsx",
      label: "issue-2387-sparse-diagonal.xlsx",
    });
  });

  it("carries the first cited line into the file href", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "src/main.ts",
        line_range_start: "42",
        line_range_end: "48",
        git_url: "https://example.com/main.ts",
      }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts#L42",
      label: "main.ts",
      lineRangeStart: 42,
    });
  });

  it("opens forward-slash UNC citations only in the workspace share", () => {
    for (const host of ["files", "localhost"]) {
      const cwd = `\\\\${host}\\team\\repo`;
      const citation = resolveCodexFileCitationLink({
        path: `//${host}/team/repo/src/app.ts`,
        line_range_start: "7",
      });
      expect(citation).not.toBeNull();
      if (!citation) return;
      const copied = extractMarkdownLinkHrefs(codexFileCitationMarkdown(citation))[0];
      for (const href of [citation.href, copied]) {
        expect(resolveMarkdownFileLinkTarget(href, cwd)).toBe(`${cwd}\\src\\app.ts:7`);
      }
    }
    for (const path of [
      "//other/team/repo/src/app.ts",
      "//files/other/repo/src/app.ts",
      "//localhost/team/repo/src/app.ts",
    ]) {
      const citation = resolveCodexFileCitationLink({ path, line_range_start: "7" });
      expect(resolveMarkdownFileLinkTarget(citation?.href, "\\\\files\\team\\repo")).toBeNull();
    }
    expect(resolveCodexFileCitationLink({ path: "///Users/me/repo/src/app.ts" })?.href).toBe(
      "///Users/me/repo/src/app.ts",
    );
  });

  it("rejects missing paths and invalid line numbers", () => {
    expect(resolveCodexFileCitationLink({ purpose: "output" })).toBeNull();
    expect(
      resolveCodexFileCitationLink({ path: "src/main.ts", line_range_start: "not-a-line" }),
    ).toEqual({
      path: "src/main.ts",
      href: "src/main.ts",
      label: "main.ts",
    });
  });

  it("preserves URL syntax characters in file paths", () => {
    expect(
      resolveCodexFileCitationLink({
        path: "reports/100% #1? draft.md",
        line_range_start: "7",
      }),
    ).toEqual({
      path: "reports/100% #1? draft.md",
      href: "reports/100%25 %231%3F draft.md#L7",
      label: "100% #1? draft.md",
      lineRangeStart: 7,
    });
  });
});

describe("codexFileCitationMarkdown", () => {
  it("escapes Markdown syntax in the visible filename", () => {
    const citation = resolveCodexFileCitationLink({
      path: "reports/*draft*_[copy]`~<&|.txt",
    });
    expect(citation && codexFileCitationMarkdown(citation)).toBe(
      "[\\*draft\\*\\_\\[copy\\]\\`\\~\\<\\&\\|.txt](<reports/*draft*_[copy]`~%3C%26%7C.txt>)",
    );
  });
});
