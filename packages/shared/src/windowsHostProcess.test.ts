// @effect-diagnostics nodeBuiltinImport:off -- These run the real PowerShell programs on Windows.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import * as HostProcess from "./HostProcess.ts";
import {
  encodePowerShellCommand,
  WINDOWS_SPAWN_AND_WAIT_POWERSHELL,
  WINDOWS_STOP_RECORDED_POWERSHELL,
} from "./windowsHostProcess.ts";

const powershell = (script: string, env: Record<string, string>) =>
  NodeChildProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(script)],
    { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
  );

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "Windows launch PowerShell",
  () => {
    it("stops a started program through its record only while the record's creation time is its own", () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-launch-"));
      const ping = NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");
      // A deadline that has passed: it publishes the record, then answers 4 without waiting.
      const spawned = powershell(WINDOWS_SPAWN_AND_WAIT_POWERSHELL, {
        GOAT_SPAWN_ARGS: [ping, "-n", "300", "127.0.0.1", ""].join("\n"),
        GOAT_SPAWN_ENV: "",
        GOAT_SPAWN_CWD: directory,
        GOAT_SPAWN_LOG: NodePath.join(directory, "server.log"),
        GOAT_SPAWN_RECORD: "launch.1",
        GOAT_LISTEN_PORT: "1",
        GOAT_WAIT_UNTIL_MS: "0",
      });
      const read = (name: string) => NodeFS.readFileSync(NodePath.join(directory, name), "utf8");
      let pid = 0;
      try {
        assert.equal(spawned.status, 4, spawned.stderr);
        const [recordedPid = "", birth = "", ...rest] = read("launch.1").trimEnd().split(" ");
        pid = Number(recordedPid);
        assert.deepEqual(rest, []);
        assert.match(birth, /^\d+$/);
        assert.deepEqual(["pid", "port", "managed"].map(read), [
          recordedPid + "\n",
          "1\n",
          "managed\n",
        ]);
        assert.isTrue(running(pid));
        const stop = (recordedBirth: string) =>
          powershell(WINDOWS_STOP_RECORDED_POWERSHELL, {
            GOAT_PROCESS_ID: recordedPid,
            GOAT_PROCESS_BIRTH: recordedBirth,
          });
        // Another creation time names another process at that PID: nothing is ended.
        const other = stop(String(BigInt(birth) + 1n));
        assert.equal(other.status, 3, other.stderr);
        assert.isTrue(running(pid));
        const stopped = stop(birth);
        assert.equal(stopped.status, 0, stopped.stderr);
        assert.isFalse(running(pid));
        const again = stop(birth);
        assert.equal(again.status, 2, again.stderr);
      } finally {
        // Only the program this test started, by the PID its own record captured.
        if (pid > 0 && running(pid)) process.kill(pid);
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
