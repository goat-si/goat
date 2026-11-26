import { describe, expect, it } from "@effect/vitest";
import { type Entry, type Observation, score } from "./score.ts";

const npm: Entry = {
  id: "global",
  revision: "first",
  scope: "user",
  text: "Use npm.",
  parents: [],
};
const pnpm: Entry = { ...npm, revision: "second", text: "Use pnpm.", parents: ["first"] };
const yarn: Entry = {
  id: "local",
  revision: "third",
  scope: "exception-project",
  text: "Use yarn.",
  parents: [],
};
const at = (active: Entry[], history = active): Observation => ({ active, history });
const seed = at([npm]);
const edit = at([pnpm], [npm, pnpm]);
const local = at([pnpm, yarn], [npm, pnpm, yarn]);

describe("package manager preference correction", () => {
  it("accepts a revision of the same memory and a separate repository override", () => {
    expect(score([seed, edit, local]).verdict).toBe("pass");
  });
  it("fails a second active default even if one is the new value", () => {
    expect(
      score([seed, at([npm, { ...pnpm, id: "duplicate" }]), local]).checks.correctedGlobal,
    ).toBe("fail");
  });
  it("distinguishes replacing the ID or losing its history from an in-place revision", () => {
    expect(
      score([seed, at([{ ...pnpm, id: "replacement" }], [npm]), local]).checks.correctedInPlace,
    ).toBe("fail");
    expect(score([seed, at([pnpm]), local]).checks.correctedInPlace).toBe("fail");
  });
  it("requires a connected revision history, including intermediate updates", () => {
    const detached = { ...pnpm, parents: ["other"] };
    expect(score([seed, at([detached], [npm, detached]), local]).checks.correctedInPlace).toBe(
      "fail",
    );
    const middle = { ...pnpm, revision: "intermediate" };
    const head = { ...pnpm, parents: [middle.revision] };
    expect(score([seed, at([head], [npm, middle, head]), local]).checks.correctedInPlace).toBe(
      "pass",
    );
  });
  it("rejects a global overwrite and an override in the wrong repository", () => {
    expect(
      score([seed, edit, at([{ ...yarn, id: "global", scope: "user" }])]).checks
        .globalSurvivesException,
    ).toBe("fail");
    expect(score([seed, edit, at([pnpm, { ...yarn, scope: "default-project" }])]).verdict).toBe(
      "fail",
    );
  });
  it("surfaces ambiguous evidence for review", () => {
    expect(
      score([seed, at([{ ...pnpm, text: "Use pnpm instead of npm." }], [npm, pnpm]), local])
        .verdict,
    ).toBe("needs_review");
    expect(score([at([{ ...npm, text: "Never use npm." }]), edit, local]).verdict).toBe(
      "needs_review",
    );
  });
  it("rejects a reply with no stored preference", () => {
    expect(score([at([]), at([]), at([])]).verdict).toBe("fail");
  });
});
