// @effect-diagnostics nodeBuiltinImport:off -- Runs a real shell with an isolated environment.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { readEnvironmentFromLoginShell } from "./shell.ts";

describe("readEnvironmentFromLoginShell", () => {
  it.runIf(NodeFS.existsSync("/bin/bash"))(
    "captures a replaced PATH using printenv from the inherited quoted path",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-shell-env-"));
      try {
        const tools = NodePath.join(home, "도구 'quoted $dir");
        NodeFS.mkdirSync(tools);
        NodeFS.writeFileSync(
          NodePath.join(tools, "printenv"),
          '#!/bin/sh\nprintf "%s\\n" "$PATH"\n',
          { mode: 0o755 },
        );
        vi.stubEnv("PATH", tools);
        const shellPath = NodePath.join(home, "empty");
        const bashEnv = NodePath.join(home, "env.bash");
        NodeFS.writeFileSync(
          bashEnv,
          `export PATH='${shellPath}'\nfunction /usr/bin/printenv { return 127; }\n`,
        );
        expect(
          readEnvironmentFromLoginShell("/bin/bash", ["PATH"], (file, [, command = ""], options) =>
            NodeChildProcess.execFileSync(file, ["-c", command], {
              ...options,
              env: { HOME: home, PATH: tools, BASH_ENV: bashEnv },
            }),
          ),
        ).toEqual({ PATH: shellPath });
      } finally {
        vi.unstubAllEnvs();
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
