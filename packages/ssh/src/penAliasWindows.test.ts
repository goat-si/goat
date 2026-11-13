// @effect-diagnostics nodeBuiltinImport:off -- This fixture runs the system OpenSSH against a temporary configuration.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { inspectPenExactAlias } from "./penAlias.ts";

const node = "a".repeat(26);
const alias = `pen-${node}`;
const noise = "A".repeat(43);
const systemBinary = (name: string) => {
  const candidate = NodePath.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "OpenSSH",
    `${name}.exe`,
  );
  return NodeFS.existsSync(candidate) ? candidate : name;
};

for (const [expected, mode] of [
  ["trusted", ""],
  ["node-mismatch", "wrong-node"],
  ["not-pen-route", "extra"],
  ["not-pen-route", "jump"],
  ["known-hosts-not-pen", "second-file"],
] as const) {
  it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
    `inspects real Windows ssh: ${expected} ${mode}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "penwin-" });
        const dir = path.join(home, ".ssh", "pen");
        yield* fs.makeDirectory(dir, { recursive: true });
        const config = path.join(dir, "config");
        const key = path.join(home, "hostkey");
        const ssh = systemBinary("ssh");
        const keygen = systemBinary("ssh-keygen");
        const binary = path.join(home, "pen.exe");
        const escaped = binary.replaceAll('"', '\\"');
        const proxyNode = mode === "wrong-node" ? "b".repeat(26) : node;
        const proxy = `"${escaped}" pipe --node ${proxyNode} --noise ${noise} 22${mode === "extra" ? " extra" : ""}`;
        const knownHosts = path.join(dir, "known_hosts").replaceAll("\\", "/");
        const configText = `Host ${alias}\n    ProxyCommand ${proxy}\n    UserKnownHostsFile "${knownHosts}"${mode === "second-file" ? " /other" : ""}\n    StrictHostKeyChecking yes\n${mode === "jump" ? "    ProxyJump jump\n" : ""}`;
        yield* fs.writeFileString(config, configText);
        const output = NodeChildProcess.spawnSync(ssh, ["-F", config, "-G", alias], {
          encoding: "utf8",
        });
        const diagnostic = `ssh binary: ${ssh}\nssh -G stdout:\n${output.stdout}\nssh -G stderr:\n${output.stderr}`;
        const generated = NodeChildProcess.spawnSync(
          keygen,
          ["-q", "-t", "ed25519", "-N", "", "-f", key],
          { encoding: "utf8" },
        );
        expect(generated.status, `${diagnostic}\nssh-keygen: ${keygen}\n${generated.stderr}`).toBe(
          0,
        );
        const publicKey = yield* fs.readFileString(`${key}.pub`);
        yield* fs.writeFileString(path.join(dir, "known_hosts"), `${alias} ${publicKey}`);
        const result = yield* inspectPenExactAlias({
          alias,
          homeDirectory: home,
          sshConfigFile: config,
          sshCommand: ssh,
          sshKeygenCommand: keygen,
        }).pipe(Effect.result);
        expect(result._tag, diagnostic).toBe("Success");
        if (result._tag === "Success") {
          if (expected === "trusted")
            expect(result.success, diagnostic).toMatchObject({
              alias,
              nodeId: node,
              noisePub: noise,
            });
          else expect(result.success, diagnostic).toEqual({ refused: expected });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
