import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { INTERNAL_TEXT_RULES } from "./rules-internal.ts";
import { TEXT_RULES, KEEP_RULES } from "./rules.ts";

describe("internal remnant rules", () => {
  const rename = (path: string, text: string) => applyTextRules(path, text, TEXT_RULES).text;

  it.each([
    [
      ".agents/skills/test-goat-app/references/sqlite-fixtures.md",
      "  --file /tmp/t3-seed.sql",
      "  --file /tmp/goat-seed.sql",
    ],
    [
      ".env.example",
      "# GOAT_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile",
      "# GOAT_MACOS_PROVISIONING_PROFILE=/absolute/path/to/goat.provisionprofile",
    ],
    [
      "apps/server/src/device/DeviceHubProxy.ts",
      "// lands on T3's origin",
      "// lands on GOAT's origin",
    ],
    [
      "packages/provider-acp/src/server/adapter.ts",
      "// the T3 server's privileges",
      "// the GOAT server's privileges",
    ],
    [
      "packages/provider-pi/src/server/adapter.ts",
      "// through the T3 MCP extension",
      "// through the GOAT MCP extension",
    ],
    [
      "packages/contracts/src/rpc.ts",
      "/** bypass T3-owned caches */",
      "/** bypass GOAT-owned caches */",
    ],
    ["apps/server/src/device/ExpoApi.graphql", "query T3ExpoViewer {", "query GoatExpoViewer {"],
    [
      "apps/server/src/device/ExpoApi.graphql.ts",
      "export const T3ActiveEasSimulatorSessionsAppByIdApp =",
      "export const GoatActiveEasSimulatorSessionsAppByIdApp =",
    ],
    [
      "apps/server/src/device/ExpoApi.ts",
      "expo.T3StopEasSimulatorSession({ id })",
      "expo.GoatStopEasSimulatorSession({ id })",
    ],
    ["scripts/dev-runner.ts", '"--filter=t3"', '"--filter=goat"'],
    [
      ".github/scripts/ci-changes.cjs",
      'const BUILD_ONLY_DEPS = { t3: ["@goat/web"] };',
      'const BUILD_ONLY_DEPS = { goat: ["@goat/web"] };',
    ],
    [
      "apps/web/vite/warmBundledDev.ts",
      '"t3code-startup-warmup"; "t3code:warm-bundled-dev"; `[t3code]`',
      '"goat-startup-warmup"; "goat:warm-bundled-dev"; `[goat]`',
    ],
    [
      "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
      '"t3-claude"',
      '"goat-claude"',
    ],
    [
      "apps/desktop/gnome-extension/captureFeedback.js",
      "console.warn(`T3 capture effects unavailable: ${error.message}`);",
      "console.warn(`GOAT capture effects unavailable: ${error.message}`);",
    ],
    [
      "apps/desktop/gnome-extension/extension.js",
      "console.warn(`T3 capture preview unavailable: ${error.message}`);",
      "console.warn(`GOAT capture preview unavailable: ${error.message}`);",
    ],
    ["apps/server/src/cli/project.ts", 'label: "t3 project cli",', 'label: "goat project cli",'],
  ])("rewrites %s and remains idempotent", (path, source, expected) => {
    expect(rename(path, source)).toBe(expected);
    expect(rename(path, expected)).toBe(expected);
  });

  it.each([
    [
      "apps/desktop/scripts/electron-launcher.mjs",
      "// Adopts legacy T3 env names before anything reads the environment.",
    ],
    [
      "apps/server/src/device/DeviceHubProxy.ts",
      "  // rejects the loopback Origin set below, so every mutation fails over T3 Connect.",
    ],
    [
      "apps/server/src/relay/AgentAwarenessRelay.ts",
      '            "agent activity publishing standby; waiting for T3 Connect link reconciliation",',
    ],
    [
      "apps/server/src/relay/AgentAwarenessRelay.ts",
      '          yield* Effect.logInfo("agent activity publishing disabled by T3 Connect configuration");',
    ],
    [
      "apps/server/src/telemetry/Identify.ts",
      " * Who an install belongs to, from strongest to weakest. `connect` is the T3",
    ],
    [
      "apps/server/src/telemetry/Identify.ts",
      " * Owners the server can read without a client: the linked T3 Connect account",
    ],
    [
      "apps/server/src/telemetry/Identify.ts",
      '      Effect.logWarning("Failed to read the linked T3 Connect account for telemetry", {',
    ],
    [
      "packages/client-runtime/src/connection/errors.ts",
      "  // Over T3 Connect the relay already reached the host, so a request that never",
    ],
    [
      "packages/contracts/src/orchestratorMcp.ts",
      "  /** For webhook tasks: the public T3 Connect URL, shown only to a caller that may start the task's runs. */",
    ],
    [
      "packages/contracts/src/orchestratorMcp.ts",
      '      "Public URL to give the sender. Absent when this environment has no T3 Connect managed tunnel or this caller may not start the task\'s runs; webhookUrlUnavailableReason then says why.",',
    ],
    [
      "packages/contracts/src/relay.ts",
      '    "Clerk session or OAuth bearer token for the signed-in T3 Connect user.",',
    ],
    ["packages/contracts/src/relay.ts", '  .annotate(OpenApi.Title, "T3 Code Relay API")'],
    [
      "scripts/build-desktop-artifact.ts",
      "// Adopts legacy T3 env names before anything reads the environment.",
    ],
    [
      "scripts/build-desktop-artifact.ts",
      "  // Upstream T3 Code's MIT notice ships with every GOAT app (staged from LICENSE).",
    ],
    ["scripts/build-desktop-artifact.ts", '      maintainer: "T3 Tools <hello@t3.codes>",'],
    [
      "scripts/dev-runner.ts",
      "    // GOAT's live data, or the legacy T3 home when GOAT has none, as migrate-dev-db picks it.",
    ],
    [
      "vite.config.ts",
      "        // The `t3` npm launcher is published as plain, dependency-free Node.",
    ],
  ])("keeps inventoried external or legacy text in %s", (path, source) => {
    expect(rename(path, source)).toBe(source);
  });

  it.each([
    [".env.example", "# T3CODE_MOBILE_OTLP_TRACES_DATASET=t3-code-mobile-traces-dev"],
    [
      "apps/web/vite/warmBundledDev.ts",
      '"t3code-desktop"; "t3code:web-remote"; "t3code:other-plugin"',
    ],
  ])("keeps relay identities in %s", (path, source) => {
    expect(rename(path, source)).toBe(source);
  });

  it("leaves PR1 product lines to its own family", () => {
    for (const source of ["// T3 Code uses T3's server", "// T3 Code owns the server, but T3"]) {
      expect(
        applyTextRules("apps/server/src/device/DeviceHubProxy.ts", source, INTERNAL_TEXT_RULES)
          .text,
      ).toBe(source);
    }
  });

  it("confines each family to its owned path and leaves test inputs untouched", () => {
    const text = [
      "// T3's T3 server T3 MCP T3-owned context",
      "query T3ExpoViewer {",
      '"--filter=t3"; const BUILD_ONLY_DEPS = { t3: ["@goat/web"] };',
      '"t3code-startup-warmup"; "t3code:warm-bundled-dev"; `[t3code]`',
      '"t3-claude"; return "t3-code"; label: "t3 project cli",',
      "console.warn(`T3 capture effects unavailable: ${error.message}`);",
    ].join("\n");
    for (const path of [
      "AGENTS.md",
      "packages/ssh/src/x.ts",
      "apps/server/src/sshRemote/x.ts",
      "apps/server/src/device/ExpoApi.test.ts",
      "packages/provider-acp/src/server/adapter.test.ts",
      "apps/web/src/components/chat/TimelineToolActivityIcon.browser.test.tsx",
    ]) {
      expect(applyTextRules(path, text, INTERNAL_TEXT_RULES).text).toBe(text);
    }
    for (const source of [
      "// upstream T3 server",
      "// legacy T3 home",
      "// Copyright T3's authors",
      'const external = "T3 server";',
      "// T3 Connect relay",
      '// task "T3"',
    ]) {
      expect(rename("apps/server/src/device/DeviceHubProxy.ts", source)).toBe(source);
    }
    expect(
      rename(
        "apps/web/src/components/chat/TimelineWorkEntryRow.logic.ts",
        'presentation.icon === "t3-code"',
      ),
    ).toBe('presentation.icon === "t3-code"');
  });
});

