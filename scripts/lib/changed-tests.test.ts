// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { testsForChanges } from "./changed-tests.ts";

const root = NodePath.resolve(import.meta.dirname, "../..");

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
