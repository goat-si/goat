// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy's local provider owns the workerd fixture lifecycle.
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import { resolveDev } from "alchemy/Test/Core";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Fixture from "../accounts/test/PolicyWorkerFixture.ts";

if (!resolveDev({ dev: true }))
  throw new Error("wp3 inbox tests require local provider mode; cloud fallback is forbidden");
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: true,
  stage: "wp3-inbox-fixture",
});
test.provider(
  "persisted hook authorization survives restart; outages retain and stale alarms drop",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "relay-hook-worker-" });
      const context = { dotAlchemy: root, dev: true, adopt: false };
      yield* Effect.gen(function* () {
        const url = yield* stack.deploy(
          Effect.map(Fixture.PolicyWorker, (w) => w.url).pipe(Effect.provide(Fixture.layer)),
        );
        const hostname = new URL(url).hostname;
        expect(
          hostname === "127.0.0.1" ||
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname === "[::1]",
        ).toBe(true);
        const http = yield* HttpClient.HttpClient;
        const get = (path: string) => http.get(new URL(path, url).href);
        yield* get("/hook-mode?mode=allowed");
        expect(yield* get("/hook-hold").pipe(Effect.flatMap((r) => r.json))).toBe(true);
        const before = yield* get("/hook-instance").pipe(Effect.flatMap((r) => r.text));
        yield* get("/hook-reset");
        expect(yield* get("/hook-instance").pipe(Effect.flatMap((r) => r.text))).not.toBe(before);
        yield* get("/hook-mode?mode=unavailable");
        yield* get("/hook-run");
        expect(yield* get("/hook-pending").pipe(Effect.flatMap((r) => r.json))).toBe(1);
        yield* get("/hook-mode?mode=stale");
        yield* get("/hook-run");
        expect(yield* get("/hook-pending").pipe(Effect.flatMap((r) => r.json))).toBe(0);
      }).pipe(
        Effect.provideService(AlchemyContext, context),
        Effect.ensuring(stack.destroy().pipe(Effect.provideService(AlchemyContext, context))),
      );
    }),
);
