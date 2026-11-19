import { assert, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real ssh argument vector in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { baseSshArgs } from "./command.ts";

it("overrides an alias's remote command and terminal request", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-ssh-alias-"));
  try {
    const config = NodePath.join(home, "config");
    NodeFS.writeFileSync(
      config,
      "Host devbox\n  HostName example.invalid\n  RemoteCommand echo hijacked\n  RequestTTY force\n",
    );
    const args = baseSshArgs({ alias: "devbox", hostname: "devbox", username: null, port: null });
    const output = NodeChildProcess.execFileSync("ssh", ["-G", "-F", config, ...args, "devbox"], {
      encoding: "utf8",
    });
    assert.notMatch(output, /^remotecommand /m);
    assert.match(output, /^requesttty false$/m);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
