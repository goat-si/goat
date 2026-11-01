import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { AuthEnvironmentScope } from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";

import * as SshAuth from "./auth.ts";
import { SshPairingError } from "./errors.ts";
import {
  NODE_SCRIPT,
  commandArgs,
  makeSuccessfulProcess,
  remoteShell,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import {
  SshEnvironmentManager,
  buildRemoteClientSessionScript,
  decodeRemoteClientSessionOutput,
  type RemoteClientSessionOptions,
} from "./tunnel.ts";

const options = {
  subject: "hub-proxy",
  label: "GOAT hub proxy",
  ttl: "12h",
  scopes: ["orchestration:read", "filesystem:read"],
} satisfies RemoteClientSessionOptions;
const token = "fixture-client-session-token";
const expiresAt = "2026-10-21T00:00:00.000Z";
const session = { token, expiresAt, scopes: options.scopes };

describe("remote client session script", () => {
  it("requests only the explicit scopes and client subject", () => {
    const script = buildRemoteClientSessionScript("client-session-test", options, NODE_SCRIPT);
    expect(script).toContain(
      'recheck_selected_before_use\n"$RUNNER_FILE" auth session issue --base-dir "$DEFAULT_SERVER_HOME" ' +
        "--subject 'hub-proxy' --scope 'orchestration:read' --scope 'filesystem:read' " +
        "--ttl '12h' --label 'GOAT hub proxy' --json",
    );
    expect(script).not.toContain("--runtime-mode-ceiling");
    expect(script).not.toContain("--scope 'orchestration:operate'");
    expect(script).not.toMatch(/@@GOAT_[A-Z_]+@@/u);
  });

  it("quotes single quotes and shell expressions in client metadata", () => {
    const script = buildRemoteClientSessionScript(
      "client-session-test",
      {
        ...options,
        subject: "hub's proxy",
        label: "hub's session; $(touch /never-execute)",
        ttl: "12 hours' grace",
      },
      NODE_SCRIPT,
    );
    expect(script).toContain("--subject 'hub'\\''s proxy'");
    expect(script).toContain("--label 'hub'\\''s session; $(touch /never-execute)'");
    expect(script).toContain("--ttl '12 hours'\\'' grace'");
  });

  it.live("passes quoted values unchanged through the real runner and shell", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-client-session-" });
      const cli = `${home}/cli.mjs`;
      yield* fs.writeFileString(
        cli,
        `const args = process.argv.slice(2);
if (args[0] === "--version") console.log("goat v1.2.3");
else if (args[0] === "__ssh-helper" && args[1] === "protocol") console.log(args.includes("--runtime-file") ? "none unknown unknown unknown 0 0" : "1.2.3 ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0");
else if (args[0] === "auth") console.log(JSON.stringify(args));
else process.exit(2);
`,
      );
      const quoted = { ...options, subject: "hub's proxy", label: "hub's session; $(false)" };
      // Render outside Vite so its transforms cannot alter the nested runner's function source.
      const renderer = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "--input-type=module",
          "-e",
          `import { buildRemoteClientSessionScript } from ${JSON.stringify(new URL("./tunnel.ts", import.meta.url).href)};
process.stdout.write(buildRemoteClientSessionScript("client-session-test", ${JSON.stringify(quoted)}, { nodeScriptPath: ${JSON.stringify(cli)} }));`,
        ]),
      );
      const generated = yield* Effect.all({
        script: renderer.stdout.pipe(Stream.decodeText(), Stream.mkString),
        code: renderer.exitCode,
      });
      expect(generated.code).toBe(0);
      const child = yield* spawner.spawn(
        ChildProcess.make(remoteShell, [], {
          env: { HOME: home },
          stdin: {
            stream: Stream.make(new TextEncoder().encode(generated.script)),
            endOnDone: true,
          },
        }),
      );
      const result = yield* Effect.all({
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        code: child.exitCode,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        "auth",
        "session",
        "issue",
        "--base-dir",
        `${home}/.goat`,
        "--subject",
        quoted.subject,
        ...options.scopes.flatMap((scope) => ["--scope", scope]),
        "--ttl",
        options.ttl,
        "--label",
        quoted.label,
        "--json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("refuses empty scopes instead of falling back to CLI defaults", () => {
    expect(() =>
      buildRemoteClientSessionScript(
        "client-session-test",
        { ...options, scopes: [] },
        NODE_SCRIPT,
      ),
    ).toThrow("explicit scopes");
  });

  it("refuses the MCP-only audience", () => {
    expect(() =>
      buildRemoteClientSessionScript(
        "client-session-test",
        { ...options, subject: "mcp-client" },
        NODE_SCRIPT,
      ),
    ).toThrow("mcp-client");
  });
});

