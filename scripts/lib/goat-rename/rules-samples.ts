import type { TextRule } from "./engine.ts";
import { isTest } from "./paths.ts";

/**
 * Sample people in tests, fixtures and settings examples. Upstream's samples name its
 * maintainers; GOAT's use neutral names so a chase that takes upstream's side and reruns
 * --apply lands on the same samples. Word boundaries leave THEORY, Pantheon and Juliusz alone.
 */
const sampleScope = (path: string): boolean =>
  isTest(path) ||
  path === "packages/shared/src/model.ts" ||
  /BranchNamingSettings\.tsx$/.test(path);

const sample = (id: string, find: RegExp, replace: string): TextRule => ({
  id: "samples:" + id,
  category: "samples",
  find,
  replace,
  scope: sampleScope,
});

export const SAMPLE_TEXT_RULES: readonly TextRule[] = [
  {
    id: "samples:deps-readme",
    category: "samples",
    find: /\bJulius's\b/g,
    replace: "upstream's",
    scope: (path) => path === "apps/mobile/deps/README.md",
  },
  {
    id: "samples:branch-example",
    category: "samples",
    find: /Use julius\//g,
    replace: "Use feature/",
    scope: (path) => /BranchNamingSettings(?:\.test)?\.tsx$/.test(path),
  },
  sample("handle-julius", /\bjuliusmarminge\b/g, "alexmorgan"),
  sample("handle-theo", /\bt3dotgg\b/g, "riven-example"),
  sample("julius-upper", /\bJULIUS\b/g, "ALEX"),
  sample("julius-title", /\bJulius\b/g, "Alex"),
  sample("julius", /\bjulius\b/g, "alex"),
  sample("theo-title", /\bTheo\b/g, "Sam"),
  sample("theo", /\btheo\b/g, "sam"),
];