it.each([
  [
    "packages/contracts/src/settings.ts",
    "/** Run `t3 doctor` or `t3 theme set`. */",
    "/** Run `goat doctor` or `goat theme set`. */",
  ],
  [
    "apps/server/src/cloud/pinnedRuntime.ts",
    "// `t3`, `t3.cmd`, `t3 serve` and `t3 update` launch T3 runtime.",
    "// `goat`, `goat.cmd`, `goat serve` and `goat update` launch GOAT runtime.",
  ],
  [
    "apps/server/src/environment/ServerEnvironment.ts",
    "// opt-in changes at runtime (`t3 connect",
    "// opt-in changes at runtime (`goat connect",
  ],
  [
    "packages/provider-opencode/src/server/v2/adapter.ts",
    "// T3 shows none; T3 restores state after T3 stops.",
    "// GOAT shows none; GOAT restores state after GOAT stops.",
  ],
  [
    "packages/provider-opencode/src/server/v2/adapter.ts",
    "// T3's own answers stay in the T3 database.",
    "// GOAT's own answers stay in the GOAT database.",
  ],
  [
    "apps/server/src/cli/consoleStdin.ts",
    "// `t3.cmd` and `t3` runs",
    "// `goat.cmd` and `goat` runs",
  ],
])("reproduces upstream internal prose in %s", (path, source, expected) => {
  expect(applyTextRules(path, source, TEXT_RULES).text).toBe(expected);
  expect(applyTextRules(path, expected, TEXT_RULES).text).toBe(expected);
});

it("retains the legacy scrub prefix without allowing arbitrary provider env residue", () => {
  const path = "packages/shared/src/testing/providerEnv.ts";
  const source = 'const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "T3CODE_"];';
  expect(applyTextRules(path, source, TEXT_RULES).text).toBe(source);
  expect(findResidue(path, source, KEEP_RULES)).toEqual([]);
  const comment =
    "// ANTHROPIC_BASE_URL) and the agent's own T3 state. Tests that read the ambient environment";
  expect(applyTextRules(path, comment, TEXT_RULES).text).toBe(comment);
  expect(findResidue(path, comment, KEEP_RULES)).toEqual([]);
  expect(findResidue(path, 'const wrong = "T3CODE_";', KEEP_RULES)).toHaveLength(1);
  expect(findResidue("packages/shared/src/other.ts", source, KEEP_RULES)).toHaveLength(1);
});

it.each([
  [
    "apps/server/src/cloud/pinnedRuntime.ts",
    "// Neither runs a t3 runtime.",
    "// Neither runs a GOAT runtime.",
  ],
  [
    "packages/provider-pi/src/server/mcpExtensionSource.ts",
    " * Do not import t3code modules from the string body.",
    " * Do not import GOAT modules from the string body.",
  ],
])("reproduces module/runtime comments in %s", (path, source, expected) => {
  expect(applyTextRules(path, source, TEXT_RULES).text).toBe(expected);
});
