import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as CursorKeychain from "./CursorKeychain.ts";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

const withNodeServices = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | CursorKeychain.CursorKeychain>,
  accessToken: CursorKeychain.CursorKeychain["Service"]["accessToken"] = Effect.die(
    "must not read Keychain",
  ),
) =>
  effect.pipe(
    Effect.provideService(CursorKeychain.CursorKeychain, { accessToken }),
    Effect.provide(NodeServices.layer),
  );

describe("Cursor usage limits", () => {
  it("retains a unified total for account aggregation", () => {
    const windows = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 1.77, autoPercentUsed: 1.77 } },
      checkedAt,
    ).windows;
    expect(windows.map((window) => window.id)).toEqual(["autoPercentUsed", "totalPercentUsed"]);
  });
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("reports the billing-cycle length so pace can be computed", () => {
    const planUsage = { totalPercentUsed: 40, autoPercentUsed: 30, apiPercentUsed: 20 };
    const durations = (billingCycleStart: string | number | undefined, billingCycleEnd: string) =>
      cursorUsageResponseToLimits(
        { billingCycleStart, billingCycleEnd, planUsage },
        checkedAt,
      ).windows.map((window) => window.windowDurationMins);
    expect(durations("1794045847072", "1796637847072")).toEqual([43_200, 43_200, 43_200]);
    expect(durations(1_796_637_847_072, "1799316247072")).toEqual([44_640, 44_640, 44_640]);
  });

  it("omits the cycle length when the start is missing or invalid", () => {
    for (const billingCycleStart of [undefined, "", "0", "not-a-number", "1796637847072"]) {
      expect(
        cursorUsageResponseToLimits(
          {
            billingCycleStart,
            billingCycleEnd: "1796637847072",
            planUsage: { totalPercentUsed: 40 },
          },
          checkedAt,
        ).windows,
      ).toEqual([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 40,
          resetsAt: "2026-12-07T10:04:07.072Z",
        },
      ]);
    }
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect("reads the instance's credentials and endpoint even when usage enabled is false", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        const client = HttpClient.make((request) => {
          expect(request.url).toBe(
            "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          );
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer instance-token");
          expect(request.headers["connect-protocol-version"]).toBe("1");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
            ),
          );
        });
        yield* fs.makeDirectory(path.join(directory, ".cursor"));
        yield* fs.writeFileString(
          path.join(directory, ".cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        for (const platform of ["linux", "darwin"] as const) {
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "https://cursor.example/" },
            { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
          ).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HttpClient.HttpClient, client),
          );
          expect(limits.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    ),
  );

  it.effect(
    "never reads stale files for keychain or memory logins, but accepts an explicit auth token",
    () =>
      Effect.gen(function* () {
        for (const platform of ["linux", "darwin"] as const) {
          for (const token of [undefined, "explicit-token"]) {
            const limits = yield* withNodeServices(
              readCursorUsageLimits(
                { apiEndpoint: "" },
                {
                  AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
                  ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
                },
                false,
              ).pipe(
                Effect.provideService(HostProcess.Platform, platform),
                Effect.provideService(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({
                    readFileString: () => Effect.die("must not read an unrelated credential file"),
                  }),
                ),
                Effect.provideService(
                  HttpClient.HttpClient,
                  HttpClient.make((request) => {
                    expect(token).toBe("explicit-token");
                    expect(request.headers.authorization).toBe("Bearer explicit-token");
                    return Effect.succeed(
                      HttpClientResponse.fromWeb(
                        request,
                        Response.json({ planUsage: { totalPercentUsed: 10 } }),
                      ),
                    );
                  }),
                ),
              ),
            );
            if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
            else expect(limits.unavailable?.reason).toBe("unsupported");
          }
        }
      }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("private response", { status: 401 }),
                ),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("reads an API key's own account instead of a stored login", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "darwin"] as const) {
        const requests: Array<readonly [string, string | undefined]> = [];
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "api-key" }, true).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                readFileString: () => Effect.die("must not read a stored login"),
              }),
            ),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push([request.url, request.headers.authorization]);
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json(
                      request.url.endsWith("/auth/exchange_user_api_key")
                        ? { accessToken: "api-key-access-token" }
                        : { planUsage: { totalPercentUsed: 37 } },
                    ),
                  ),
                );
              }),
            ),
          ),
        );
        expect(requests).toEqual([
          ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
          [
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
            "Bearer api-key-access-token",
          ],
        ]);
        expect(limits.windows[0]?.usedPercent).toBe(37);
      }
    }),
  );

  it.effect("reads the default macOS Cursor login from Keychain for limits", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => Effect.die("must not read a stale credential file"),
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(request.headers.authorization).toBe("Bearer keychain-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 42 } }),
                ),
              );
            }),
          ),
        ),
        Effect.succeed("keychain-token"),
      );
      expect(limits.windows[0]?.usedPercent).toBe(42);
    }),
  );

  it.effect("reports a Keychain initialization failure without failing the provider refresh", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits({ apiEndpoint: "" }, {}, true).pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request limits without a login")),
          ),
        ),
        Effect.fail(
          new CursorKeychain.CursorKeychainReadError({
            cause: new Error("Keychain initialization failed"),
          }),
        ),
      );
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("does not send a Keychain login or API key to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", {}],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000" }],
        ["https://cursor-proxy.example", {}],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example" }],
        ["https://cursor-proxy.example", { CURSOR_API_KEY: "api-key" }],
      ] as const) {
        const limits = yield* withNodeServices(
          readCursorUsageLimits({ apiEndpoint }, environment, true).pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not send a Keychain credential to a proxy")),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );

  it.effect("does not exchange an API key at Cursor's service for a private backend", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_API_KEY: "api-key", CURSOR_BACKEND_URL: "https://private.invalid" },
          true,
        ).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send a private backend's key to Cursor")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("default Cursor backend");
    }),
  );

  it.effect("does not send a private backend's access token to Cursor's usage endpoint", () =>
    Effect.gen(function* () {
      const limits = yield* withNodeServices(
        readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_AUTH_TOKEN: "private-token", CURSOR_BACKEND_URL: "https://private.invalid" },
          true,
        ).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send a private backend's token to Cursor")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("default Cursor backend");
    }),
  );

  it.effect("keeps a private backend's token from Cursor's endpoint however it is written", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["", { CURSOR_API_ENDPOINT: "https://api2.cursor.sh:443" }],
        ["", { CURSOR_API_ENDPOINT: "HTTPS://API2.CURSOR.SH" }],
        ["", { CURSOR_API_ENDPOINT: "https://api2.cursor.sh/" }],
        ["HTTPS://Api2.Cursor.sh:443/", {}],
      ] as const) {
        const limits = yield* withNodeServices(
          readCursorUsageLimits(
            { apiEndpoint },
            {
              ...environment,
              CURSOR_AUTH_TOKEN: "private-token",
              CURSOR_BACKEND_URL: "https://private.invalid",
            },
            true,
          ).pipe(
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() =>
                Effect.die("must not send a private backend's token to Cursor's usage endpoint"),
              ),
            ),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor backend");
      }
    }),
  );

  it.effect("treats Cursor's backend written with other letter case or :443 as Cursor's", () =>
    Effect.gen(function* () {
      const requested: Array<string> = [];
      yield* withNodeServices(
        readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_API_KEY: "api-key", CURSOR_BACKEND_URL: "HTTPS://API2.Cursor.sh:443/" },
          true,
        ).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requested.push(request.url);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    request.url.endsWith("/auth/exchange_user_api_key")
                      ? { accessToken: "api-key-access-token" }
                      : { planUsage: { totalPercentUsed: 37 } },
                  ),
                ),
              );
            }),
          ),
        ),
      );
      expect(requested).toContain("https://api2.cursor.sh/auth/exchange_user_api_key");
    }),
  );

  it.effect("does not send the server's CLI login to an instance's own usage endpoint", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          '{"accessToken":"server-login-token"}',
        );
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "https://usage.private.invalid" },
          { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
          true,
          false,
        ).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send the server's CLI login")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("CURSOR_AUTH_TOKEN");
      }).pipe(Effect.scoped),
    ),
  );
});
