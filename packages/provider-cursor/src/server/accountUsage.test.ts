import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as CursorKeychain from "./CursorKeychain.ts";
import { readCursorAccountUsage } from "./accountUsage.ts";

const writeAuth = (accessToken: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "usage-reader-test-" });
    const authPath = path.join(dir, "auth.json");
    yield* fileSystem.writeFileString(authPath, JSON.stringify({ accessToken }));
    return { dir, authPath };
  });

interface DashboardRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly page: number;
  readonly headers: Headers;
}

type Answer = (request: DashboardRequest) => Response | Promise<Response>;

interface MembershipOptions {
  /** Answers GetMe and GetTeams before `answer` sees the usage pages. */
  readonly membership?: { readonly userId: number; readonly teamIds: readonly number[] } | Answer;
  /** Sees every request, membership included. */
  readonly seen?: (request: DashboardRequest) => void;
}

const dashboard = (
  answer: Answer,
  { membership = { userId: 1, teamIds: [] }, seen }: MembershipOptions = {},
) =>
  HttpClient.make((request, url, signal, fiber) =>
    Effect.tryPromise({
      try: async () => {
        const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        const dashboardRequest = {
          url: url.toString(),
          init: { ...init, signal, body },
          page: body === "" ? Number.NaN : JSON.parse(body).page,
          headers: new Headers(request.headers),
        };
        seen?.(dashboardRequest);
        const isMembership = /\/(GetMe|GetTeams)$/.test(url.pathname);
        const response = !isMembership
          ? await answer(dashboardRequest)
          : typeof membership === "function"
            ? await membership(dashboardRequest)
            : url.pathname.endsWith("/GetMe")
              ? Response.json({ userId: membership.userId })
              : Response.json({ teams: membership.teamIds.map((id) => ({ id })) });
        return HttpClientResponse.fromWeb(request, response);
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }),
  );

const readAccountUsage = (
  credentialSource: Parameters<typeof readCursorAccountUsage>[0],
  sinceMs: number,
  endDate: number,
  answer: Answer,
  keychainToken?: Parameters<typeof readCursorAccountUsage>[3],
  options?: MembershipOptions,
) =>
  readCursorAccountUsage(credentialSource, sinceMs, endDate, keychainToken).pipe(
    Effect.provideService(HttpClient.HttpClient, dashboard(answer, options)),
  );

describe("Cursor account history", () => {
  it.effect(
    "reads paginated Cursor account history including headless calls with separate cache tokens",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
        const { authPath } = yield* writeAuth(accessToken);
        const pages: number[] = [];
        const signals: AbortSignal[] = [];
        const request = ({ url, init, headers, page }: DashboardRequest) => {
          assert.strictEqual(
            url,
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents",
          );
          assert.strictEqual(init.redirect, "error");
          assert.strictEqual(headers.get("connect-protocol-version"), "1");
          assert.strictEqual(headers.get("content-type"), "application/json");
          assert.strictEqual(headers.get("authorization"), `Bearer ${accessToken}`);
          const body = { page };
          pages.push(body.page);
          if (init.signal) signals.push(init.signal);
          return Response.json({
            totalUsageEventsCount: 1001,
            usageEventsDisplay: Array.from({ length: body.page === 1 ? 1000 : 1 }, (_, index) => ({
              timestamp: String(1780000000000 + ((body.page - 1) * 1000 + index) * 1000),
              model: "claude-sonnet-4-5",
              conversationId: `conversation-${body.page}`,
              isHeadless: body.page === 2,
              chargedCents: 0,
              tokenUsage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 30,
                cacheWriteTokens: 2,
                totalCents: 25,
              },
            })),
          });
        };
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, request);
        assert.isNull(result.error);
        assert.deepStrictEqual(pages, [1, 2]);
        assert.lengthOf(signals, 2);
        assert.notStrictEqual(signals[0], signals[1]);
        assert.strictEqual(result.records.length, 1001);
        assert.strictEqual(result.records.at(-1)?.sessionId, "conversation-2");
        assert.deepStrictEqual(result.records[0]?.totals, {
          uncachedInputTokens: 10,
          cachedInputTokens: 30,
          cacheCreationTokens: 2,
          outputTokens: 5,
          reasoningTokens: 0,
        });
        assert.strictEqual(result.records[0]?.reportedCostUsd, 0.25);
        assert.strictEqual(
          result.records[0]?.dedupeKey,
          "cursor-account:2188c26da759c4fae3aa0252fc6d725eff0922ef0b022551e6f0987d02bfab33:3149aaf8419ad6b66ef7330853d8fe85e6f2e9876e2ad5e85f88bee8c8d6d133:0",
        );
        assert.isFalse(result.accountKey?.includes("demo") ?? true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads Cursor account history beyond 100 pages", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      const fullPage = Array.from({ length: 1000 }, () => ({ tokenUsage: null }));
      let requests = 0;
      const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
        requests += 1;
        return Response.json({
          totalUsageEventsCount: 100_001,
          usageEventsDisplay: requests <= 100 ? fullPage : [{ tokenUsage: null }],
        });
      });
      assert.isNull(result.error);
      assert.strictEqual(requests, 101);
      assert.deepStrictEqual(result.records, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts confirmed empty Cursor usage but rejects error envelopes", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      for (const body of [
        {},
        { totalUsageEventsCount: 0 },
        { totalUsageEventsCount: 0, usageEventsDisplay: [] },
      ]) {
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
          Response.json(body),
        );
        assert.isNull(result.error);
        assert.deepStrictEqual(result.records, []);
        assert.isFalse(result.missing);
      }
      for (const body of [
        { error: "upstream error" },
        { detail: "unknown error envelope" },
        { totalUsageEventsCount: 0, error: "upstream error" },
        null,
        [],
        "invalid",
        0,
      ]) {
        const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
          Response.json(body),
        );
        assert.isNotNull(result.error);
        assert.deepStrictEqual(result.records, []);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires a terminal Cursor page after a full page reaches the reported count", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const { authPath } = yield* writeAuth(accessToken);
      let requests = 0;
      const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
        requests++;
        return Response.json(
          requests === 1
            ? {
                totalUsageEventsCount: 1000,
                usageEventsDisplay: Array.from({ length: 1000 }, (_, index) => ({
                  timestamp: String(1780000000000 + index),
                  model: "gpt-5",
                  tokenUsage: { inputTokens: 10, outputTokens: 5 },
                })),
              }
            : { totalUsageEventsCount: 1000 },
        );
      });
      assert.isNull(result.error);
      assert.strictEqual(result.records.length, 1000);
      assert.strictEqual(requests, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "removes only count-proven Cursor boundary copies and preserves identical billed events",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
        const { authPath } = yield* writeAuth(accessToken);
        const event = (index: number) => ({
          timestamp: String(1780000000000 + index),
          model: "gpt-5",
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
        });
        for (const total of [2000, 2001, undefined]) {
          const expectedCount = total ?? 2001;
          let requests = 0;
          const result = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
            requests++;
            return Response.json({
              totalUsageEventsCount: total,
              usageEventsDisplay:
                requests === 1
                  ? Array.from({ length: 1000 }, (_, index) => event(index))
                  : requests === 2
                    ? Array.from({ length: 1000 }, (_, index) => {
                        const row = event(999 + index);
                        return {
                          tokenUsage: {
                            totalCents: row.tokenUsage.totalCents,
                            outputTokens: row.tokenUsage.outputTokens,
                            inputTokens: row.tokenUsage.inputTokens,
                          },
                          model: row.model,
                          timestamp: row.timestamp,
                        };
                      })
                    : [event(1999)],
            });
          });
          assert.isNull(result.error);
          assert.strictEqual(result.records.length, expectedCount);
          assert.strictEqual(requests, 3);
          assert.strictEqual(result.records.at(-1)?.timestampMs, 1780000001999);
          assert.strictEqual(
            result.records.filter((record) => record.timestampMs === 1780000000999).length,
            total === 2000 ? 1 : 2,
          );
          assert.strictEqual(
            new Set(result.records.map((record) => record.dedupeKey)).size,
            expectedCount,
          );
        }
        let requests = 0;
        const inconsistent = yield* readAccountUsage(authPath, 0, 1781000000000, async () => {
          requests++;
          return Response.json({
            totalUsageEventsCount: 1001,
            usageEventsDisplay:
              requests === 1
                ? Array.from({ length: 1000 }, (_, index) => event(index))
                : [event(500), event(1000)],
          });
        });
        assert.isNotNull(inconsistent.error);
        assert.deepStrictEqual(inconsistent.records, []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not present truncated Cursor account pages or authentication failures as complete history",
    () =>
      Effect.gen(function* () {
        const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", exp: 4102444800 })).toString("base64url")}.signature`;
        const { dir, authPath } = yield* writeAuth(accessToken);
        const truncated = yield* readAccountUsage(authPath, 0, 1781000000000, async () =>
          Response.json({ totalUsageEventsCount: 101, usageEventsDisplay: [] }),
        );
        assert.isNotNull(truncated.error);
        assert.deepStrictEqual(truncated.records, []);
        const denied = yield* readAccountUsage(
          authPath,
          0,
          1781000000000,
          async () => new Response(accessToken, { status: 401 }),
        );
        assert.isNotNull(denied.error);
        assert.isFalse(denied.error?.includes(accessToken) ?? true);
        assert.deepStrictEqual(denied.records, []);
        let requested = false;
        const missing = yield* readAccountUsage(
          (yield* Path.Path).join(dir, "missing.json"),
          0,
          1781000000000,
          async () => {
            requested = true;
            return Response.json({});
          },
        );
        assert.isTrue(missing.missing);
        assert.isFalse(requested);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("readCursorAccountUsage", () => {
  it.effect("reads an API key's account history through Cursor's API", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const requests: Array<readonly [string, string | null]> = [];
      const result = yield* readAccountUsage(
        { kind: "apiKey", apiKey: "api-key" },
        0,
        1781000000000,
        ({ url, headers }) => {
          requests.push([url, headers.get("authorization")]);
          return url.endsWith("/auth/exchange_user_api_key")
            ? Response.json({ accessToken })
            : Response.json({
                totalUsageEventsCount: 1,
                usageEventsDisplay: [
                  { timestamp: "1780000000000", model: "gpt-5", tokenUsage: { outputTokens: 4 } },
                ],
              });
        },
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(requests, [
        ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetFilteredUsageEvents",
          `Bearer ${accessToken}`,
        ],
      ]);
      assert.strictEqual(result.records[0]?.totals.outputTokens, 4);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops waiting for an API key exchange that never answers", () =>
    Effect.gen(function* () {
      const read = yield* Effect.forkChild(
        readAccountUsage(
          { kind: "apiKey", apiKey: "api-key" },
          0,
          1781000000000,
          () => new Promise<Response>(() => {}),
        ),
      );
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(read);
      assert.strictEqual(result.error, "Cursor account usage could not be read.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks for Keychain approval when the prompt goes unanswered", () =>
    Effect.gen(function* () {
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1,
        () => {
          throw new Error("no network expected");
        },
        Effect.fail(new CursorKeychain.CursorKeychainTimeoutError()),
      );
      assert.deepStrictEqual(result, {
        accountKey: null,
        records: [],
        missing: false,
        error: "Allow Keychain access on the Mac running GOAT, then refresh.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the pages behind the first together and keeps them in page order", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      let inFlight = 0;
      let mostInFlight = 0;
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        async ({ page }) => {
          inFlight++;
          mostInFlight = Math.max(mostInFlight, inFlight);
          for (let turn = page; turn < 9; turn++) await Promise.resolve();
          inFlight--;
          return Response.json({
            totalUsageEventsCount: 8001,
            usageEventsDisplay: Array.from({ length: page === 9 ? 1 : 1000 }, (_, index) => ({
              timestamp: String(1780000000000 + (page - 1) * 1000 + index),
              model: "gpt-5",
              tokenUsage: { inputTokens: 1 },
            })),
          });
        },
        Effect.succeed(accessToken),
      );
      assert.isNull(result.error);
      assert.strictEqual(mostInFlight, 6);
      assert.deepStrictEqual(
        result.records.map((record) => record.timestampMs),
        Array.from({ length: 8001 }, (_, index) => 1780000000000 + index),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ends like a page-by-page read when a page fails, leaving no request open", () =>
    Effect.gen(function* () {
      const accessToken = `header.${Buffer.from(JSON.stringify({ sub: "auth|demo" })).toString("base64url")}.signature`;
      const fullPage = {
        totalUsageEventsCount: 8001,
        usageEventsDisplay: Array.from({ length: 1000 }, () => ({ tokenUsage: null })),
      };
      for (const [secondPage, error] of [
        [() => Response.json(fullPage), "Cursor account usage could not be read."],
        [
          () => new Response(null, { status: 401 }),
          "Sign in to Cursor again to read account usage.",
        ],
      ] as const) {
        let open = 0;
        const result = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          ({ init, page }) => {
            if (page === 1) return Promise.resolve(Response.json(fullPage));
            if (page === 2) return Promise.resolve(secondPage());
            if (page === 3) return Promise.reject(new Error("connection reset"));
            open++;
            return new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                open--;
                reject(init.signal?.reason);
              });
            });
          },
          Effect.succeed(accessToken),
        );
        assert.strictEqual(result.error, error);
        assert.deepStrictEqual(result.records, []);
        assert.strictEqual(open, 0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const API2 = "https://api2.cursor.sh";
const token = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify({ sub: "auth|demo", ...claims })).toString("base64url")}.signature`;
const usageMethod = (url: string) => new URL(url).pathname.split("/").at(-1);
const twoPages = ({ page }: DashboardRequest) =>
  Response.json({
    totalUsageEventsCount: 1001,
    usageEventsDisplay: Array.from({ length: page === 1 ? 1000 : 1 }, (_, index) => ({
      timestamp: String(1780000000000 + (page - 1) * 1000 + index),
      model: "gpt-5",
      tokenUsage: { inputTokens: 1 },
    })),
  });
const hang = ({ init }: DashboardRequest, open: { count: number }) => {
  open.count++;
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      open.count--;
      reject(init.signal?.reason);
    });
  });
};

describe("Cursor account history through Cursor's API (O23)", () => {
  it.effect(
    "sends every request of a team account read to api2 with the token only as a bearer and redirects refused",
    () =>
      Effect.gen(function* () {
        const accessToken = token({ exp: 4102444800 });
        const { authPath } = yield* writeAuth(accessToken);
        for (const [credential, keychainToken] of [
          [authPath, undefined],
          [{ kind: "keychain" } as const, Effect.succeed(accessToken)],
        ] as const) {
          const requests: DashboardRequest[] = [];
          const result = yield* readAccountUsage(
            credential,
            0,
            1781000000000,
            twoPages,
            keychainToken,
            {
              membership: { userId: 42, teamIds: [7, 8] },
              seen: (request) => requests.push(request),
            },
          );
          assert.isNull(result.error);
          assert.strictEqual(result.records.length, 3 * 1001);
          // 1 GetMe + 1 GetTeams + pages x (personal + 2 teams).
          assert.strictEqual(requests.length, 1 + 1 + 2 * 3);
          assert.deepStrictEqual(requests.map(({ url }) => usageMethod(url)).sort(), [
            "GetFilteredUsageEvents",
            "GetFilteredUsageEvents",
            "GetFilteredUsageEvents",
            "GetFilteredUsageEvents",
            "GetFilteredUsageEvents",
            "GetFilteredUsageEvents",
            "GetMe",
            "GetTeams",
          ]);
          for (const { url, init, headers } of requests) {
            assert.strictEqual(new URL(url).origin, API2);
            assert.isTrue(url.startsWith(`${API2}/aiserver.v1.DashboardService/`));
            assert.notInclude(url, accessToken);
            assert.strictEqual(init.redirect, "error");
            assert.strictEqual(headers.get("authorization"), `Bearer ${accessToken}`);
            assert.isNull(headers.get("cookie"));
            assert.notInclude(String(init.body), accessToken);
            for (const [name, value] of headers) {
              if (name !== "authorization") assert.notInclude(value, accessToken);
            }
          }
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("includes each team's own-user history alongside personal history", () =>
    Effect.gen(function* () {
      const scopes: unknown[] = [];
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        async ({ init }) => {
          const body = JSON.parse(String(init.body));
          scopes.push([body.teamId, body.userId]);
          const team = body.teamId !== undefined;
          return Response.json({
            totalUsageEventsCount: 1,
            usageEventsDisplay: [
              {
                timestamp: "1780000000000",
                model: "gpt-5",
                conversationId: "same-conversation",
                tokenUsage: { cacheReadTokens: team ? 5_000_000 : 10 },
              },
            ],
          });
        },
        Effect.succeed(token({})),
        { membership: { userId: 42, teamIds: [7, 8, 7] } },
      );
      assert.isNull(result.error);
      assert.deepStrictEqual(scopes, [
        [undefined, undefined],
        [7, 42],
        [8, 42],
      ]);
      assert.strictEqual(
        result.records.reduce((sum, row) => sum + row.totals.cachedInputTokens, 0),
        10_000_010,
      );
      assert.strictEqual(new Set(result.records.map((row) => row.dedupeKey)).size, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects unscoped or incomplete team history without keeping personal totals", () =>
    Effect.gen(function* () {
      for (const userId of [0, 42]) {
        const scopes: unknown[] = [];
        const result = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          async ({ init }) => {
            const body = JSON.parse(String(init.body));
            scopes.push(body.teamId);
            return body.teamId === undefined
              ? Response.json({
                  totalUsageEventsCount: 1,
                  usageEventsDisplay: [
                    { timestamp: "1780000000000", model: "gpt-5", tokenUsage: { inputTokens: 10 } },
                  ],
                })
              : new Response(null, { status: 403 });
          },
          Effect.succeed(token({})),
          { membership: { userId, teamIds: [7] } },
        );
        assert.isNotNull(result.error);
        assert.deepStrictEqual(result.records, []);
        assert.deepStrictEqual(scopes, userId === 0 ? [] : [undefined, 7]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails the whole read, as upstream does, when GetTeams or GetMe is refused or broken",
    () =>
      Effect.gen(function* () {
        const broken: ReadonlyArray<readonly [string, () => Response | Promise<Response>]> = [
          ["GetTeams", () => new Response(null, { status: 403 })],
          ["GetTeams", () => new Response(null, { status: 500 })],
          ["GetTeams", () => Promise.reject(new Error("connection reset"))],
          ["GetTeams", () => Response.json({ code: "unauthenticated", message: "no" })],
          ["GetTeams", () => Response.json({ teams: [{ id: "seven" }] })],
          ["GetTeams", () => Response.json({ teams: [{ id: -7 }] })],
          ["GetMe", () => new Response(null, { status: 401 })],
          ["GetMe", () => Response.json({})],
        ];
        for (const [method, answer] of broken) {
          let pages = 0;
          const result = yield* readAccountUsage(
            { kind: "keychain" },
            0,
            1781000000000,
            (request) => {
              pages++;
              return twoPages(request);
            },
            Effect.succeed(token({})),
            {
              membership: ({ url }) =>
                usageMethod(url) === method
                  ? answer()
                  : usageMethod(url) === "GetMe"
                    ? Response.json({ userId: 42 })
                    : Response.json({ teams: [{ id: 7 }] }),
            },
          );
          assert.deepStrictEqual(result, {
            accountKey: result.accountKey,
            records: [],
            missing: false,
            error: "Cursor account usage could not be read.",
          });
          assert.strictEqual(pages, 0);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads only personal history for an account with no teams", () =>
    Effect.gen(function* () {
      for (const teams of [{}, { teams: [] }]) {
        const requests: string[] = [];
        const result = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          (request) => {
            assert.isUndefined(JSON.parse(String(request.init.body)).teamId);
            return twoPages(request);
          },
          Effect.succeed(token({})),
          {
            membership: ({ url }) =>
              usageMethod(url) === "GetMe" ? Response.json({ userId: 42 }) : Response.json(teams),
            seen: ({ url }) => requests.push(usageMethod(url) ?? ""),
          },
        );
        assert.isNull(result.error);
        assert.strictEqual(result.records.length, 1001);
        assert.strictEqual(requests.length, 1 + 1 + 2);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a rejected login without changing the stored Cursor login", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accessToken = token({ exp: 4102444800 });
      const { authPath } = yield* writeAuth(accessToken);
      const stored = yield* fileSystem.readFileString(authPath);
      for (const [membership, error] of [
        [undefined, "Sign in to Cursor again to read account usage."],
        [
          (() => new Response(null, { status: 401 })) satisfies Answer,
          "Cursor account usage could not be read.",
        ],
      ] as const) {
        const result = yield* readAccountUsage(
          authPath,
          0,
          1781000000000,
          () => new Response(null, { status: 401 }),
          undefined,
          membership === undefined ? {} : { membership },
        );
        assert.strictEqual(result.error, error);
        assert.deepStrictEqual(result.records, []);
        assert.isFalse(result.missing);
        assert.strictEqual(yield* fileSystem.readFileString(authPath), stored);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends nothing for a missing or expired login", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("2000 seconds");
      const expired = token({ exp: 1000 });
      const { authPath } = yield* writeAuth(expired);
      let requested = 0;
      const answer = () => {
        requested++;
        return Response.json({});
      };
      const options = { seen: () => requested++ };
      const missing = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        answer,
        Effect.succeed(null),
        options,
      );
      assert.isTrue(missing.missing);
      for (const result of [
        yield* readAccountUsage(authPath, 0, 1781000000000, answer, undefined, options),
        yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          answer,
          Effect.succeed(expired),
          options,
        ),
      ]) {
        assert.deepStrictEqual(result.records, []);
        assert.strictEqual(result.error, "Sign in to Cursor again to read account usage.");
      }
      assert.strictEqual(requested, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("times out and aborts a membership or team request that never answers", () =>
    Effect.gen(function* () {
      for (const stuck of ["GetTeams", "team page"] as const) {
        const open = { count: 0 };
        let started!: () => void;
        const hanging = new Promise<void>((resolve) => (started = resolve));
        const read = yield* Effect.forkChild(
          readAccountUsage(
            { kind: "keychain" },
            0,
            1781000000000,
            (request) => {
              if (stuck === "team page" && JSON.parse(String(request.init.body)).teamId === 7) {
                started();
                return hang(request, open);
              }
              return twoPages(request);
            },
            Effect.succeed(token({})),
            {
              membership: (request) => {
                if (usageMethod(request.url) === "GetMe") return Response.json({ userId: 42 });
                if (stuck !== "GetTeams") return Response.json({ teams: [{ id: 7 }] });
                started();
                return hang(request, open);
              },
            },
          ),
        );
        yield* Effect.promise(() => hanging);
        assert.strictEqual(open.count, 1);
        yield* TestClock.adjust("10 seconds");
        const result = yield* Fiber.join(read);
        assert.strictEqual(result.error, "Cursor account usage could not be read.");
        assert.deepStrictEqual(result.records, []);
        assert.strictEqual(open.count, 0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses more than 100 teams before reading any page", () =>
    Effect.gen(function* () {
      let pages = 0;
      const result = yield* readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        (request) => {
          pages++;
          return twoPages(request);
        },
        Effect.succeed(token({})),
        { membership: { userId: 42, teamIds: Array.from({ length: 101 }, (_, i) => i + 1) } },
      );
      assert.strictEqual(result.error, "Cursor account usage could not be read.");
      assert.strictEqual(pages, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the token and response bodies out of spans, logs and errors", () =>
    Effect.gen(function* () {
      const accessToken = token({ exp: 4102444800 });
      const secret = "BODY-SECRET-1234";
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const logs: unknown[] = [];
      const logger = Logger.make(({ message, cause }) => logs.push(message, Cause.pretty(cause)));
      const errors: Array<string | null> = [];
      const scenarios: ReadonlyArray<readonly [Answer, MembershipOptions["membership"]]> = [
        [twoPages, { userId: 42, teamIds: [7] }],
        [() => new Response(`${secret} ${accessToken}`, { status: 401 }), undefined],
        [() => Response.json({ error: secret, message: accessToken }), undefined],
        [() => Response.json({ totalUsageEventsCount: secret }), undefined],
        [twoPages, () => Response.json({ teams: [{ id: secret }], message: accessToken })],
        // No message key, so the teams decoder sees the value.
        [twoPages, () => Response.json({ teams: [{ id: secret }] })],
        [twoPages, () => new Response(secret, { status: 500 })],
      ];
      for (const [answer, membership] of scenarios) {
        const result = yield* readAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          answer,
          Effect.succeed(accessToken),
          membership === undefined ? {} : { membership },
        ).pipe(
          Effect.withTracer(tracer),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        errors.push(result.error);
      }
      assert.deepStrictEqual(errors, [
        null,
        "Sign in to Cursor again to read account usage.",
        "Cursor account usage could not be read.",
        "Cursor account usage could not be read.",
        "Cursor account usage could not be read.",
        "Cursor account usage could not be read.",
        "Cursor account usage could not be read.",
      ]);
      assert.isAbove(spans.length, 0);
      const traced = JSON.stringify(
        spans.map((span) => [
          span.name,
          [...span.attributes],
          span.events,
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.pretty(span.status.exit.cause)
            : null,
        ]),
        (_key, value) => (typeof value === "bigint" ? String(value) : value),
      );
      for (const leaked of [accessToken, accessToken.split(".")[1]!, secret]) {
        assert.notInclude(traced, leaked);
        assert.notInclude(JSON.stringify(logs), leaked);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts personal and team reads together without waiting for either response", () =>
    Effect.gen(function* () {
      const personal = yield* Deferred.make<void>();
      const team = yield* Deferred.make<void>();
      const client = dashboard(() => Response.json({}), {
        membership: { userId: 42, teamIds: [7] },
      }).pipe(
        HttpClient.transform((response, request) => {
          if (!request.url.endsWith("/GetFilteredUsageEvents")) return response;
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {};
          const isPersonal = body.teamId === undefined;
          return Effect.gen(function* () {
            yield* Deferred.succeed(isPersonal ? personal : team, undefined);
            yield* Deferred.await(isPersonal ? team : personal);
            return yield* response;
          });
        }),
      );
      const result = yield* readCursorAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        Effect.succeed(token({})),
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      assert.isNull(result.error);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads concurrent pages in order with a full request deadline after queuing", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>();
      const firstBatch = yield* Deferred.make<void>();
      const secondBatch = yield* Deferred.make<void>();
      let delayedRequests = 0;
      let inFlight = 0;
      let mostInFlight = 0;
      const client = dashboard(
        async ({ page }) => {
          inFlight++;
          mostInFlight = Math.max(mostInFlight, inFlight);
          for (let turn = page; turn < 9; turn++) await Promise.resolve();
          inFlight--;
          return Response.json({
            totalUsageEventsCount: 8001,
            usageEventsDisplay: Array.from({ length: page === 9 ? 1 : 1000 }, (_, index) => ({
              timestamp: String(1780000000000 + (page - 1) * 1000 + index),
              model: "gpt-5",
              tokenUsage: { inputTokens: 1 },
            })),
          });
        },
        { membership: { userId: 42, teamIds: [7] } },
      ).pipe(
        HttpClient.transform((response, request) => {
          if (!request.url.endsWith("/GetFilteredUsageEvents")) return response;
          const body =
            request.body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : {};
          if (body.page === 1) return response;
          return Effect.gen(function* () {
            const batch = delayedRequests++ < 6 ? firstBatch : secondBatch;
            yield* Queue.offer(started, undefined);
            yield* Deferred.await(batch);
            return yield* response;
          });
        }),
      );
      const read = yield* Effect.forkChild(
        readCursorAccountUsage(
          { kind: "keychain" },
          0,
          1781000000000,
          Effect.succeed(token({})),
        ).pipe(Effect.provideService(HttpClient.HttpClient, client)),
      );
      yield* Effect.all(Array.from({ length: 6 }, () => Queue.take(started)));
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.succeed(firstBatch, undefined);
      yield* Effect.all(Array.from({ length: 6 }, () => Queue.take(started)));
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.succeed(secondBatch, undefined);
      const result = yield* Fiber.join(read);
      assert.isNull(result.error);
      assert.strictEqual(mostInFlight, 6);
      assert.deepStrictEqual(
        result.records.map((record) => record.timestampMs),
        Array.from({ length: 16002 }, (_, index) => 1780000000000 + (index % 8001)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
