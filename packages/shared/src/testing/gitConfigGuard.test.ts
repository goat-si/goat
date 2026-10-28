// @effect-diagnostics nodeBuiltinImport:off - drives the Vitest global setup, outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it, vi } from "vite-plus/test";

import { setup } from "./gitConfigGuard.ts";
import { isolatedGitEnv } from "./gitEnv.ts";

const tempRepository = (entries: ReadonlyArray<readonly [key: string, value: string]>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-config-guard-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { env: isolatedGitEnv() });
  git("init", "--quiet");
  for (const [key, value] of entries) git("config", "--file", ".git/config", key, value);
  return { root, [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }) };
};

it("refuses to start while the repository config still holds a test identity (#1114 leftovers)", () => {
  using repository = tempRepository([
    ["user.name", "T3 Code Test"],
    ["user.email", "t3code-test@example.com"],
  ]);
  using _cwd = vi.spyOn(process, "cwd").mockReturnValue(repository.root);

  expect(() => setup()).toThrow(/user\.email=t3code-test@example\.com/);
});

it("starts when the repository config holds a real identity", () => {
  using repository = tempRepository([
    ["user.name", "JUN"],
    ["user.email", "jun@lidgeai.com"],
  ]);
  using _cwd = vi.spyOn(process, "cwd").mockReturnValue(repository.root);

  expect(setup()).toBeTypeOf("function");
});
