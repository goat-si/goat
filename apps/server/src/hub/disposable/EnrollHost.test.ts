import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../../processRunner.ts";
import { phaseOf } from "../HubOcx.ts";
import { identityHintOf, journalServed, reachAnswerOf, writeKnownHostsOnce } from "./EnrollHost.ts";

// it.live: these run real processes and write real files, which only wall-clock fixtures can.
// Windows is skipped: the stand-in ocx is a shell script, and GOAT refuses a Windows hub's key.
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = process.getuid?.() === 0;
const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

// A stand-in ocx: the full journal listing of a busy Home is far past HubOcx's 256 KiB cap.
it.live.skipIf(WINDOWS)(
  "a Home that serves its journal is known by the exit code, however long the list",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const big = path.join(dir, "ocx-big");
      yield* fs.writeFileString(big, "#!/bin/sh\nhead -c 600000 /dev/zero | tr '\\0' x\nexit 0\n");
      yield* fs.chmod(big, 0o755);
      const missing = path.join(dir, "ocx-missing");
      yield* fs.writeFileString(
        missing,
        "#!/bin/sh\necho 'does not serve GET /api/link/operations' >&2\nexit 4\n",
      );
      yield* fs.chmod(missing, 0o755);
      expect(yield* journalServed(big, {})).toBe(true);
      expect(yield* journalServed(missing, {})).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(services)),
);

it("ssh's own whole lines decide how a reach ended; a banner cannot", () => {
  expect(reachAnswerOf(0, "")).toBe("ok");
  expect(reachAnswerOf(255, "runner@pen-x: Permission denied (publickey).")).toBe("key_refused");
  expect(reachAnswerOf(255, "Host key verification failed.")).toBe("host_key_changed");
  expect(reachAnswerOf(255, "kex_exchange_identification: Connection closed by remote host")).toBe(
    "unreachable",
  );
  // A machine's banner repeating ssh's words is not ssh's own line.
  expect(
    reachAnswerOf(
      255,
      "Welcome! Host key verification failed. is our motto\nrunner@pen-x: Permission denied (publickey).",
    ),
  ).toBe("key_refused");
  // GOAT's own known_hosts file is gone: ssh says no key is known, which is a wait, not a conflict.
  expect(
    reachAnswerOf(
      255,
      "No ED25519 host key is known for pen-x and you have requested strict checking.\nHost key verification failed.",
    ),
  ).toBe("host_key_unknown");
});

it.live.skipIf(WINDOWS)("the known_hosts line is published whole and written once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(yield* fs.makeTempDirectoryScoped(), "known_hosts");
    const line = "pen-x ssh-ed25519 AAAA\n";
    const file = yield* writeKnownHostsOnce(dir, "a1", line);
    expect(yield* fs.readFileString(file)).toBe(line);
    expect(yield* writeKnownHostsOnce(dir, "a1", line)).toBe(file);
    // Only the published file is left: the line went through a temporary file and a link.
    expect(yield* fs.readDirectory(dir)).toEqual(["a1"]);
    expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
    yield* fs.writeFileString(file, "");
    const changed = yield* writeKnownHostsOnce(dir, "a1", line).pipe(Effect.flip);
    expect(changed.reason).toBe("changed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(WINDOWS)("a temporary known_hosts file a crash left behind is removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(yield* fs.makeTempDirectoryScoped(), "known_hosts");
    const line = "pen-x ssh-ed25519 AAAA\n";
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "a1.new-crashed"), line);
    yield* fs.writeFileString(path.join(dir, "a2.new-other"), line);
    yield* writeKnownHostsOnce(dir, "a1", line);
    expect((yield* fs.readDirectory(dir)).toSorted()).toEqual(["a1", "a2.new-other"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("ocx's refusal of a key file is read by its hint, as the CLI prints it", () => {
  const line =
    "Error: Every directory above the identity file must be owned by this user or root and not writable by group or others unless it is sticky like /tmp, and every symlink on its path must be owned by this user or root. A home or state folder created under umask 002 (per-user groups on Ubuntu or Fedora) is group-writable: chmod g-w on that directory. (code invalid_identity_file, hint identity_file_ancestor)\n";
  expect(phaseOf(line)).toBe("identity_file_ancestor");
  expect(
    phaseOf(
      "Error: The identity file does not exist. (code invalid_identity_file, hint identity_file_missing)",
    ),
  ).toBe("identity_file_missing");
});

// Root reads a file of mode 0000, so the unreadable file this test needs cannot exist for it.
it.live.skipIf(WINDOWS || ROOT)("a known_hosts file GOAT cannot read is never replaced", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(yield* fs.makeTempDirectoryScoped(), "known_hosts");
    const line = "pen-x ssh-ed25519 AAAA\n";
    const file = yield* writeKnownHostsOnce(dir, "a1", "pen-x ssh-ed25519 BBBB\n");
    yield* fs.chmod(file, 0o000);
    const refused = yield* writeKnownHostsOnce(dir, "a1", line).pipe(Effect.flip);
    yield* fs.chmod(file, 0o600);
    expect(refused.reason).toBe("unwritable");
    expect(yield* fs.readFileString(file)).toBe("pen-x ssh-ed25519 BBBB\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("only the CLI's own refusal line of a failed command reads as a key-file hint", () => {
  expect(identityHintOf({ code: 1, phase: "identity_file_missing" })).toBe("identity_file_missing");
  expect(identityHintOf({ code: 0, phase: "identity_file_missing" })).toBeUndefined();
  expect(identityHintOf({ code: 1, phase: "remote_disconnect_failed" })).toBeUndefined();
  // A bare word elsewhere in the output is not the CLI's line.
  expect(phaseOf("Error: the Child said identity_file_missing in its own log")).toBeUndefined();
});
