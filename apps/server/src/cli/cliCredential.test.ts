// @effect-diagnostics nodeBuiltinImport:off - CLI integration reads the temp state directory.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import { CliError, Command } from "effect/cli";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { cli } from "../binCli.ts";
import {
  type CliLogin,
  type StoredLogin,
  resolveCliCredential,
  threadEnvironmentFrom,
} from "./cliCredential.ts";

const ENDPOINT = "http://127.0.0.1:47011/mcp";
const AUTHORIZATION = "Bearer thread-token";

/** Every shape of thread credential a shell can hold; each one blocks minting. */
const threadShells = [
  { label: "endpoint only", env: { GOAT_ACP_MCP_ENDPOINT: ENDPOINT } },
  { label: "authorization only", env: { GOAT_ACP_MCP_AUTHORIZATION: AUTHORIZATION } },
  {
    label: "empty authorization",
    env: { GOAT_ACP_MCP_ENDPOINT: ENDPOINT, GOAT_ACP_MCP_AUTHORIZATION: "" },
  },
  {
    label: "valid credential",
    env: { GOAT_ACP_MCP_ENDPOINT: ENDPOINT, GOAT_ACP_MCP_AUTHORIZATION: AUTHORIZATION },
  },
] as const;

const mintingCommands = [
  ["auth", "pairing", "create"],
  ["auth", "session", "issue"],
  ["auth", "client", "create", "--name", "agent"],
  ["pair"],
  ["login"],
] as const;

/** Removed when the test's scope closes, failed or not. */
const tempBaseDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cli-credential-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

const runCli = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NetService.layer,
        TestConsole.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
      ),
    ),
  );

describe("credential-minting commands", () => {
  it.effect.each(
    mintingCommands.flatMap((command) =>
      threadShells.map((shell) => ({
        command,
        shell,
        label: `${command.join(" ")}, ${shell.label}`,
      })),
    ),
  )("refuse inside a thread before opening state: $label", ({ command, shell }) =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const error = yield* runCli([...command, "--base-dir", baseDir], shell.env).pipe(Effect.flip);
      assert.instanceOf(error, CliError.UserError);
      expect(error.userMessage).toContain("holds a GOAT thread credential");
      expect(NodeFS.readdirSync(baseDir)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

const login = (expiresAt: string): CliLogin => ({
  version: 1,
  sessionId: "session-1",
  token: "login-token",
  label: "goat CLI",
  expiresAt,
});
const stored = (value: CliLogin): StoredLogin => ({
  endpoint: "http://127.0.0.1:3773/mcp",
  login: value,
});
const mustNotReadLogin = Effect.die("the stored login must not be read");

describe("resolveCliCredential", () => {
  it.effect("uses the thread's own credential without reading a stored login", () =>
    Effect.gen(function* () {
      const credential = yield* resolveCliCredential(
        threadEnvironmentFrom(threadShells[3].env),
        mustNotReadLogin,
      );
      assert.deepStrictEqual(credential, {
        source: "thread",
        endpoint: ENDPOINT,
        authorization: AUTHORIZATION,
      });
    }),
  );

  it.effect.each([
    ...threadShells.slice(0, 3),
    {
      label: "endpoint not a URL",
      env: { GOAT_ACP_MCP_ENDPOINT: "goat", GOAT_ACP_MCP_AUTHORIZATION: AUTHORIZATION },
    },
  ])("fails closed on an unusable thread credential ($label)", ({ env }) =>
    Effect.gen(function* () {
      const error = yield* resolveCliCredential(threadEnvironmentFrom(env), mustNotReadLogin).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe("thread_credential_invalid");
    }),
  );

  it.effect("outside a thread uses the stored login until it expires", () =>
    Effect.gen(function* () {
      const absent = threadEnvironmentFrom({});
      const missing = yield* resolveCliCredential(absent, Effect.succeedNone).pipe(Effect.flip);
      expect(missing.reason).toBe("not_logged_in");

      const day = login("1970-01-02T00:00:00.000Z");
      const credential = yield* resolveCliCredential(absent, Effect.succeedSome(stored(day)));
      expect(credential).toMatchObject({ source: "login", authorization: "Bearer login-token" });

      yield* TestClock.adjust("2 days");
      const expired = yield* resolveCliCredential(absent, Effect.succeedSome(stored(day))).pipe(
        Effect.flip,
      );
      expect(expired.reason).toBe("login_expired");
    }),
  );
});

describe("goat thread", () => {
  it.effect("inside a thread calls only the thread's endpoint and stops when it is refused", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      using fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(null, { status: 401 }));
      const error = yield* runCli(
        ["thread", "list", "--base-dir", baseDir, "--project", "proj-1"],
        threadShells[3].env,
      ).pipe(Effect.flip);
      expect(String(error)).toContain("401");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe(ENDPOINT);
      expect(new Headers(init?.headers).get("authorization")).toBe(AUTHORIZATION);
      // Nothing minted: the state directory was never opened.
      expect(NodeFS.readdirSync(baseDir)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("outside a thread without a login asks for goat login instead of minting", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      const error = yield* runCli([
        "thread",
        "list",
        "--base-dir",
        baseDir,
        "--project",
        "proj-1",
      ]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CliCredentialError", reason: "not_logged_in" });
    }).pipe(Effect.scoped),
  );
});

describe("goat login", () => {
  it.effect(
    "stores one private mcp-client session, replaces it on relogin, and revokes it on logout",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const clients = () =>
          runCli(["auth", "client", "list", "--base-dir", baseDir, "--json"]).pipe(
            Effect.andThen(TestConsole.logLines),
            Effect.map((lines) =>
              (
                JSON.parse(String(lines.at(-1))) as ReadonlyArray<{ readonly sessionId: string }>
              ).map((session) => session.sessionId),
            ),
          );
        const loginFile = () => NodePath.join(baseDir, "userdata", "cli-login.json");
        const storedSession = () =>
          (JSON.parse(NodeFS.readFileSync(loginFile(), "utf8")) as CliLogin).sessionId;

        yield* runCli(["login", "--base-dir", baseDir]);
        const first = storedSession();
        expect(NodeFS.statSync(loginFile()).mode & 0o777).toBe(0o600);
        expect(yield* clients()).toEqual([first]);

        yield* runCli(["login", "--base-dir", baseDir]);
        const second = storedSession();
        expect(second).not.toBe(first);
        expect(yield* clients()).toEqual([second]);

        yield* runCli(["logout", "--base-dir", baseDir]);
        expect(NodeFS.existsSync(loginFile())).toBe(false);
        expect(yield* clients()).toEqual([]);
      }).pipe(Effect.scoped),
  );
});
