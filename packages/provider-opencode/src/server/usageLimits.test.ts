import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readOpenCodeGoUsageLimits } from "./usageLimits.ts";
it.effect("reads Go limits with the instance's XDG credentials and preserves reset times", () =>
  Effect.gen(function* () {
    const resetsAt = "2026-09-17T12:00:00.000Z";
    const limits = yield* readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: "",
      environment: { XDG_DATA_HOME: "/instance/data", OPENCODE_API_KEY: "env-key" },
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: (path) => {
            NodeAssert.equal(path, "/instance/data/opencode/auth.json");
            return Effect.succeed(
              JSON.stringify({ "opencode-go": { type: "api", key: "instance-key" } }),
            );
          },
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
          NodeAssert.equal(request.headers.authorization, "Bearer instance-key");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usage: {
                  rolling: { percent: 0, resetsAt },
                  weekly: { percent: 10, resetsAt },
                  monthly: { percent: 125, resetsAt },
                },
              }),
            ),
          );
        }),
      ),
      Effect.provide(NodeServices.layer),
    );
    NodeAssert.equal(limits.unavailable, undefined);
    NodeAssert.equal(
      limits.credentialFingerprint,
      "aba48e85c981a8edc1c9fb4575121accc7235fa55d0f8689f66f153de5566a37",
    );
    NodeAssert.deepEqual(
      limits.windows.map(({ kind, usedPercent, resetsAt: reset }) => ({
        kind,
        usedPercent,
        reset,
      })),
      [
        { kind: "session", usedPercent: 0, reset: resetsAt },
        { kind: "weekly", usedPercent: 10, reset: resetsAt },
        { kind: "monthly", usedPercent: 100, reset: resetsAt },
      ],
    );
  }),
);
it.effect(
  "uses the selected public Console key for Go limits, falling back only on auth rejection",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataHome = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${dataHome}/opencode`);
      yield* fs.writeFileString(
        `${dataHome}/opencode/auth.json`,
        JSON.stringify({ "opencode-go": { type: "api", key: "go-key" } }),
      );
      const database = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(`${dataHome}/opencode/opencode.db`)),
        (database) => Effect.sync(() => database.close()),
      );
      database.exec(
        "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text, active integer, time_created integer, time_updated integer)",
      );
      const insert = database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)");
      const window = { percent: 1, resetsAt: "2026-09-17T12:00:00.000Z" };
      const consoleKey = { type: "key", key: "console-key" };
      const fingerprints = new Map([
        ["console-key", "3e45cfde9158185930d4cc7020a4e390895574fd54bd8f9631d23a336bbf94f0"],
        ["go-key", "d0e590e93fc9bd9353f2b993c0c287391cae505da2a78cb698b75418d2f5367e"],
        ["inline-key", "85649de18e63305548b6407e185f708483727ee6189cc4bc9512ddb17e23e776"],
      ]);
      for (const {
        consoleRow = consoleKey,
        active = 1,
        consoleStatus = 200,
        inline = false,
        databaseFile,
        requested,
      } of [
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://opencode.ai/console" } },
          requested: ["console-key"],
        },
        { consoleStatus: 401, requested: ["console-key", "go-key"] },
        { consoleStatus: 403, requested: ["console-key", "go-key"] },
        { consoleStatus: 500, requested: ["console-key"] },
        { active: 0, requested: ["go-key"] },
        {
          consoleRow: {
            type: "oauth",
            methodID: "device",
            access: "token",
            refresh: "refresh",
            expires: 0,
          },
          requested: ["go-key"],
        },
        {
          consoleRow: { ...consoleKey, metadata: { server: "https://console.example" } },
          requested: ["go-key"],
        },
        { inline: true, requested: ["inline-key"] },
        { databaseFile: "selected.db", requested: ["console-key"] },
        { databaseFile: ":memory:", requested: ["go-key"] },
        { active: null, requested: ["console-key"] },
      ]) {
        database.exec("DELETE FROM credential");
        insert.run("cred_selected", "opencode", JSON.stringify(consoleRow), active, 2, 2);
        // Legacy selections follow creation order, even when an older key was updated later.
        insert.run(
          "cred_older",
          "opencode",
          JSON.stringify({ type: "key", key: "old-key" }),
          active === null ? null : 0,
          1,
          9,
        );
        insert.run("cred_other", "other", JSON.stringify(consoleKey), 1, 10, 10);
        if (databaseFile === "selected.db") {
          yield* fs.writeFile(
            `${dataHome}/opencode/selected.db`,
            yield* fs.readFile(`${dataHome}/opencode/opencode.db`),
          );
          database
            .prepare("UPDATE credential SET value = ? WHERE id = 'cred_selected'")
            .run(JSON.stringify({ type: "key", key: "old-key" }));
        }
        const before = yield* fs.readFile(`${dataHome}/opencode/opencode.db`);
        const authorizations: string[] = [];
        const limits = yield* readOpenCodeGoUsageLimits({
          enabled: true,
          serverUrl: "",
          environment: {
            XDG_DATA_HOME: dataHome,
            ...(databaseFile !== undefined ? { OPENCODE_DB: databaseFile } : {}),
            ...(inline
              ? { OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}' }
              : {}),
          },
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              NodeAssert.equal(request.url, "https://opencode.ai/zen/go/v1/usage");
              const key = (request.headers.authorization ?? "").replace("Bearer ", "");
              authorizations.push(key);
              // The legacy key is expired in the regression; it only works in fallback scenarios.
              const status =
                key === "console-key" ? consoleStatus : requested.includes(key) ? 200 : 401;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    { usage: { rolling: window, weekly: window, monthly: window } },
                    { status },
                  ),
                ),
              );
            }),
          ),
        );
        NodeAssert.deepEqual(authorizations, requested);
        NodeAssert.deepEqual(yield* fs.readFile(`${dataHome}/opencode/opencode.db`), before);
        NodeAssert.equal(
          limits.unavailable?.reason,
          consoleStatus === 500 ? "probeFailed" : undefined,
        );
        NodeAssert.equal(limits.windows.length, consoleStatus === 500 ? 0 : 3);
        NodeAssert.equal(
          limits.credentialFingerprint,
          consoleStatus === 500 ? undefined : fingerprints.get(requested.at(-1)!),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("prefers the selected stored Go key over the auth.json key OpenCode 2 imported", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataHome = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${dataHome}/opencode`);
    yield* fs.writeFileString(
      `${dataHome}/opencode/auth.json`,
      JSON.stringify({ "opencode-go": { type: "api", key: "imported-key" } }),
    );
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(`${dataHome}/opencode/opencode.db`)),
      (database) => Effect.sync(() => database.close()),
    );
    database.exec(
      "CREATE TABLE credential (id text PRIMARY KEY, integration_id text, value text, active integer, time_created integer, time_updated integer)",
    );
    const insert = database.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?, ?)");
    insert.run(
      "cred_imported",
      "opencode-go",
      JSON.stringify({ type: "key", key: "imported-key" }),
      0,
      1,
      2,
    );
    insert.run(
      "cred_replaced",
      "opencode-go",
      JSON.stringify({ type: "key", key: "replaced-key" }),
      1,
      2,
      2,
    );
    const window = { percent: 1, resetsAt: "2026-09-17T12:00:00.000Z" };
    for (const { replacedStatus, requested } of [
      { replacedStatus: 200, requested: ["replaced-key"] },
      { replacedStatus: 401, requested: ["replaced-key", "imported-key"] },
    ]) {
      const authorizations: string[] = [];
      const limits = yield* readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: { XDG_DATA_HOME: dataHome },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const key = (request.headers.authorization ?? "").replace("Bearer ", "");
            authorizations.push(key);
            const status = key === "replaced-key" ? replacedStatus : 200;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  { usage: { rolling: window, weekly: window, monthly: window } },
                  { status },
                ),
              ),
            );
          }),
        ),
      );
      NodeAssert.deepEqual(authorizations, requested);
      NodeAssert.equal(limits.unavailable, undefined);
      NodeAssert.equal(limits.windows.length, 3);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect("does not read local credentials for external or disabled OpenCode instances", () =>
  Effect.gen(function* () {
    for (const settings of [
      { enabled: true, serverUrl: "https://remote.example" },
      { enabled: false, serverUrl: "" },
    ]) {
      const limits = yield* readOpenCodeGoUsageLimits({ ...settings, environment: {} }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unexpected credential read"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unexpected usage request")),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, "unsupported");
    }
  }),
);
it.effect("keeps Go entitlement absence distinct from failed or malformed usage responses", () =>
  Effect.gen(function* () {
    for (const [status, reason] of [
      [403, "unsupported"],
      [401, "probeFailed"],
      [200, "probeFailed"],
    ] as const) {
      const limits = yield* readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "",
        environment: {
          OPENCODE_AUTH_CONTENT: '{"opencode-go":{"type":"api","key":"inline-key"}}',
        },
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("inline credentials must bypass disk"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status }))),
          ),
        ),
        Effect.provide(NodeServices.layer),
      );
      NodeAssert.equal(limits.unavailable?.reason, reason);
      NodeAssert.equal(limits.credentialFingerprint, undefined);
      NodeAssert.deepEqual(limits.windows, []);
    }
  }),
);
