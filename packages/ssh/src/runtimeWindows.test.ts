import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type RuntimeSessionRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { issueExistingServerCredential } from "./appServer.ts";
import { SshCommandError } from "./errors.ts";
import {
  detectNativeWindows,
  issueWindowsCredential,
  NATIVE_WINDOWS,
  nativeWindowsAfter,
} from "./runtimeWindows.ts";
import { powershellCommand, WINDOWS_LOADER, windowsFrame } from "./runtimeWindowsScripts.ts";

/** The SSH command boundary: each call answers with the next scripted reply. */
const ssh = vi.hoisted(() => ({
  replies: [] as Array<
    { readonly stdout: string } | { readonly exitCode: number | null; readonly stderr?: string }
  >,
  calls: [] as Array<{
    readonly remoteCommandArgs?: ReadonlyArray<string>;
    readonly stdin?: string | Uint8Array;
  }>,
}));
vi.mock("./command.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./command.ts")>();
  const { SshCommandError: CommandError } = await import("./errors.ts");
  const Effects = await import("effect/Effect");
  return {
    ...actual,
    runSshCommand: (
      _target: unknown,
      input: {
        readonly remoteCommandArgs?: ReadonlyArray<string>;
        readonly stdin?: string | Uint8Array;
      },
    ) => {
      ssh.calls.push(input);
      const reply = ssh.replies.shift();
      if (reply === undefined) return Effects.die("unexpected SSH command");
      return "stdout" in reply
        ? Effects.succeed({ stdout: reply.stdout, stderr: "" })
        : Effects.fail(
            new CommandError({
              message: "ssh command failed",
              command: ["ssh"],
              exitCode: reply.exitCode,
              stderr: reply.stderr ?? "",
            }),
          );
    },
  };
});
const setup = (replies: typeof ssh.replies) => {
  ssh.replies = [...replies];
  ssh.calls = [];
  return ssh;
};

const target: DesktopSshEnvironmentTarget = {
  alias: "synthetic-child",
  hostname: "synthetic.invalid",
  username: "fixture",
  port: null,
};
const selection = {
  version: "0.0.45",
  executablePath: "C:\\Users\\fixture\\.goat\\runtime\\goat\\versions\\0.0.45\\goat.exe",
  baseDir: "C:\\Users\\fixture\\.goat",
  sha256: "a".repeat(64),
  pid: 1234,
  birth: "birth-1",
  environmentId: EnvironmentId.make("synthetic-child"),
  instanceId: "instance-1",
  nonce: "b".repeat(32),
  port: 43123,
};
const sessionId = AuthSessionId.make("native-session-1");
const native = "GOAT_NATIVE_WINDOWS=FullLanguage\r\n";
/** The request a native operation framed on stdin. */
const framed = (stdin: string | Uint8Array | undefined) => {
  const bytes = Buffer.from(stdin ?? "");
  return JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString("utf8")).request;
};
it("carries Unicode requests and archive bytes on stdin while the SSH command stays bounded", () => {
  const request = { op: "install", label: "한글 path 'quotes' & %VAR% \"x\"" };
  const archive = new Uint8Array(32_768).fill(0xe7);
  const frame = windowsFrame("param($r,$a) $r", request, archive);
  const length = frame.readUInt32LE(0);
  const header = JSON.parse(frame.subarray(4, 4 + length).toString("utf8"));
  expect(header).toMatchObject({ request, archiveBytes: archive.byteLength });
  expect(frame.subarray(4 + length)).toEqual(Buffer.from(archive));
  const command = powershellCommand(WINDOWS_LOADER).join(" ");
  expect(command.length).toBeLessThan(7000);
  expect(command).not.toContain(request.label);
  expect(() => windowsFrame("", { value: "x".repeat(131_073) })).toThrow();
});

