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

// Same length as the hosts they replace: terminal tests assert cell offsets of a link.
const exampleHostScope = (path: string): boolean =>
  isTest(path) || path === "apps/server/scripts/acp-mock-agent.ts";

const authReturnTests = new Set([
  "apps/desktop/src/app/CodexAuthCallback.test.ts",
  "apps/desktop/src/app/DesktopClerk.test.ts",
  "apps/server/src/provider/CodexAuthCallback.test.ts",
  "packages/shared/src/codexAuthHandoff.test.ts",
]);

export const SAMPLE_TEXT_RULES: readonly TextRule[] = [
  {
    // Upstream's hosted app is no longer an accepted Codex sign-in return; these tests return to the desktop.
    id: "samples:auth-return-origin",
    category: "samples",
    find: /https:\/\/app\.t3\.codes(?=\/(?:welcome|settings))/g,
    replace: "goat://app",
    scope: (path) => authReturnTests.has(path),
  },
  {
    id: "samples:example-subdomain-hosts",
    category: "samples",
    find: /\b(app|clerk|preview|latest\.app|nightly\.app)\.t3\.codes\b/g,
    replace: "$1.exa.test",
    scope: exampleHostScope,
  },
  {
    id: "samples:example-host",
    category: "samples",
    find: /(?<![\w.-])t3\.codes\b/g,
    replace: "exa.test",
    scope: exampleHostScope,
  },
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
