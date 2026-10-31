import { describe, expect, it } from "@effect/vitest";
import { BROWSER_SKILL_CORE } from "./browser.ts";
import {
  BROWSER_SKILL_DIRECTORY,
  BROWSER_SKILL_FILE,
  browserSkillFiles,
  makeBrowserGuide,
} from "./browserSkillFiles.ts";

describe("browser skill files", () => {
  it("provides an installable guide with the resident core and site references", () => {
    const files = browserSkillFiles();
    expect(BROWSER_SKILL_DIRECTORY).toBe("browser");
    expect(BROWSER_SKILL_FILE).toBe("SKILL.md");
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "references/sites.md"]);
    const guide = files[BROWSER_SKILL_FILE]!;
    expect(guide).toMatch(/^---\nname: browser\ndescription: .+\n---\n/);
    expect(guide).toContain(BROWSER_SKILL_CORE);
    expect(guide).toContain("references/sites.md");
    expect(Buffer.byteLength(guide, "utf8")).toBeLessThan(12_000);
    expect(files["references/sites.md"]).toContain("environment-port");
    expect(files["references/sites.md"]).not.toContain("Naver:");
  });
});

describe("browser guide in results", () => {
  it("uses the shared note delivery for each URL independently of the guide pointer", () => {
    const guide = makeBrowserGuide(
      () => "/state/skills/browser/SKILL.md",
      (thread, url) => (url === "https://example.com" ? `saved:${thread}` : undefined),
    );
    expect(guide("thread-a", "https://example.com")).toContain("saved:thread-a");
    expect(guide("thread-a", "https://example.com")).toBe("saved:thread-a");
  });
  it("points each thread at the guide once without inventing static site notes", () => {
    const guide = makeBrowserGuide(() => "/state/skills/browser/SKILL.md");
    const first = guide("thread-a", "https://example.com/");
    expect(first).toBe(
      "Before more browser work, read the browser skill at /state/skills/browser/SKILL.md.",
    );
    expect(guide("thread-a", "https://example.com/next")).toBeUndefined();
    expect(guide("thread-a", "https://shopping.naver.com/")).toBeUndefined();
    const other = guide("thread-b", "http://localhost:5173/");
    expect(other).toContain("/state/skills/browser/SKILL.md");
    expect(guide("thread-b", "about:blank")).toBeUndefined();
  });
});
