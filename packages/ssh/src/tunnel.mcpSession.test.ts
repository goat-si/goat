import { SSH_RUNTIME_PROTOCOL_VERSION } from "@t3tools/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
// Execute the generated remote script without contacting SSH or a release server.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { buildRemoteMcpSessionScript, decodeRemoteMcpSessionOutput } from "./tunnel.ts";

const remoteShell = process.env.T3_SSH_TEST_SHELL ?? "/bin/sh";
// The generated MCP script invokes nested runners itself; changing those invocations would
// alter the production script under test. Runner bytes also stay intact for SHA-chain checks.

describe("remote MCP session script", () => {
  const stateKey = "session-test";
  const archiveVersion = "0.0.45";
  const token = "fake-mcp-session-token";
  const expiresAt = "2026-10-12T12:00:00.000Z";
  const options = {
    label: "worker's session; with spaces",
    // The fake accepts any duration so quoting can be tested independently of CLI validation.
    ttl: "12 hours' grace",
    runtimeModeCeiling: "approval-required",
  };
  let home: string;
  let runner: string;

  beforeEach(() => {
    home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-session-")),
    );
    const stateDirectory = NodePath.join(home, ".goat", "ssh-launch", stateKey);
    NodeFS.mkdirSync(stateDirectory, { recursive: true });
    runner = NodePath.join(stateDirectory, "run-t3.sh");
  });

  afterEach(() => {
    NodeFS.rmSync(home, { recursive: true, force: true });
  });

  const fakeCli = (rejectCeiling: boolean, issuedToken = token) => `#!/bin/sh
set -eu
if [ "$1" = --version ]; then printf 'goat v${archiveVersion}\\n'; exit 0; fi
if [ "$1" = __ssh-helper ] && [ "$2" = protocol ]; then
  case " $* " in
    *" --runtime-file "*) printf 'none unknown unknown unknown 0 0\\n' ;;
    *) printf '${archiveVersion} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0\\n' ;;
  esac
  exit 0
fi
if [ -f "$HOME/call-1.args" ]; then
  ARGS="$HOME/call-2.args"
else
  ARGS="$HOME/call-1.args"
fi
printf '%s\\n' "$@" > "$ARGS"
for ARG in "$@"; do
  if [ "$ARG" = "--runtime-mode-ceiling" ] && [ "${rejectCeiling ? "1" : "0"}" = "1" ]; then
    if [ -f "$HOME/change-runner" ]; then printf '# changed during auth\\n' >> "$HOME/.goat/ssh-launch/${stateKey}/run-t3.sh"; fi
    printf 'unknown option: --runtime-mode-ceiling\\n' >&2
    exit 2
  fi
done
cat <<'JSON'
${JSON.stringify({ sessionId: "fake-session-id", token: issuedToken, expiresAt, subject: "mcp-client" }, null, 2)}
JSON
`;

  const installFakeRunner = (rejectCeiling: boolean) => {
    const script = fakeCli(rejectCeiling);
    const directory = NodePath.join(home, ".goat/runtime/goat/versions", archiveVersion);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "goat"), script, { mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(directory, ".install-complete"), archiveVersion);
    const url = new URL("./tunnel.ts", import.meta.url).href;
    const bytes = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as t from ${JSON.stringify(url)}; process.stdout.write(t.buildRemoteT3RunnerScript({archiveVersion:${JSON.stringify(archiveVersion)}}));`,
      ],
      { encoding: "utf8" },
    );
    NodeFS.writeFileSync(runner, bytes, { mode: 0o700 });
    return bytes;
  };

  const runSession = (
    keepExistingRunner = true,
    runtimeModeCeiling: string | null = options.runtimeModeCeiling,
    retainedSha = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(runner)).digest("hex"),
  ) => {
    const script = buildRemoteMcpSessionScript(
      stateKey,
      { ...options, runtimeModeCeiling },
      {
        archiveVersion,
        keepExistingRunner,
      },
      {
        runner: { archiveVersion, keepExistingRunner },
        version: archiveVersion,
        requestedVersion: archiveVersion,
        source: "retained",
        requireInstalled: true,
        mayUpgradeOwnedServer: false,
        retainedRunnerSha256: retainedSha,
      },
    );
    // Await shell completion without blocking the worker or imposing a wall-clock
    // cutoff on the protocol and hash checks when the full suite is busy.
    return Effect.callback<string, Error>((resume) => {
      const child = NodeChildProcess.execFile(
        remoteShell,
        [],
        {
          cwd: home,
          env: { HOME: home, PATH: process.env.PATH, LC_ALL: "C" },
          encoding: "utf8",
        },
        (error, stdout) => resume(error === null ? Effect.succeed(stdout) : Effect.fail(error)),
      );
      child.stdin?.end(script);
      return Effect.sync(() => {
        child.kill();
      });
    }).pipe(Effect.flatMap(decodeRemoteMcpSessionOutput));
  };

  const receivedArgs = (call: number) =>
    NodeFS.readFileSync(NodePath.join(home, `call-${call}.args`), "utf8")
      .trimEnd()
      .split("\n");

  const expectedArgs = [
    "auth",
    "session",
    "issue",
    "--base-dir",
    "",
    "--subject",
    "mcp-client",
    "--scope",
    "orchestration:read",
    "--scope",
    "orchestration:operate",
    "--ttl",
    options.ttl,
    "--label",
    options.label,
    "--json",
  ];
  const baseArgs = () =>
    expectedArgs.map((arg) => (arg === "" ? NodePath.join(home, ".goat") : arg));

  it.effect("retries an older CLI without the ceiling and decodes its pretty JSON", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(true);
      expect(yield* runSession()).toEqual({ token, expiresAt, runtimeModeCeilingApplied: false });
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(receivedArgs(2)).toEqual(baseArgs());
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
    }),
  );

  it.effect("reports the ceiling as applied when the remote CLI accepts it", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(false);
      expect(yield* runSession()).toEqual({ token, expiresAt, runtimeModeCeilingApplied: true });
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
      // A second invocation would be logged separately even if it succeeded.
      expect(() => receivedArgs(2)).toThrow();
    }),
  );

  it.effect("issues one session with the remote default when no ceiling is requested", () =>
    Effect.gen(function* () {
      installFakeRunner(false);
      expect(yield* runSession(true, null)).toEqual({
        token,
        expiresAt,
        runtimeModeCeilingApplied: false,
      });
      expect(receivedArgs(1)).toEqual(baseArgs());
      expect(() => receivedArgs(2)).toThrow();
    }),
  );

  it.effect("retains the installed runner even when keepExistingRunner is false", () =>
    Effect.gen(function* () {
      const originalRunner = installFakeRunner(false);
      expect(yield* runSession(false)).toEqual({
        token,
        expiresAt,
        runtimeModeCeilingApplied: true,
      });
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(originalRunner);
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(() => receivedArgs(2)).toThrow();
      expect(
        NodeFS.readFileSync(
          NodePath.join(home, ".goat/runtime/goat/versions", archiveVersion, ".install-complete"),
          "utf8",
        ),
      ).toBe(archiveVersion);
    }),
  );
  it.effect("rejects changed selected bytes before publishing or issuing auth", () =>
    Effect.gen(function* () {
      const original = installFakeRunner(false);
      const sha = NodeCrypto.createHash("sha256").update(original).digest("hex");
      NodeFS.appendFileSync(runner, "\n# replacement\n");
      const result = yield* Effect.result(runSession(true, options.runtimeModeCeiling, sha));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain("changed since probe");
      expect(() => receivedArgs(1)).toThrow();
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(original + "\n# replacement\n");
      expect(
        NodeFS.readdirSync(NodePath.dirname(runner)).filter(
          (name) => name.includes(".next.") || name.endsWith(".pin"),
        ),
      ).toEqual([]);
    }),
  );
  it.effect("rechecks selected bytes before retrying a rejected ceiling", () =>
    Effect.gen(function* () {
      const original = installFakeRunner(true);
      NodeFS.writeFileSync(NodePath.join(home, "change-runner"), "1");
      const result = yield* Effect.result(runSession());
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain("changed since probe");
      expect(receivedArgs(1)).toEqual([
        ...baseArgs(),
        "--runtime-mode-ceiling",
        options.runtimeModeCeiling,
      ]);
      expect(() => receivedArgs(2)).toThrow();
      expect(NodeFS.readFileSync(runner, "utf8")).toBe(original + "# changed during auth\n");
      expect(
        NodeFS.readdirSync(NodePath.dirname(runner)).filter(
          (name) => name.includes(".next.") || name.endsWith(".pin"),
        ),
      ).toEqual([]);
    }),
  );
});