it.effect.each([
  { name: "a PowerShell answer in Full Language mode", reply: { stdout: native }, answer: true },
  { name: "a shell without PowerShell", reply: { exitCode: 127 }, answer: false },
  { name: "an unrecognized answer", reply: { stdout: "unknown" }, answer: false },
])("native Windows detection reads $name with one probe", ({ reply, answer }) =>
  Effect.gen(function* () {
    const { calls } = setup([reply]);
    expect(yield* detectNativeWindows(target, {})).toBe(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.remoteCommandArgs?.[0]).toBe("powershell.exe");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a dropped connection or a constrained PowerShell is never a platform answer", () =>
  Effect.gen(function* () {
    setup([{ exitCode: 255, stderr: "connection closed" }]);
    expect((yield* detectNativeWindows(target, {}).pipe(Effect.flip))._tag).toBe("SshCommandError");
    setup([{ stdout: "GOAT_NATIVE_WINDOWS=ConstrainedLanguage\r\n" }]);
    expect((yield* detectNativeWindows(target, {}).pipe(Effect.flip)).message).toContain(
      "Constrained Language Mode",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a POSIX command that cannot start takes the native path only on native Windows", () =>
  Effect.gen(function* () {
    const started = new SshCommandError({
      message: "sh is not recognized",
      command: ["ssh"],
      exitCode: 1,
      stderr: "'sh' is not recognized as an internal or external command",
    });
    setup([{ stdout: native }]);
    expect(yield* nativeWindowsAfter(target, {})(started)).toBe(NATIVE_WINDOWS);
    setup([{ exitCode: 127 }]);
    expect(yield* nativeWindowsAfter(target, {})(started).pipe(Effect.flip)).toBe(started);
    // A lost connection is not retried as anything else.
    const { calls } = setup([]);
    const dropped = new SshCommandError({
      message: "connection closed",
      command: ["ssh"],
      exitCode: 255,
      stderr: "",
    });
    expect(yield* nativeWindowsAfter(target, {})(dropped).pipe(Effect.flip)).toBe(dropped);
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const sessionRequest: RuntimeSessionRequest = {
  kind: "session",
  subject: "mcp-client",
  scopes: ["orchestration:read"],
  ttl: "30s",
};

it.effect.each([
  {
    name: "an issued session without its issuer id",
    request: sessionRequest,
    reply: { token: "t" },
  },
  {
    name: "a revocation acknowledging another session",
    request: { kind: "revoke" as const, sessionId },
    reply: { sessionId: "other-session", revoked: true },
  },
  {
    name: "a revocation without its revoked flag",
    request: { kind: "revoke" as const, sessionId },
    reply: { sessionId },
  },
])("native credentials refuse $name", ({ request, reply }) =>
  Effect.gen(function* () {
    setup([{ stdout: JSON.stringify(reply) }]);
    const refused = yield* issueWindowsCredential(target, {}, selection, request).pipe(Effect.flip);
    expect(refused._tag).toBe("SshLaunchError");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns the native issuer session id to Home for later revocation", () =>
  Effect.gen(function* () {
    const issued = { sessionId, token: "fixture-bearer" };
    const { calls } = setup([{ stdout: JSON.stringify(issued) }]);
    const body = yield* issueWindowsCredential(target, {}, selection, sessionRequest);
    expect(JSON.parse(body)).toEqual(issued);
    expect(framed(calls[0]?.stdin)).toEqual({ op: "session", selection, request: sessionRequest });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])(
  "existing-server revocation on native Windows stays on native commands, revoked=%s",
  (revoked) =>
    Effect.gen(function* () {
      const acknowledgement = { sessionId, revoked };
      const { calls } = setup([
        { exitCode: 1, stderr: "'sh' is not recognized" },
        { stdout: native },
        { stdout: JSON.stringify({ selection, live: true, signals: { serverVersion: "0.0.45" } }) },
        { stdout: JSON.stringify(acknowledgement) },
      ]);
      const body = yield* issueExistingServerCredential(
        target,
        "managed",
        selection.port,
        { kind: "revoke", sessionId },
        {},
        selection.environmentId,
      );
      expect(JSON.parse(body)).toEqual(acknowledgement);
      // After the one POSIX attempt that could not start, every command is native.
      expect(calls.slice(1).every((call) => call.remoteCommandArgs?.[0] === "powershell.exe")).toBe(
        true,
      );
      expect(framed(calls.at(-1)?.stdin)).toEqual({
        op: "session",
        selection,
        request: { kind: "revoke", sessionId },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a native credential for a changed environment is refused before issuing", () =>
  Effect.gen(function* () {
    const { calls } = setup([
      { exitCode: 1, stderr: "'sh' is not recognized" },
      { stdout: native },
      { stdout: JSON.stringify({ selection, live: true }) },
    ]);
    const refused = yield* issueExistingServerCredential(
      target,
      "managed",
      selection.port,
      sessionRequest,
      {},
      EnvironmentId.make("another-environment"),
    ).pipe(Effect.flip);
    expect(refused._tag).toBe("SshPairingError");
    expect(calls).toHaveLength(3);
  }).pipe(Effect.provide(NodeServices.layer)),
);
