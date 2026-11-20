// @effect-diagnostics nodeBuiltinImport:off -- test uses native private files and symlinks as fixtures.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { makeMiniMaxCodeQuotaReader } from "./minimaxCodeAccountQuota.ts";

const CLIENT = "mcode-public";
const TOKEN = "mock-account-not-a-real-token";
const expiry = DateTime.toEpochMillis(DateTime.makeUnsafe("2099-01-01T00:00:00Z"));
const group = "test-personal-group";
const successIdentity = () =>
  Response.json({
    statusInfo: { code: 0 },
    data: {
      workspaces: [
        { workspace_type: 1, op_group_id: "unrelated-team" },
        { workspace_type: 0, workspace_id: 42, op_group_id: group },
      ],
    },
  });
const successQuota = () =>
  Response.json({
    base_resp: { status_code: 0 },
    model_remains: [
      {
        current_interval_remaining_percent: 90,
        current_weekly_remaining_percent: 70,
        end_time: expiry,
      },
    ],
  });

describe.skipIf(!NodeFS.constants.O_NOFOLLOW)("MiniMax Code login-backed quota", () => {
  let sandbox: string;
  let root: string;
  beforeEach(async () => {
    sandbox = await NodeFSP.mkdtemp(
      NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "goat-quota-fixture-"),
    );
    root = NodePath.join(sandbox, "selected-profile");
  });
  afterEach(async () => {
    await NodeFSP.rm(sandbox, { recursive: true, force: true });
  });

  async function writeFileJson(path: string, value: unknown) {
    await NodeFSP.writeFile(path, JSON.stringify(value), { mode: 0o600 });
  }
  async function fixture(selected = "en", overrides: Record<string, unknown> = {}) {
    const directory = NodePath.join(root, "auth", "prod", selected, CLIENT);
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const state = NodePath.join(directory, "auth-state.json");
    const credentials = NodePath.join(directory, "auth.json");
    const common = {
      clientId: CLIENT,
      audience: "agent-backend",
      generation: 12,
      expiresAtMs: expiry,
    };
    await writeFileJson(state, {
      ...common,
      schemaVersion: 2,
      status: "authenticated",
      storeKind: "file",
      buildEnv: "prod",
      region: selected,
    });
    const account = NodeCrypto.createHash("sha256")
      .update(NodePath.join(root, "auth") + "\0" + CLIENT)
      .digest("base64url");
    const key = `com.minimax.mcode.oauth.prod.${selected}\0${account}`;
    await writeFileJson(credentials, {
      schemaVersion: 1,
      records: {
        [key]: {
          ...common,
          schemaVersion: 1,
          accessToken: TOKEN,
          tokenType: "Bearer",
          ...overrides,
        },
      },
    });
    return { state, credentials };
  }

  const query = Effect.fnUntraced(function* (
    request: typeof fetch,
    options: NodeJS.ProcessEnv = {},
    args = ["acp"],
  ) {
    const read = yield* makeMiniMaxCodeQuotaReader(request);
    return yield* read(
      {
        MINIMAX_DATA_DIR: root,
        MINIMAX_API_KEY: "must-not-be-used",
        MAVIS_REGION: "en",
        ...options,
      },
      args,
    );
  });

  it.effect(
    "uses only the profile token and same-token personal workspace at fixed regional origins",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fixture());
        yield* Effect.promise(() => fixture("cn", { accessToken: "other-region" }));
        yield* Effect.promise(() =>
          NodeFSP.mkdir(NodePath.join(root, "preferences"), { mode: 0o700 }),
        );
        yield* Effect.promise(() =>
          writeFileJson(NodePath.join(root, "preferences", "mcode-region.json"), {
            version: 1,
            regions: { prod: "en" },
          }),
        );
        const request = vi
          .fn<typeof fetch>()
          .mockImplementationOnce(async (input, init) => {
            expect(String(input)).toBe(
              "https://agent.minimax.io/matrix/api/v1/user/get_user_extra_info",
            );
            expect(init?.method).toBe("POST");
            expect(init?.body).toBe("{}");
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + TOKEN);
            return successIdentity();
          })
          .mockImplementationOnce(async (input, init) => {
            expect(String(input)).toBe(
              "https://platform.minimax.io/v1/api/openplatform/coding_plan/remains",
            );
            expect(init?.method).toBe("GET");
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + TOKEN);
            expect(new Headers(init?.headers).get("x-group-id")).toBe(group);
            return successQuota();
          });
        const result = yield* query(request, {
          MINIMAX_BASE_URL: "https://not-minimax.invalid",
          MAVIS_REGION: undefined,
        });
        expect(request).toHaveBeenCalledTimes(2);
        expect(result?.windows.map((window) => window.usedPercent)).toEqual([10, 30]);
        expect(result?.windows[0]?.resetsAt).toBe("2099-01-01T00:00:00.000Z");
        expect(JSON.stringify(result)).not.toMatch(/mock-account|test-personal-group/);
      }),
  );

  it.effect("never scans a different data directory or falls back to an API key", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi.fn<typeof fetch>();
      expect(
        yield* query(request, { MINIMAX_DATA_DIR: NodePath.join(sandbox, "absent-profile") }),
      ).toBeNull();
      expect(yield* query(request, { MINIMAX_DATA_DIR: undefined, HOME: sandbox })).toBeNull();
      expect(yield* query(request, { MAVIS_REGION: undefined })).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses unsupported argument layouts, non-production scope or another region", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi.fn<typeof fetch>();
      expect(yield* query(request, {}, ["--profile", "other", "acp"])).toBeNull();
      expect(yield* query(request, { MAVIS_BUILD_ENV: "staging" })).toBeNull();
      expect(yield* query(request, { MAVIS_REGION: "cn" })).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    { expiresAtMs: 1 },
    { generation: 11 },
    { audience: "other" },
    { accessToken: "invalid\nheader" },
  ])("refuses an unverifiable credential (%j)", (overrides) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture("en", overrides));
      const request = vi.fn<typeof fetch>();
      expect(yield* query(request)).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses permissive, oversized or symlinked credential files", () =>
    Effect.gen(function* () {
      const { credentials } = yield* Effect.promise(() => fixture());
      const request = vi.fn<typeof fetch>();
      yield* Effect.promise(() => NodeFSP.chmod(credentials, 0o644));
      expect(yield* query(request)).toBeNull();
      yield* Effect.promise(() => NodeFSP.chmod(credentials, 0o600));
      yield* Effect.promise(() => NodeFSP.writeFile(credentials, "a".repeat(65_537)));
      expect(yield* query(request)).toBeNull();
      yield* Effect.promise(() => NodeFSP.rm(credentials));
      const decoy = NodePath.join(sandbox, "decoy");
      yield* Effect.promise(() => writeFileJson(decoy, {}));
      yield* Effect.promise(() => NodeFSP.symlink(decoy, credentials));
      expect(yield* query(request)).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    () => new Response("not authorized", { status: 401 }),
    () =>
      Response.json({
        statusInfo: { code: 0 },
        data: { workspaces: [{ workspace_type: 1, op_group_id: group }] },
      }),
    () =>
      Response.json({
        statusInfo: { code: 0 },
        workspaces: [
          { workspace_type: 0, workspace_id: 41, op_group_id: group },
          { workspace_type: 0, workspace_id: 42, op_group_id: "another" },
        ],
      }),
    () =>
      Response.json({
        statusInfo: { code: 0 },
        base_resp: { status_code: 42 },
        workspaces: [{ workspace_type: 0, workspace_id: 41, op_group_id: group }],
      }),
    () =>
      Response.json({
        statusInfo: { code: 0 },
        workspaces: [{ workspace_type: 0, op_group_id: group }],
      }),
    () => new Response(" ".repeat(65_537)),
  ])("does not request quota without a unique verified personal group", (response) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
      expect(yield* query(request)).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("discards a response after the active login changes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => successIdentity())
        .mockImplementationOnce(async () => {
          await fixture("en", { accessToken: "new-login" });
          return successQuota();
        });
      expect(yield* query(request)).toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("uses legacy remaining counts only for valid quota windows", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => successIdentity())
        .mockImplementationOnce(async () =>
          Response.json({
            base_resp: { status_code: 0 },
            model_remains: [
              {
                current_interval_total_count: 100,
                current_interval_usage_count: 72,
                current_weekly_total_count: 100,
                current_weekly_usage_count: 500,
              },
            ],
          }),
        );
      const result = yield* query(request);
      expect(result?.windows).toHaveLength(1);
      expect(result?.windows[0]?.usedPercent).toBe(28);
    }),
  );

  it.effect("does not send a quota request after the login changes during identity lookup", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
        await fixture("en", { accessToken: "new-login" });
        return successIdentity();
      });
      expect(yield* query(request)).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("interrupts the whole query once the four-second deadline expires", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const started = Promise.withResolvers<void>();
      let signal: AbortSignal | null | undefined;
      const request = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
        signal = init?.signal;
        started.resolve();
        return new Promise(() => undefined);
      });
      const read = yield* makeMiniMaxCodeQuotaReader(request);
      const pending = yield* read({ MINIMAX_DATA_DIR: root, MAVIS_REGION: "en" }, ["acp"]).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(pending)).toBeNull();
      expect(signal?.aborted).toBe(true);
    }),
  );

  it.effect("keeps the last reading through a failed read and clears it after a new login", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => successIdentity())
        .mockImplementationOnce(async () => successQuota())
        .mockImplementationOnce(async () => new Response(null, { status: 503 }))
        .mockImplementationOnce(async () => new Response(null, { status: 503 }));
      const read = yield* makeMiniMaxCodeQuotaReader(request);
      const env = { MINIMAX_DATA_DIR: root, MAVIS_REGION: "en" };
      expect((yield* read(env, ["acp"]))?.windows).toHaveLength(2);
      expect(yield* read(env, ["acp"])).toBeUndefined();
      yield* Effect.promise(() => fixture("en", { generation: 13 }));
      yield* Effect.promise(async () => {
        const state = NodePath.join(root, "auth", "prod", "en", CLIENT, "auth-state.json");
        const current = JSON.parse(await NodeFSP.readFile(state, "utf8"));
        await writeFileJson(state, { ...current, generation: 13 });
      });
      expect(yield* read(env, ["acp"])).toBeNull();
    }),
  );

  it.effect("clears the reading when the credential file is missing", () =>
    Effect.gen(function* () {
      const { credentials } = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() => NodeFSP.rm(credentials));
      const request = vi.fn<typeof fetch>();
      expect(yield* query(request)).toBeNull();
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect("clears the reading when the quota response is larger than 64 KiB", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fixture());
      const request = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => successIdentity())
        .mockImplementationOnce(
          async () =>
            new Response(JSON.stringify({ padding: "x".repeat(70 * 1024) }), {
              headers: { "content-type": "application/json" },
            }),
        );
      expect(yield* query(request)).toBeNull();
      expect(request).toHaveBeenCalledTimes(2);
    }),
  );
});
