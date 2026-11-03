// @effect-diagnostics nodeBuiltinImport:off -- The timeout regression exercises a real shell process.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { readEnvironmentFromLoginShell } from "./shell.ts";

function stopFixture(pid: number) {
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "#2306 kills a login shell that ignores SIGTERM when the PATH probe times out",
  () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-shell-probe-"));
    const shell = NodePath.join(dir, "shell");
    const pidFile = NodePath.join(dir, "pid");
    NodeFS.writeFileSync(
      shell,
      "#!/bin/sh\ntrap '' TERM\necho $$ > \"$PROBE_PID_FILE\"\nexec sleep 30\n",
      { mode: 0o755 },
    );
    try {
      let failure: unknown;
      try {
        readEnvironmentFromLoginShell(shell, ["PATH"], (file, args, options) =>
          NodeChildProcess.execFileSync(file, args, {
            ...options,
            timeout: 1000,
            env: { ...process.env, PROBE_PID_FILE: pidFile },
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "ETIMEDOUT", signal: "SIGKILL" });
    } finally {
      if (NodeFS.existsSync(pidFile)) stopFixture(Number(NodeFS.readFileSync(pidFile, "utf8")));
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  },
);
