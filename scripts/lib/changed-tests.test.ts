// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { testsForChanges } from "./changed-tests.ts";

const root = NodePath.resolve(import.meta.dirname, "../..");
const WEB_COVERAGE = "apps/web/src/reactCompilerCoverage.test.ts";
const MOBILE_COVERAGE = "apps/mobile/src/reactCompilerCoverage.test.ts";
const coverageSuites = (changes: ReadonlyArray<string>) =>
  [...testsForChanges(root, changes)].filter((file) =>
    file.endsWith("/reactCompilerCoverage.test.ts"),
  );

describe("testsForChanges", () => {
  it("runs the replay suites and prompt comparisons when shared prompt text changes (#901)", () => {
    const tests = testsForChanges(root, [
      "packages/provider-core/src/server/orchestrationInstructions.ts",
    ]);
    // The three suites that failed on dev after #847 passed check:changed.
    expect(tests).toContain(
      "apps/server/src/orchestration-v2/testkit/CursorReplayFixtures.integration.test.ts",
    );
    expect(tests).toContain(
      "apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts",
    );
    expect(tests).toContain("apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts");
    expect(tests).toContain(
      "apps/server/src/orchestration-v2/testkit/PiReplayFixtures.integration.test.ts",
    );
  });

  it("keeps an ordinary source change to the tests beside it", () => {
    expect([
      ...testsForChanges(root, ["packages/provider-core/src/server/memoryContext.ts"]),
    ]).toContain("packages/provider-core/src/server/memoryContext.test.ts");
    expect([...testsForChanges(root, ["scripts/check-release-version.ts"])]).toEqual([
      "scripts/check-release-version.test.ts",
    ]);
  });

  it("selects desktop grants through its testkit (#1705)", () => {
    expect(testsForChanges(root, ["apps/desktop/src/cua/DesktopCuaDriver.ts"])).toContain(
      "apps/desktop/src/cua/DesktopCuaGrants.test.ts",
    );
  });

  it("selects an importing test across a workspace export without server fanout (#1705)", () => {
    const selected = testsForChanges(root, [
      "packages/provider-opencode/src/server/v2/textGeneration.ts",
    ]);
    expect(selected).toContain("apps/server/src/textGeneration/OpenCode2TextGeneration.test.ts");
    expect(selected).not.toContain(
      "apps/server/src/orchestration-v2/CloudIngress.integration.test.ts",
    );
  });

  it("walks test fixtures but stops at production importers (#1705)", () => {
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "changed-tests-"));
    const write = (file: string, source: string) => {
      const path = NodePath.join(outside, file);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, source);
    };
    try {
      const source = "apps/example/src/feature.ts";
      write(source, "export const feature = true;\n");
      write("apps/example/src/feature.testkit.ts", 'import "./feature.ts";\n');
      write("apps/example/src/feature.fixture.ts", 'import "./feature.testkit.ts";\n');
      write("apps/example/src/consumer.test.ts", 'import "./feature.fixture.ts";\n');
      write("apps/example/src/production.ts", 'import "./feature.ts";\n');
      write("apps/example/src/production.test.ts", 'import "./production.ts";\n');
      write("docs/guide.md", "guide\n");

      const selected = testsForChanges(outside, [source]);
      expect(selected).toContain("apps/example/src/consumer.test.ts");
      expect(selected).not.toContain("apps/example/src/production.test.ts");
      expect([...testsForChanges(outside, ["docs/guide.md"])]).toEqual([]);
      expect([...testsForChanges(outside, ["apps/example/src/removed.ts"])]).toEqual([]);
    } finally {
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("runs the whole ingest suite for its SQL, a deleted file and the shared allowlist", () => {
    const ingestSuite = [
      "infra/ingest/src/batch.test.ts",
      "infra/ingest/src/store.test.ts",
      "infra/ingest/src/worker.test.ts",
    ];
    for (const changed of [
      ["infra/ingest/migrations/0001_batches.sql"],
      ["infra/ingest/migrations/0002_removed.sql"],
      ["packages/shared/src/analyticsAllowlist.ts"],
    ]) {
      const code = changed.filter((file) => file.endsWith(".ts"));
      expect([...testsForChanges(root, code, changed)], changed[0]).toEqual(
        expect.arrayContaining(ingestSuite),
      );
    }
    expect([...testsForChanges(root, [], ["infra/relay/migrations/postgres/0001.sql"])]).toEqual(
      [],
    );
  });

  // #1483 changed HubNodesSettings.tsx, passed its quick run, and left a compiler bailout that
  // failed every full run until #1491. The coverage suites scan their app's src, so no file sits
  // beside the component.
  it.each([
    ["web .tsx", "apps/web/src/components/settings/HubNodesSettings.tsx", WEB_COVERAGE],
    ["web .ts", "apps/web/src/appearanceContrast.ts", WEB_COVERAGE],
    ["mobile .tsx", "apps/mobile/src/App.tsx", MOBILE_COVERAGE],
    ["mobile .ts", "apps/mobile/src/components/brandAssets.ts", MOBILE_COVERAGE],
    // Deleting a file listed in mobile's KNOWN_BAILOUTS fails the suite's existence check.
    ["deleted mobile source", "apps/mobile/src/features/removed/Removed.tsx", MOBILE_COVERAGE],
  ])(
    "runs only that app's React Compiler coverage suite for a %s change (#1579)",
    (_, file, suite) => {
      expect(coverageSuites([file])).toEqual([suite]);
    },
  );

  it("runs each app's coverage suite once when several apps change (#1579)", () => {
    expect(
      coverageSuites([
        "apps/web/src/components/settings/HubNodesSettings.tsx",
        "apps/web/src/appearanceContrast.ts",
        "apps/mobile/src/App.tsx",
      ]).sort(),
    ).toEqual([MOBILE_COVERAGE, WEB_COVERAGE]);
  });

  it("runs no coverage suite for changes the suites do not compile (#1579)", () => {
    expect(
      coverageSuites([
        "apps/server/src/channels/ChannelDispatcher.ts",
        "apps/desktop/src/boot.ts",
        "apps/marketing/src/i18n/en.ts",
        "apps/web/src/authBootstrap.test.ts",
        "apps/web/vite.config.ts",
        "packages/shared/src/git.ts",
      ]),
    ).toEqual([]);
  });

  it("fails instead of returning a partial selection when git cannot answer", () => {
    const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "changed-tests-"));
    try {
      const file = "packages/provider-core/src/server/orchestrationInstructions.ts";
      NodeFS.mkdirSync(NodePath.join(outside, NodePath.dirname(file)), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(outside, "apps/server/src/orchestration-v2/testkit"), {
        recursive: true,
      });
      expect(() => testsForChanges(outside, [file])).toThrow(/git/);
    } finally {
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }
  });
});
