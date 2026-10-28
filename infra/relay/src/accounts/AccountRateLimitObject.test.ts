import { HOURLY_OPERATIONS, DEFAULT_LIMITS } from "./AccountLimits.ts";
// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy's test provider owns the local Worker lifecycle and exposes its framework error union.
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import { resolveDev } from "alchemy/Test/Core";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Fixture from "./test/PolicyWorkerFixture.ts";

if (!resolveDev({ dev: true }))
  throw new Error("wp3 Worker tests require local provider mode; cloud fallback is forbidden");
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: true,
  stage: "wp3-policy-fixture",
});
test.provider("hourly DO admission persists after actual object destruction", (stack) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "relay-policy-worker-" });
    const context = { dotAlchemy: root, dev: true, adopt: false };
    yield* Effect.gen(function* () {
      const url = yield* stack.deploy(
        Effect.map(Fixture.PolicyWorker, (worker) => worker.url).pipe(
          Effect.provide(Fixture.layer),
        ),
      );
      if (url === undefined) throw new Error("Local Worker fixture did not return a URL");
      const hostname = new URL(url).hostname;
      expect(
        hostname === "127.0.0.1" ||
          hostname === "localhost" ||
          hostname.endsWith(".localhost") ||
          hostname === "[::1]",
      ).toBe(true);
      const http = yield* HttpClient.HttpClient;
      const get = (path: string) => http.get(new URL(path, url).href);
      for (const operation of HOURLY_OPERATIONS) {
        const outcomes = yield* Effect.all(
          Array.from({ length: DEFAULT_LIMITS[operation] + 1 }, () =>
            get(`/rate?operation=${operation}`).pipe(Effect.flatMap((r) => r.json)),
          ),
          { concurrency: "unbounded" },
        );
        expect(
          outcomes.filter(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "allowed" in value &&
              value.allowed === true,
          ),
        ).toHaveLength(DEFAULT_LIMITS[operation]);
      }
      const before = yield* get("/rate-instance").pipe(Effect.flatMap((r) => r.text));
      yield* get("/rate-reset");
      const after = yield* get("/rate-instance").pipe(Effect.flatMap((r) => r.text));
      expect(after).not.toBe(before);
      for (const operation of HOURLY_OPERATIONS) {
        expect(
          yield* get(`/rate?operation=${operation}`).pipe(Effect.flatMap((r) => r.json)),
        ).toMatchObject({ allowed: false, retryAfterSeconds: 3600 });
        expect(
          yield* get(`/rate?account=independent&operation=${operation}`).pipe(
            Effect.flatMap((r) => r.json),
          ),
        ).toMatchObject({ allowed: true });
      }
    }).pipe(
      Effect.provideService(AlchemyContext, context),
      Effect.ensuring(
        stack.destroy().pipe(Effect.provideService(AlchemyContext, context), Effect.orDie),
      ),
    );
  }),
);
