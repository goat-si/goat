import { describe, expect, it } from "vite-plus/test";

import { classifyChangedFile } from "./changedFileKind.ts";

describe("classifyChangedFile", () => {
  it("classifies Storybook files as tests without overriding generated or mock files", () => {
    for (const path of [
      "src/Button.stories.tsx",
      "src/Button.stories.mdx",
      "src\\Button.STORIES.TSX",
    ]) {
      expect(classifyChangedFile(path)).toBe("tests");
    }
    expect(classifyChangedFile("src/Button.stories.generated.ts")).toBe("generated");
    expect(classifyChangedFile("__mocks__/Button.stories.tsx")).toBe("mocks");
    expect(classifyChangedFile(".storybook/main.ts")).toBe("code");
  });
  it.each([
    ["src/contest.py", "code"],
    ["test/fixtures/pr.json", "mocks"],
    ["src/MockTransport.ts", "mocks"],
    ["src/FakeClock.ts", "mocks"],
    ["src/Foo.Mock.ts", "mocks"],
    ["src/Mockup.ts", "code"],
    ["src/Stubborn.ts", "code"],
    ["pnpm-lock.yaml", "generated"],
    ["convex/_generated/api.d.ts", "generated"],
    ["src/agent.eval.ts", "tests"],
    ["evals/title-generation.ts", "tests"],
    ["README.md", "docs"],
    ["tests/README.md", "tests"],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyChangedFile(path)).toBe(kind);
  });
});
