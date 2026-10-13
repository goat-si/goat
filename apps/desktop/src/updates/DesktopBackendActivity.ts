import { GOAT_ACTIVITY_PATH } from "@goat/contracts/legacyT3Names";
import { SshServerActivity } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";

export class DesktopBackendActivity extends Context.Service<
  DesktopBackendActivity,
  {
    readonly probe: Effect.Effect<{
      readonly activity: "idle" | "busy" | "unknown";
      readonly reason: string | null;
      /** Revalidate the exact stop set immediately before install admission. */
      readonly unchanged: Effect.Effect<boolean>;
    }>;
  }
>()("@goat/desktop/updates/DesktopBackendActivity") {}

const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const http = yield* HttpClient.HttpClient;
  const capture = (instance: DesktopBackendPool.DesktopBackendInstance) =>
    Effect.gen(function* () {
      const snapshot = yield* instance.snapshot;
      const config = yield* instance.currentConfig;
      return {
        instance,
        snapshot,
        config,
        url: Option.map(config, (value) => value.httpBaseUrl.href),
      };
    });
  const same = (
    before: Effect.Success<ReturnType<typeof capture>>,
    after: Effect.Success<ReturnType<typeof capture>>,
  ) =>
    before.instance === after.instance &&
    before.snapshot.ready === after.snapshot.ready &&
    before.snapshot.desiredRunning === after.snapshot.desiredRunning &&
    before.snapshot.restartScheduled === after.snapshot.restartScheduled &&
    before.snapshot.restartAttempt === after.snapshot.restartAttempt &&
    Option.getOrNull(before.snapshot.activePid) === Option.getOrNull(after.snapshot.activePid) &&
    Option.getOrNull(before.config) === Option.getOrNull(after.config) &&
    Option.getOrNull(before.url) === Option.getOrNull(after.url);

  return DesktopBackendActivity.of({
    probe: Effect.gen(function* () {
      const instances = yield* pool.list;
      const captured = yield* Effect.forEach(instances, capture);
      const unchanged = Effect.gen(function* () {
        const current = yield* pool.list;
        if (
          current.length !== instances.length ||
          current.some((instance) => !instances.includes(instance))
        )
          return false;
        return yield* Effect.forEach(captured, (before) =>
          capture(before.instance).pipe(Effect.map((after) => same(before, after))),
        ).pipe(Effect.map((results) => results.every(Boolean)));
      });
      const results = yield* Effect.forEach(
        captured,
        (before) =>
          Effect.gen(function* () {
            const { snapshot, config } = before;
            if (
              Option.isNone(snapshot.activePid) &&
              !snapshot.desiredRunning &&
              !snapshot.restartScheduled
            )
              return { activity: "idle" as const, reason: null };
            if (
              Option.isSome(config) &&
              (config.value.runningDistro !== undefined ||
                /(?:^|[/\\])wsl\.exe$/i.test(config.value.executablePath))
            ) {
              return {
                activity: "unknown" as const,
                reason: "Automatic restart postponed: WSL activity cannot be verified.",
              };
            }
            if (!snapshot.ready || Option.isNone(snapshot.activePid) || Option.isNone(config))
              return { activity: "unknown" as const, reason: null };
            const pid = snapshot.activePid.value;
            const url = new URL(GOAT_ACTIVITY_PATH, config.value.httpBaseUrl);
            url.hostname = "127.0.0.1";
            const activity = yield* http.get(url.href).pipe(
              Effect.flatMap((response) =>
                response.json.pipe(
                  Effect.filterOrFail(
                    () => response.status === 200,
                    () => "forbidden",
                  ),
                ),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(SshServerActivity)),
              Effect.map((response) =>
                response.pid === pid ? response.activity : ("unknown" as const),
              ),
              Effect.timeout("2 seconds"),
              Effect.orElseSucceed(() => "unknown" as const),
            );
            const after = yield* capture(before.instance);
            return {
              activity: same(before, after) ? activity : ("unknown" as const),
              reason: null,
            };
          }),
        { concurrency: "unbounded" },
      );
      if (!(yield* unchanged)) return { activity: "unknown" as const, reason: null, unchanged };
      const unknown =
        results.find((result) => result.activity === "unknown" && result.reason !== null) ??
        results.find((result) => result.activity === "unknown");
      return {
        activity: unknown
          ? ("unknown" as const)
          : results.some((result) => result.activity === "busy")
            ? ("busy" as const)
            : ("idle" as const),
        reason: unknown?.reason ?? null,
        unchanged,
      };
    }),
  });
});

export const layer = Layer.effect(DesktopBackendActivity, make);
