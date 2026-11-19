// @effect-diagnostics nodeBuiltinImport:off -- The test runs the real CLI with an isolated home.
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { legacyOwnerStartTimeCommand } from "../legacyServerOwner.ts";

it.live("recognizes a live boot handoff marker and rejects stale markers", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const platform = yield* HostProcess.Platform;
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-home-owner-"));
    try {
      const runtime = NodePath.join(home, "runtime");
      NodeFS.mkdirSync(runtime, { recursive: true });
      const startCommand = legacyOwnerStartTimeCommand(process.pid, platform);
      const identity = NodeChildProcess.execFileSync(startCommand.command, startCommand.args, {
        encoding: "utf8",
        env: { ...process.env, ...startCommand.env },
      }).trim();
      const markerPath = NodePath.join(runtime, "service-update-handoff.json");
      const pending = {
        protocol: 3,
        activeVersion: "1.0.0",
        update: {
          id: "update-1",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath: NodePath.join(home, "userdata", "statev2.sqlite"),
          status: "pending",
        },
      };
      NodeFS.writeFileSync(NodePath.join(runtime, "service-state.json"), JSON.stringify(pending));
      const marker = {
        launcherPid: process.pid,
        launcherStart: identity,
        generation: "update-1",
        expiresAt: now + 60_000,
        writtenAt: now,
      };
      const helper = NodeURL.pathToFileURL(
        NodeURL.fileURLToPath(new URL("./sshHelper.ts", import.meta.url)),
      ).href;
      const script = `import * as Effect from 'effect/Effect'; import { Command } from 'effect/cli'; import { sshHelperCommand } from ${JSON.stringify(helper)}; await Effect.runPromise(Command.runWith(sshHelperCommand,{version:'test'})(['home-owned',${JSON.stringify(home)}]));`;
      const probe = () =>
        NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
        }).status;
      const write = (value: typeof marker) =>
        NodeFS.writeFileSync(markerPath, JSON.stringify(value));
      const writer = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
          markerPath,
          JSON.stringify(marker),
        ],
        { encoding: "utf8" },
      );
      assert.equal(writer.status, 0, writer.stderr);
      assert.equal(probe(), 0, "a live launcher must retain the handoff");
      write({ ...marker, launcherStart: "different-start" });
      assert.equal(probe(), 1, "a reused PID is stale");
      write({ ...marker, generation: "different-update" });
      assert.equal(probe(), 1, "another update is stale");
      write({ ...marker, expiresAt: now - 1 });
      assert.equal(probe(), 1, "an expired handoff is stale");
      write({ ...marker, launcherPid: 2147483647 });
      assert.equal(probe(), 1, "a dead launcher is stale");
      write(marker);
      const stateDir = NodePath.join(home, "userdata");
      NodeFS.mkdirSync(stateDir);
      const runtimeRecord = NodePath.join(stateDir, "server-runtime.json");
      NodeFS.writeFileSync(runtimeRecord, "{}");
      const newer = (marker.writtenAt + 5_000) / 1_000;
      NodeFS.utimesSync(runtimeRecord, newer, newer);
      assert.equal(probe(), 1, "a newer runtime record supersedes the handoff");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  }),
);