describe("remote client session decoding", () => {
  it.effect("decodes pretty CLI JSON after remote shell output", () =>
    Effect.gen(function* () {
      const stdout = `remote shell banner\n${JSON.stringify({ ...session, subject: options.subject, sessionId: "fixture-session" }, null, 2)}\n`;
      expect(yield* decodeRemoteClientSessionOutput(stdout, options.scopes)).toEqual(session);
    }),
  );

  it.effect("accepts the exact requested set regardless of order or duplicates", () =>
    Effect.gen(function* () {
      const scopes = ["filesystem:read", "orchestration:read", "filesystem:read"] as const;
      expect(
        yield* decodeRemoteClientSessionOutput(JSON.stringify({ ...session, scopes }), [
          ...options.scopes,
          "orchestration:read",
        ]),
      ).toEqual({ ...session, scopes });
    }),
  );

  it.effect("normalizes omitted and null expiry to null", () =>
    Effect.gen(function* () {
      for (const expiry of [undefined, null]) {
        expect(
          yield* decodeRemoteClientSessionOutput(
            JSON.stringify({ ...session, expiresAt: expiry }),
            options.scopes,
          ),
        ).toEqual({ ...session, expiresAt: null });
      }
    }),
  );

  it.effect("refuses broader, narrower, empty, missing, or malformed grants", () =>
    Effect.gen(function* () {
      for (const scopes of [
        [...options.scopes, "orchestration:operate"],
        ["orchestration:read"],
        ["orchestration:read", "orchestration:operate"],
        [],
        undefined,
        "orchestration:read",
        [...options.scopes, "unknown:scope"],
      ]) {
        const error = yield* decodeRemoteClientSessionOutput(
          JSON.stringify({ ...session, scopes }),
          options.scopes,
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(SshPairingError);
      }
    }),
  );

  it.effect("refuses empty or missing tokens and malformed output", () =>
    Effect.gen(function* () {
      for (const stdout of [
        JSON.stringify({ ...session, token: "" }),
        JSON.stringify({ ...session, token: " \n\t" }),
        JSON.stringify({ ...session, token: undefined }),
        "not JSON",
      ]) {
        const error = yield* decodeRemoteClientSessionOutput(stdout, options.scopes).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(SshPairingError);
      }
    }),
  );
});

describe("SSH manager client sessions", () => {
  it.effect("preserves the full target and refuses unexpected remote grants", () => {
    const issued: Array<{ args: ReadonlyArray<string>; script: string }> = [];
    let returnedScopes: ReadonlyArray<AuthEnvironmentScope> = options.scopes;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return makeSuccessfulProcess("hostname devbox.example.com\nuser default-user\nport 22\n");
        }
        if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
        const stdin = command.options.stdin;
        if (
          stdin === undefined ||
          typeof stdin !== "object" ||
          !("stream" in stdin) ||
          !Stream.isStream(stdin.stream)
        ) {
          return yield* Effect.die("Expected a remote session script");
        }
        issued.push({
          args,
          script: yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString),
        });
        return makeSuccessfulProcess(JSON.stringify({ ...session, scopes: returnedScopes }));
      }),
    );
    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;
      expect(yield* manager.issueClientSession(uploadTarget, options)).toEqual(session);
      returnedScopes = [...options.scopes, "orchestration:operate"];
      expect(
        yield* manager.issueClientSession(uploadTarget, options).pipe(Effect.flip),
      ).toBeInstanceOf(SshPairingError);
      expect(issued).toHaveLength(2);
      for (const { args, script } of issued) {
        expect(args).toContain(`${uploadTarget.username}@${uploadTarget.alias}`);
        expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual([
          "-p",
          String(uploadTarget.port),
        ]);
        expect(args.slice(-2)).toEqual(["sh", "-s"]);
        expect(script).toContain("--subject 'hub-proxy'");
        expect(script).toContain("--scope 'orchestration:read' --scope 'filesystem:read'");
        expect(script).toContain(NODE_SCRIPT.nodeScriptPath);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          Layer.succeed(SshAuth.SshPasswordPrompt, {
            isAvailable: false,
            request: () => Effect.die("Client session fixture must not prompt"),
          }),
          SshEnvironmentManager.layer({
            resolveCliRunner: Effect.succeed(NODE_SCRIPT),
            leaveRemoteServerRunning: true,
          }),
        ),
      ),
      Effect.scoped,
    );
  });
});
