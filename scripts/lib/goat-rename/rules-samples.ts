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

// Tests whose subject is upstream itself: the triage playbook must not mention it, and the release
// notifier runs upstream's release.yml.
const upstreamSubjectTests = new Set([
  "apps/server/src/cli/triagePrompt.test.ts",
  "scripts/notify-discord-release.test.ts",
]);
// Here upstream is the unrelated repository next to goat-si/goat.
const UNRELATED_REPO_TEST = "scripts/build-desktop-artifact.test.ts";
const sampleRepoScope = (path: string): boolean =>
  (isTest(path) || path === "apps/server/scripts/acp-mock-agent.ts") &&
  !upstreamSubjectTests.has(path) &&
  path !== UNRELATED_REPO_TEST &&
  !path.startsWith(".github/");

const IDENTITY_TEST = "apps/server/src/project/RepositoryIdentityResolver.test.ts";
const identityTestSample = (id: string, find: RegExp, replace: string): TextRule => ({
  id: "samples:" + id,
  category: "samples",
  find,
  replace,
  scope: (path) => path === IDENTITY_TEST,
});

/** Upstream's repository as a sample repo in tests. */
const sampleRepo = (id: string, find: RegExp, replace: string): TextRule => ({
  id: "samples:" + id,
  category: "samples",
  find,
  replace,
  scope: sampleRepoScope,
});

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
  {
    id: "samples:worktree-setup-branch",
    category: "samples",
    find: /"t3\/feature"/g,
    replace: '"goat/feature"',
    scope: (path) => path === "apps/web/src/components/chat/WorktreeSetupCard.browser.test.tsx",
  },
  {
    id: "samples:worktree-setup-path",
    category: "samples",
    find: /"\/repo\/\.t3\/worktrees\/feature"/g,
    replace: '"/repo/.goat/worktrees/feature"',
    scope: (path) => path === "apps/web/src/components/chat/WorktreeSetupCard.browser.test.tsx",
  },
  sample("handle-julius", /\bjuliusmarminge\b/g, "alexmorgan"),
  sample("handle-theo", /\bt3dotgg\b/g, "riven-example"),
  sample("julius-upper", /\bJULIUS\b/g, "ALEX"),
  sample("julius-title", /\bJulius\b/g, "Alex"),
  sample("julius", /\bjulius\b/g, "alex"),
  sample("theo-title", /\bTheo\b/g, "Sam"),
  sample("theo", /\btheo\b/g, "sam"),
  // Split owner and name fields first, so they keep matching the combined spelling. Lowercase
  // spellings come before the mixed-case ones that case-insensitive matching tests use.
  sampleRepo(
    "repo-upstream-fields",
    /(\bowner"?:\s*")pingdotgg("[,\s]*"?(?:name|repo)"?:\s*")t3code"/g,
    '$1goat-si$2goat"',
  ),
  sampleRepo(
    "repo-tools-fields",
    /(\bowner"?:\s*")t3tools("[,\s]*"?(?:name|repo)"?:\s*")t3code"/g,
    '$1sample-tools$2goat"',
  ),
  sampleRepo("repo-upstream", /\bpingdotgg\/t3code\b/g, "goat-si/goat"),
  sampleRepo("repo-upstream-mixed", /\bpingdotgg\/t3code\b/gi, "Goat-SI/Goat"),
  sampleRepo("repo-tools", /\bt3tools\/t3code\b/g, "sample-tools/goat"),
  sampleRepo("repo-tools-title", /\bT3Tools\/t3code\b/g, "Sample-Tools/goat"),
  sampleRepo("repo-tools-mixed", /\bt3tools\/t3code\b/gi, "Sample-Tools/Goat"),
  sampleRepo("repo-octocat", /\boctocat\/t3code\b/g, "octocat/goat"),
  // /work/t3code-fork stays: its remote in the same test keeps the fork name.
  sampleRepo("checkout-path", /(?<=\/work(?:space)?\/)t3code(?!-[a-z])\b/g, "sample-repo"),
  // A fork and a Bitbucket workspace whose repository name is derived from the samples above.
  sampleRepo("repo-derived", /\b(binbandit|owner)\/t3code\b(?!-)/g, "$1/goat"),
  {
    id: "samples:repository-search-shorthand",
    category: "samples",
    find: /\bt3code(?=#\d)/g,
    replace: "goat",
    scope: (path) => path === "packages/shared/src/paletteSearch.test.ts",
  },
  {
    id: "samples:github-head-repository-name",
    category: "samples",
    find: /(\bheadRepository:\s*\{[^}]*\bname:\s*")t3code(?=")/g,
    replace: "$1goat",
    scope: (path) =>
      path === "packages/source-control-github/src/server/gitHubPullRequests.test.ts",
  },
  {
    id: "samples:change-request-identity-owner",
    category: "samples",
    find: /(\bowner:\s*")pingdotgg(?=")/g,
    replace: "$1goat-si",
    scope: (path) => path === "packages/client-runtime/src/changeRequestLinks.test.ts",
  },
  {
    id: "samples:change-request-identity-name",
    category: "samples",
    find: /\bt3code\b/g,
    replace: "goat",
    scope: (path) => path === "packages/client-runtime/src/changeRequestLinks.test.ts",
  },
  // This file also asserts owner and name separately, so its owner moves everywhere in it.
  identityTestSample("owner-tools-identity", /\bT3Tools\b/g, "Sample-Tools"),
  identityTestSample("owner-tools-identity-key", /(?<![\w.-])t3tools(?=\/)/g, "sample-tools"),
  identityTestSample("nested-identity", /(?<=\/platform\/)t3code\b/g, "goat"),
  identityTestSample("name-identity", /(?<=\.name\)\.toBe\(")t3code(?="\))/g, "goat"),
];
