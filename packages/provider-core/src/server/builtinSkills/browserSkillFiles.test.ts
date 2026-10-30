import { describe, expect, it } from "@effect/vitest";
import { BROWSER_SKILL_CORE } from "./browser.ts";
import {
  BROWSER_SKILL_DIRECTORY,
  BROWSER_SKILL_FILE,
  browserSiteNote,
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
    expect(files["references/sites.md"]).toContain(browserSiteNote("naver.com"));
    expect(files["references/sites.md"]).toContain(browserSiteNote("localhost"));
  });
});

describe("browser site notes", () => {
  it.each(["naver.com", "shopping.naver.com", "m.naver.com", "SHOPPING.NAVER.COM."])(
    "matches the registrable domain of %s",
    (hostname) => {
      expect(browserSiteNote(hostname)).toBe(browserSiteNote("naver.com"));
      expect(browserSiteNote(hostname)).toContain("access-limit");
    },
  );

  it.each(["example.com", "evilnaver.com", "naver.com.example.com", "", "naver.com.."])(
    "returns no note for unrelated or malformed host %s",
    (hostname) => {
      expect(browserSiteNote(hostname)).toBeUndefined();
    },
  );

  it.each(["localhost", "LOCALHOST.", "127.0.0.1", "127.0.0.1.", "[::1]", "::1"])(
    "shares the environment-port note for loopback host %s",
    (hostname) => {
      expect(browserSiteNote(hostname)).toBe(browserSiteNote("localhost"));
      expect(browserSiteNote(hostname)).toContain("environment-port");
    },
  );
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
  it("points a thread at the guide once and gives each site's notes on its first visit", () => {
    const guide = makeBrowserGuide(() => "/state/skills/browser/SKILL.md");
    const first = guide("thread-a", "https://example.com/");
    expect(first).toBe(
      "Before more browser work, read the browser skill at /state/skills/browser/SKILL.md.",
    );
    expect(guide("thread-a", "https://example.com/next")).toBeUndefined();
    expect(guide("thread-a", "https://shopping.naver.com/")).toContain(
      `GOAT notes for shopping.naver.com: ${browserSiteNote("naver.com")}`,
    );
    // Another page of the same site, or a subdomain sharing its note, says nothing new.
    expect(guide("thread-a", "https://m.naver.com/")).toBeUndefined();
    const other = guide("thread-b", "http://localhost:5173/");
    expect(other).toContain("/state/skills/browser/SKILL.md");
    expect(other).toContain("environment-port");
    expect(guide("thread-b", "about:blank")).toBeUndefined();
  });
});
