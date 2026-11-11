// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { lintChangedArgs, vitePlusCommand } from "./check-changed-command.ts";

it("allows lint-ignored changed files without failing on an unmatched pattern", () => {
  const cache = NodePath.resolve(import.meta.dirname, "../node_modules/.cache");
  NodeFS.mkdirSync(cache, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(cache, "check-changed-lint-"));
  try {
    const file = NodePath.join(dir, "ignored.js");
    NodeFS.writeFileSync(file, "const unused = 1;\n");
    const [plainCommand, plainArgs] = vitePlusCommand(["lint", file]);
    const plain = NodeChildProcess.spawnSync(plainCommand, plainArgs, { encoding: "utf8" });
    expect(plain.status, plain.stdout + plain.stderr).not.toBe(0);
    const [command, args] = vitePlusCommand(lintChangedArgs([file]));
    const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it("selects Astro components as code for lint and knip", async () => {
  const { isChangedCode } = await import("./check-changed-command.ts");
  const astro = "apps/marketing/src/pages/index.astro";
  expect(isChangedCode(astro)).toBe(true);
  expect(lintChangedArgs([astro])).toEqual(["lint", "--no-error-on-unmatched-pattern", astro]);
});

it("checks the agent surface audit and context budget as CI does when code or the audit page changes (#2828)", async () => {
  const { agentSurfaceCheckSteps } = await import("./check-changed-command.ts");
  const steps = [
    { name: "agent surface audit", args: ["run", "agent-surface:check"] },
    { name: "agent context budget", args: ["run", "agent-surface:context-budget-check"] },
  ];
  expect(agentSurfaceCheckSteps(["packages/contracts/src/agentSurface/settingsAccess.ts"])).toEqual(
    steps,
  );
  expect(agentSurfaceCheckSteps(["docs/internals/agent-surface-audit.md"])).toEqual(steps);
  expect(agentSurfaceCheckSteps(["docs/user/threads.md"])).toEqual([]);
});
