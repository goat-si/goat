/** The fixture has one preference and two empty repositories. No prompt names a tool or an ID. */
export const prompts = [
  "Please remember this for all my projects: my default JavaScript package manager is npm.",
  "I've changed my mind. From now on my default JavaScript package manager is pnpm.",
  "For this repository only, please remember to use yarn. My default everywhere else stays the same.",
] as const;

/** Keep the original wording visible for ambiguous natural-language answers. */
export interface Entry {
  id: string;
  revision: string;
  scope: string;
  text: string;
  parents: ReadonlyArray<string>;
  writtenBy?: string | undefined;
}

export interface Observation {
  active: ReadonlyArray<Entry>;
  /** Retained revisions of listed memories, including their superseded values. */
  history: ReadonlyArray<Entry>;
}

type Verdict = "pass" | "fail" | "needs_review";

function wording(text: string, expected: string): Verdict {
  const mentions = new Set(text.toLowerCase().match(/\b(?:npm|pnpm|yarn)\b/g) ?? []);
  if (!mentions.has(expected)) return "fail";
  // A note can say "pnpm instead of npm". Do not guess the direction of a correction.
  if (
    mentions.size > 1 ||
    !/\b(?:use|using|uses|prefer|prefers|default|chosen)\b/i.test(text) ||
    /\b(?:not|never|avoid|don't|formerly|previously|no longer|other than|instead|except|rather than|besides|apart from|unless)\b/i.test(
      text,
    )
  )
    return "needs_review";
  return "pass";
}

function value(entries: ReadonlyArray<Entry>, expected: string): Verdict {
  return entries.length === 1 && entries[0] ? wording(entries[0].text, expected) : "fail";
}

function descendsFrom(current: Entry, original: Entry, history: ReadonlyArray<Entry>): boolean {
  const revisions = new Map(
    history.filter((entry) => entry.id === original.id).map((entry) => [entry.revision, entry]),
  );
  const pending = [...current.parents];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const entry = revisions.get(id);
    if (!entry) continue;
    if (id === original.revision) return true;
    pending.push(...entry.parents);
  }
  return false;
}

export function score([initial, correction, exception]: readonly [
  Observation,
  Observation,
  Observation,
]) {
  const users = (observation: Observation) =>
    observation.active.filter((item) => item.scope === "user");
  const first = users(initial);
  const revised = users(correction);
  const final = users(exception);
  const old = first[0];
  const current = revised[0];
  const checks = {
    initialGlobal: value(first, "npm"),
    correctedGlobal: value(revised, "pnpm"),
    correctedInPlace:
      old &&
      current &&
      first.length === 1 &&
      revised.length === 1 &&
      old.id === current.id &&
      old.revision !== current.revision &&
      descendsFrom(current, old, correction.history)
        ? "pass"
        : "fail",
    projectException: value(
      exception.active.filter((item) => item.scope === "exception-project"),
      "yarn",
    ),
    globalSurvivesException:
      current &&
      final.length === 1 &&
      final[0]?.id === current.id &&
      final[0].revision === current.revision
        ? value(final, "pnpm")
        : "fail",
    scopes:
      initial.active.every((item) => item.scope === "user") &&
      correction.active.every((item) => item.scope === "user") &&
      exception.active.every((item) => item.scope === "user" || item.scope === "exception-project")
        ? "pass"
        : "fail",
  } satisfies Record<string, Verdict>;
  const values = Object.values(checks);
  return {
    checks,
    verdict: values.includes("fail")
      ? "fail"
      : values.includes("needs_review")
        ? "needs_review"
        : "pass",
  };
}
