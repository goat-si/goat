// @effect-diagnostics nodeBuiltinImport:off -- The probe runs bash with an isolated config file.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { readEnvironmentFromLoginShell } from "./shell.ts";

it.runIf(NodeFS.existsSync("/bin/bash"))(
  "ignores probe markers a bash DEBUG trap echoes into the terminal title",
  () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-bash-env-"));
    try {
      const shellPath = `${NodePath.join(home, "bin")}:/usr/bin:/bin`;
      const bashEnv = NodePath.join(home, "env.bash");
      NodeFS.writeFileSync(
        bashEnv,
        [
          `export PATH=${JSON.stringify(shellPath)}`,
          `trap 'echo -ne "\\033]0;\${BASH_COMMAND}\\007"' DEBUG`,
        ].join("\n"),
      );

      expect(
        readEnvironmentFromLoginShell(
          "/bin/bash",
          ["XDG_DATA_HOME", "PATH"],
          // Non-interactive bash reads only BASH_ENV, not the host's /etc startup files that -il runs.
          (file, [, command = ""], options) =>
            NodeChildProcess.execFileSync(file, ["-c", command], {
              ...options,
              env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb", BASH_ENV: bashEnv },
            }),
        ),
      ).toEqual({ PATH: shellPath });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);
