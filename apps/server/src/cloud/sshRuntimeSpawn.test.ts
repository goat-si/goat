// @effect-diagnostics nodeBuiltinImport:off - Each case owns an isolated native process and temp home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";

describe.each(["run", "runDetached"] as const)("%s native spawn ownership", (api) => {
  it.each(["missing", "normal", "nonzero", "cancel"] as const)(
    "maps %s from an isolated macrotask",
    async (mode) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-spawn-order-"));
      const child = NodeChildProcess.spawn(
        process.execPath,
        [NodePath.join(import.meta.dirname, "sshRuntimeSpawn.fixture.ts"), api, mode],
        {
          windowsHide: true,
          env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        stdout += text;
      });
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        expect(await closed, stderr).toBe(0);
        expect(stderr).not.toContain("UNHANDLED");
        const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith("RESULT="));
        expect(lines).toHaveLength(1);
        const value = JSON.parse(lines[0]!.slice("RESULT=".length));
        expect(value).toMatchObject({ platform: HostProcess.Platform.defaultValue(), api, mode });
        if (mode === "missing") {
          // Windows starts its Job owner successfully, which reports failure to start the target.
          expect(value.result.code).toBe(
            HostProcess.Platform.defaultValue() === "win32" ? 1 : null,
          );
        } else if (mode === "cancel") {
          expect(value.result).toEqual({
            interrupted: true,
            aliveAfterInterrupt: api === "runDetached",
            connectionClosed: true,
          });
        } else {
          expect(value.result).toEqual({
            code: mode === "nonzero" ? 7 : 0,
            stdout: "out",
            stderr: "err",
          });
        }
        // Natural fixture exit waits for owned children and file cleanup, including detached completion.
        expect(NodeFS.readdirSync(root)).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
