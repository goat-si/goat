import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  RunId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  type CompletionWebhookSettings,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { verifyWebhookSignature } from "../scheduledTasks/webhookVerification.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CompletionWebhook from "./completionWebhook.ts";
import { newLaunchWatch, type LaunchWatch, type LaunchWatchWebhookTarget } from "./launchWatch.ts";

const launcher = ThreadId.make("launcher");
const target = ThreadId.make("target");
const run1 = RunId.make("run-1");
const project = ProjectId.make("project");
/** The one ref the fake secret requests know: entered in `project`, holding "inline-secret". */
const enteredRef = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");

const watchFor = (input: {
  notifyWebhook: boolean;
  host?: string | null;
  launcherThreadId?: ThreadId | null;
  webhookTarget?: LaunchWatchWebhookTarget | null;
}): LaunchWatch =>
  newLaunchWatch({
    launcherThreadId: input.launcherThreadId === undefined ? launcher : input.launcherThreadId,
    host: input.host ?? null,
    threadId: target,
    projectId: project,
    title: "Fix the flake",
    incarnation: "incarnation-1",
    notifyWebhook: input.notifyWebhook,
    webhookTarget: input.webhookTarget ?? null,
    now: 0,
  });

const runReport = (
  id = "server:launch-watch:w:run:run-1",
): CompletionWebhook.CompletionWebhookReport => ({
  id,
  event: "run.completed",
  runId: run1,
  status: "completed",
  title: null,
  summary: 'Launched thread "Fix the flake" completed',
  excerpt: "Fixed the flake; tests pass.",
  prUrl: "https://github.com/acme/app/pull/7",
});

const enabled = {
  enabled: true,
  url: "https://agent.example/hooks/goat",
  secret: "s3cret",
  allLaunches: false,
  externalLaunches: false,
  targets: {},
} satisfies CompletionWebhookSettings;

interface Received {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * A webhook receiver answering each request in turn (the last answer repeats), and a
 * count of settings reads, which is how a delivery that sent nothing shows it ran.
 */
const harness = (
  settings: Partial<CompletionWebhookSettings>,
  answers: ReadonlyArray<number | "network" | "hang"> = [200],
) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<Received>();
    const completed = yield* Queue.unbounded<string>();
    const retryScheduled = yield* Queue.unbounded<number>();
    const requestCleanedUp = yield* Queue.unbounded<void>();
    const timeoutScheduled = yield* Queue.unbounded<void>();
    const clock = yield* Clock.Clock;
    const log: Array<Received> = [];
    const reads = { count: 0 };
    /** The server secret store, by name. */
    const secrets = new Map<string, Uint8Array>();
    /** DNS for inline targets: `.example` hosts are public unless listed here. */
    const dns = new Map<string, ReadonlyArray<string>>([["localhost", ["127.0.0.1", "::1"]]]);
    const client = HttpClient.make((request) =>
      Effect.suspend(() => {
        const entry = {
          url: request.url,
          headers: new Headers(Object.entries(request.headers)),
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        };
        const answer = answers[Math.min(log.length, answers.length - 1)] ?? 200;
        log.push(entry);
        Queue.offerUnsafe(received, entry);
        if (answer === "network") {
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: "connection refused" }),
            }),
          );
        }
        if (answer === "hang") return Effect.never;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: answer })),
        );
      }).pipe(Effect.ensuring(Queue.offer(requestCleanedUp, undefined))),
    );
    const countingSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      Effect.gen(function* () {
        const base = yield* ServerSettings.ServerSettingsService;
        return ServerSettings.ServerSettingsService.of({
          ...base,
          getSettings: base.getSettings.pipe(Effect.tap(() => Effect.sync(() => reads.count++))),
        });
      }),
    ).pipe(Layer.provide(ServerSettings.layerTest({ completionWebhook: settings })));
    const layer = CompletionWebhook.layer.pipe(
      Layer.provideMerge(countingSettings),
      Layer.provide(
        Layer.succeed(CompletionWebhook.DeliveryCompleted, (id: string) =>
          Queue.offer(completed, id).pipe(Effect.asVoid),
        ),
      ),
      // Expose this clock to the notify caller too: delivery fibers inherit its context.
      Layer.provideMerge(
        Layer.succeed(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            (Duration.toMillis(duration) === 10_000
              ? Queue.offer(timeoutScheduled, undefined).pipe(Effect.asVoid)
              : Queue.offer(retryScheduled, Duration.toMillis(duration)).pipe(Effect.asVoid)
            ).pipe(Effect.andThen(clock.sleep(duration))),
        }),
      ),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(
        Layer.succeed(CompletionWebhook.InlineHostResolver, (host: string) => {
          const addresses = dns.get(host) ?? (host.endsWith(".example") ? ["93.184.215.14"] : []);
          return addresses.length === 0
            ? Effect.fail(new CompletionWebhook.HostLookupError({ cause: "ENOTFOUND" }))
            : Effect.succeed(addresses);
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
      ),
      Layer.provide(
        Layer.mock(SecretRequests.SecretRequests)({
          consume: ({ ref, projectId }) =>
            ref === enteredRef && projectId === project
              ? Effect.succeed("inline-secret")
              : Effect.fail(new SecretRequestError({ reason: "not_found" })),
        }),
      ),
    );
    return {
      received,
      completed,
      retryScheduled,
      requestCleanedUp,
      timeoutScheduled,
      log,
      reads,
      secrets,
      dns,
      layer,
    };
  });

const withWebhook = <A, E, LE>(
  layer: Layer.Layer<
    CompletionWebhook.CompletionWebhook | ServerSettings.ServerSettingsService,
    LE
  >,
  body: (
    webhook: CompletionWebhook.CompletionWebhookShape,
    settings: ServerSettings.ServerSettingsService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const webhook = yield* CompletionWebhook.CompletionWebhook;
    const settings = yield* ServerSettings.ServerSettingsService;
    return yield* body(webhook, settings);
  }).pipe(Effect.provide(layer));

const verifySignature = (request: Received, secret: string) =>
  verifyWebhookSignature({
    signature: { header: "x-goat-signature", prefix: "sha256=", encoding: "hex" },
    secret,
    headers: { "x-goat-signature": request.headers.get("x-goat-signature") ?? "" },
    body: new TextEncoder().encode(request.body),
  });

describe("completionWebhookPayload", () => {
  it("carries the run, the watch's threads and host, and leaves out absent optional fields", () => {
    const remote = watchFor({ notifyWebhook: true, host: "box" });
    expect(CompletionWebhook.completionWebhookPayload(remote, runReport(), 0)).toEqual({
      id: "server:launch-watch:w:run:run-1",
      event: "run.completed",
      threadId: target,
      runId: run1,
      host: "box",
      title: "Fix the flake",
      status: "completed",
      summary: 'Launched thread "Fix the flake" completed',
      excerpt: "Fixed the flake; tests pass.",
      prUrl: "https://github.com/acme/app/pull/7",
      launcherThreadId: launcher,
      at: "1970-01-01T00:00:00.000Z",
    });
    const question = CompletionWebhook.completionWebhookPayload(
      watchFor({ notifyWebhook: true }),
      {
        ...runReport(),
        event: "question",
        requestId: "question-1",
        status: "waiting",
        excerpt: null,
        prUrl: null,
      },
      0,
    );
    expect(question).toMatchObject({ host: null, requestId: "question-1", excerpt: null });
    expect(question).not.toHaveProperty("prUrl");
  });
});

describe("CompletionWebhook", () => {
  it.effect("posts the payload signed with the secret, with event and delivery headers", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          const request = yield* Queue.take(h.received);
          expect(request.url).toBe(enabled.url);
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(request.headers.get("x-goat-event")).toBe("run.completed");
          expect(request.headers.get("x-goat-delivery")).toBe("server:launch-watch:w:run:run-1");
          expect(JSON.parse(request.body)).toMatchObject({
            event: "run.completed",
            threadId: target,
            runId: run1,
            launcherThreadId: launcher,
            prUrl: "https://github.com/acme/app/pull/7",
          });
          expect(verifySignature(request, "s3cret")).toBe(true);
          expect(verifySignature(request, "other")).toBe(false);
        }),
      );
    }),
  );

  it.effect("omits the signature without a secret", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, secret: "" });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          const request = yield* Queue.take(h.received);
          expect(request.headers.has("x-goat-signature")).toBe(false);
        }),
      );
    }),
  );

  it.effect.each([
    ["the webhook is off", { ...enabled, enabled: false, allLaunches: true }, true],
    ["the launch did not opt in", enabled, false],
    ["the url is empty", { ...enabled, url: "" }, true],
    ["the url is not http(s)", { ...enabled, url: "file:///etc/passwd" }, true],
  ] as const)("posts nothing when %s", ([, settings, notifyWebhook]) =>
    Effect.gen(function* () {
      const h = yield* harness(settings);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook }), runReport());
          yield* Queue.take(h.completed);
          yield* TestClock.adjust(60 * 60_000);
        }),
      );
      expect(h.reads.count).toBe(1);
      expect(h.log).toEqual([]);
    }),
  );

  it.effect("posts for a watch that did not opt in when allLaunches is on", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, allLaunches: true });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: false }), runReport());
          yield* Queue.take(h.received);
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("returns before the receiver answers, so a wake is never held back", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, ["hang"]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
        }),
      );
    }),
  );

  it.effect("a superseded watch cannot publish a queued webhook retry", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503, 200]);
      let current = true;
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport(), () => current);
          yield* Queue.take(h.received);
          const backoff = yield* Queue.take(h.retryScheduled);
          current = false;
          yield* TestClock.adjust(backoff);
          yield* Queue.take(h.completed);
          expect(h.log).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("retries failures with the launch watch backoff until the receiver accepts", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503, "network", 408, 429, 204]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          for (const backoff of [30_000, 60_000, 120_000, 240_000]) {
            expect(yield* Queue.take(h.retryScheduled)).toBe(backoff);
            yield* TestClock.adjust(backoff - 1);
            expect(Queue.sizeUnsafe(h.received)).toBe(0);
            yield* TestClock.adjust(1);
            yield* Queue.take(h.received);
          }
          yield* Queue.take(h.completed);
          yield* TestClock.adjust(60 * 60_000);
        }),
      );
      expect(h.log).toHaveLength(5);
      // Every retry is the same event under the same id and body.
      expect(new Set(h.log.map((request) => request.body)).size).toBe(1);
      expect(new Set(h.log.map((request) => request.headers.get("x-goat-delivery"))).size).toBe(1);
    }),
  );

  it.effect("gives up after the last attempt and does not retry a refusal", () =>
    Effect.gen(function* () {
      const failing = yield* harness(enabled, [500]);
      yield* withWebhook(failing.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          for (let attempt = 1; attempt < CompletionWebhook.MAX_ATTEMPTS; attempt++) {
            const backoff = yield* Queue.take(failing.retryScheduled);
            yield* TestClock.adjust(backoff);
          }
          yield* Queue.take(failing.completed);
          yield* TestClock.adjust(60 * 60_000);
        }),
      );
      expect(failing.log).toHaveLength(CompletionWebhook.MAX_ATTEMPTS);

      const refused = yield* harness(enabled, [400]);
      yield* withWebhook(refused.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(refused.received);
          yield* Queue.take(refused.completed);
          yield* TestClock.adjust(60 * 60_000);
        }),
      );
      expect(refused.log).toHaveLength(1);
    }),
  );

  it.effect("a shutdown stops a delivery reported from an uninterruptible section", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503]);
      // The launch watch reports while it holds its lock, uninterruptibly; leaving the
      // layer must still end the delivery that is waiting out its backoff.
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* Effect.uninterruptible(
            webhook.notify(watchFor({ notifyWebhook: true }), runReport()),
          );
          yield* Queue.take(h.received);
          yield* Queue.take(h.retryScheduled);
        }),
      );
      yield* TestClock.adjust(60 * 60_000);
      // Closing the layer joins the interrupted delivery and its finalizers.
      yield* Queue.take(h.requestCleanedUp);
      yield* Queue.take(h.completed);
      expect(h.reads.count).toBe(1);
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("retries a request the receiver never answers once it times out", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, ["hang", 200]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          yield* Queue.take(h.timeoutScheduled);
          yield* TestClock.adjust(10_000);
          yield* Queue.take(h.requestCleanedUp);
          expect(yield* Queue.take(h.retryScheduled)).toBe(30_000);
          yield* TestClock.adjust(30_000 - 1);
          expect(Queue.sizeUnsafe(h.received)).toBe(0);
          yield* TestClock.adjust(1);
          yield* Queue.take(h.received);
          yield* Queue.take(h.completed);
          yield* TestClock.adjust(60 * 60_000);
        }),
      );
      expect(h.log).toHaveLength(2);
    }),
  );

  it.effect("signs a retry with the secret current when it is sent", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503, 200]);
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          yield* settings.updateSettings({ completionWebhook: { secret: "rotated" } });
          yield* Queue.take(h.retryScheduled);
          yield* TestClock.adjust(30_000);
          const retry = yield* Queue.take(h.received);
          expect(verifySignature(retry, "rotated")).toBe(true);
          expect(verifySignature(retry, "s3cret")).toBe(false);
        }),
      );
    }),
  );

  it.effect("stops retrying once the webhook is turned off", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled, [503]);
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport());
          yield* Queue.take(h.received);
          yield* settings.updateSettings({ completionWebhook: { enabled: false } });
          yield* Queue.take(h.retryScheduled);
          yield* TestClock.adjust(60 * 60_000);
          yield* Queue.take(h.completed);
        }),
      );
      expect(h.reads.count).toBe(2);
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("posts each event once, however often it is reported", () =>
    Effect.gen(function* () {
      const h = yield* harness(enabled);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const watch = watchFor({ notifyWebhook: true });
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.received);
          yield* webhook.notify(watch, runReport());
          yield* webhook.notify(watch, runReport("server:launch-watch:w:run:run-2"));
          yield* Queue.take(h.received);
          yield* Queue.take(h.completed);
          yield* Queue.take(h.completed);
        }),
      );
      expect(h.log.map((request) => request.headers.get("x-goat-delivery"))).toEqual([
        "server:launch-watch:w:run:run-1",
        "server:launch-watch:w:run:run-2",
      ]);
    }),
  );

  it.effect("a report skipped while the webhook was off can still post later", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, enabled: false });
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          const watch = watchFor({ notifyWebhook: true });
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.completed);
          yield* settings.updateSettings({ completionWebhook: { enabled: true } });
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.received);
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect.each([
    ["by default, even when asked", {}, true, false],
    ["for a launch that did not ask", enabled, false, false],
    ["for a launch that asked", enabled, true, true],
    ["for every launch with externalLaunches", { ...enabled, externalLaunches: true }, false, true],
    ["for every watch with only allLaunches", { ...enabled, allLaunches: true }, false, false],
    [
      "while the webhook is off",
      { ...enabled, enabled: false, externalLaunches: true },
      true,
      false,
    ],
    ["without an http(s) url", { ...enabled, url: "file:///hook" }, true, false],
  ] as const)(
    "decides whether to watch an outside launch %s",
    ([, settings, requested, expected]) =>
      Effect.gen(function* () {
        const h = yield* harness(settings);
        const watched = yield* withWebhook(h.layer, (webhook) =>
          webhook.watchesExternal({ notifyWebhook: requested, webhookTarget: null }),
        );
        expect(watched).toBe(expected);
      }),
  );

  it.effect("posts a launcherless watch's report signed, with a null launcherThreadId", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...enabled, externalLaunches: true });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          // externalLaunches posts for a launcherless watch that did not ask itself.
          yield* webhook.notify(
            watchFor({ notifyWebhook: false, launcherThreadId: null, host: "box" }),
            runReport(),
          );
          const request = yield* Queue.take(h.received);
          expect(JSON.parse(request.body)).toMatchObject({
            event: "run.completed",
            threadId: target,
            host: "box",
            launcherThreadId: null,
          });
          expect(verifySignature(request, "s3cret")).toBe(true);
        }),
      );
    }),
  );
});

describe("CompletionWebhook notify targets", () => {
  const routed = {
    ...enabled,
    targets: {
      "bot-a": { url: "https://a.example/hook", secret: "secret-a" },
      "bot-b": { url: "https://b.example/hook", secret: "secret-b" },
    },
  } satisfies CompletionWebhookSettings;
  const named = (name: string): LaunchWatchWebhookTarget => ({ type: "named", name });

  it.effect(
    "sends each launch's reports only to its own target, signed with that target's secret",
    () =>
      Effect.gen(function* () {
        // allLaunches would send an unrouted watch to the default url; a routed one still goes only to its target.
        const h = yield* harness({ ...routed, allLaunches: true });
        yield* withWebhook(h.layer, (webhook) =>
          Effect.gen(function* () {
            yield* webhook.notify(
              watchFor({ notifyWebhook: false, webhookTarget: named("bot-a") }),
              runReport("report-a"),
            );
            yield* webhook.notify(
              watchFor({ notifyWebhook: false, webhookTarget: named("bot-b") }),
              runReport("report-b"),
            );
            yield* Queue.take(h.received);
            yield* Queue.take(h.received);
            yield* Queue.take(h.completed);
            yield* Queue.take(h.completed);
          }),
        );
        expect(h.log.map((request) => request.url).toSorted()).toEqual([
          "https://a.example/hook",
          "https://b.example/hook",
        ]);
        const toA = h.log.find((request) => request.url === "https://a.example/hook")!;
        const toB = h.log.find((request) => request.url === "https://b.example/hook")!;
        expect(toA.headers.get("x-goat-delivery")).toBe("report-a");
        expect(toB.headers.get("x-goat-delivery")).toBe("report-b");
        expect(JSON.parse(toA.body)).toMatchObject({ threadId: target, title: "Fix the flake" });
        expect(verifySignature(toA, "secret-a")).toBe(true);
        expect(verifySignature(toA, "secret-b")).toBe(false);
        expect(verifySignature(toB, "secret-b")).toBe(true);
        expect(verifySignature(toB, "s3cret")).toBe(false);
      }),
  );

  it.effect("sends nothing for a launch that chose no target and did not opt in", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          yield* webhook.notify(watchFor({ notifyWebhook: false }), runReport());
          yield* webhook.notify(
            watchFor({ notifyWebhook: false, launcherThreadId: null }),
            runReport("outside"),
          );
          yield* Queue.take(h.completed);
          yield* Queue.take(h.completed);
          yield* TestClock.adjust(60 * 60_000);
          expect(yield* webhook.wants(watchFor({ notifyWebhook: false }))).toBe(false);
        }),
      );
      expect(h.log).toEqual([]);
    }),
  );

  it.effect("stops sending to a named target once it is removed from settings", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      yield* withWebhook(h.layer, (webhook, settings) =>
        Effect.gen(function* () {
          yield* settings.updateSettings({ completionWebhook: { targets: { "bot-a": null } } });
          const watch = watchFor({ notifyWebhook: false, webhookTarget: named("bot-a") });
          expect(yield* webhook.wants(watch)).toBe(false);
          yield* webhook.notify(watch, runReport());
          yield* Queue.take(h.completed);
        }),
      );
      expect(h.log).toEqual([]);
    }),
  );

  it.effect("resolves a launch's choice, refusing what it cannot honor", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const resolve = (
            notifyTarget: CompletionWebhook.NotifyTargetInput | undefined,
            notifyWebhook?: boolean,
          ) =>
            webhook.resolveRoute({
              notifyWebhook,
              notifyOnCompletion: undefined,
              notifyTarget,
              projectId: project,
            });
          const refusal = (
            notifyTarget: CompletionWebhook.NotifyTargetInput | undefined,
            notifyWebhook?: boolean,
          ) =>
            resolve(notifyTarget, notifyWebhook).pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );

          expect(yield* resolve(undefined)).toEqual({ notifyWebhook: false, webhookTarget: null });
          expect(yield* resolve(undefined, true)).toEqual({
            notifyWebhook: true,
            webhookTarget: null,
          });
          expect(yield* resolve({ name: "bot-a" })).toEqual({
            notifyWebhook: false,
            webhookTarget: { type: "named", name: "bot-a" },
          });
          expect(yield* refusal({ name: "bot-c" })).toBe(
            'Unknown notify target "bot-c". Configured targets: bot-a, bot-b.',
          );
          expect(yield* refusal({ name: "bot-a", url: "https://a.example/hook" })).toContain(
            "exactly one of name and url",
          );
          expect(yield* refusal({ name: "bot-a", secretRef: enteredRef })).toContain(
            "pass secretRef only with url",
          );
          expect(yield* refusal({ url: "file:///etc/passwd" })).toContain("http(s)");
          expect(yield* refusal({ name: "bot-a" }, false)).toContain("notifyWebhook:false");
          expect(
            yield* refusal({
              url: "https://c.example/hook",
              secretRef: SecretRef.make("secret-ref:ff"),
            }),
          ).toContain("notifyTarget.secretRef");
        }),
      );
      // Nothing was kept for a refused launch.
      expect(h.secrets.size).toBe(0);
    }),
  );

  it.effect("refuses every target while webhooks are off", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...routed, enabled: false });
      const error = yield* withWebhook(h.layer, (webhook) =>
        webhook
          .resolveRoute({
            notifyWebhook: undefined,
            notifyOnCompletion: undefined,
            notifyTarget: { name: "bot-a" },
            projectId: null,
          })
          .pipe(Effect.flip),
      );
      expect(error.message).toContain("off on this server");
    }),
  );

  it.effect("keeps an inline target's secret in the store, signs with it, and releases it", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const route = yield* webhook.resolveRoute({
            notifyWebhook: undefined,
            notifyOnCompletion: undefined,
            notifyTarget: { url: "https://inline.example/hook", secretRef: enteredRef },
            projectId: project,
          });
          // The route names where the secret is kept; it never carries the value.
          expect(JSON.stringify(route)).not.toContain("inline-secret");
          expect(route.webhookTarget).toMatchObject({
            type: "inline",
            url: "https://inline.example/hook",
          });
          expect([...h.secrets.values()].map((value) => new TextDecoder().decode(value))).toEqual([
            "inline-secret",
          ]);

          yield* webhook.notify(
            watchFor({ notifyWebhook: false, webhookTarget: route.webhookTarget }),
            runReport(),
          );
          const request = yield* Queue.take(h.received);
          expect(request.url).toBe("https://inline.example/hook");
          expect(verifySignature(request, "inline-secret")).toBe(true);

          yield* webhook.release(route.webhookTarget);
          expect(h.secrets.size).toBe(0);
          // A signed target whose secret is gone posts nothing rather than posting unsigned.
          yield* webhook.notify(
            watchFor({ notifyWebhook: false, webhookTarget: route.webhookTarget }),
            runReport("after-release"),
          );
          yield* Queue.take(h.completed);
          yield* Queue.take(h.completed);
        }),
      );
      expect(h.log).toHaveLength(1);
    }),
  );

  it.effect("keeps signing a retry after the watch released its inline secret", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed, [503, 200]);
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const route = yield* webhook.resolveRoute({
            notifyWebhook: undefined,
            notifyOnCompletion: undefined,
            notifyTarget: { url: "https://inline.example/hook", secretRef: enteredRef },
            projectId: project,
          });
          yield* webhook.notify(
            watchFor({ notifyWebhook: false, webhookTarget: route.webhookTarget }),
            runReport(),
          );
          yield* Queue.take(h.received);
          // The watch ends, and its secret with it, while the report still retries.
          yield* webhook.release(route.webhookTarget);
          yield* Queue.take(h.retryScheduled);
          yield* TestClock.adjust(30_000);
          const retry = yield* Queue.take(h.received);
          expect(verifySignature(retry, "inline-secret")).toBe(true);
        }),
      );
      expect(h.log).toHaveLength(2);
    }),
  );

  it.effect("needs a calling thread's project to use a secretRef", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      const error = yield* withWebhook(h.layer, (webhook) =>
        webhook
          .resolveRoute({
            notifyWebhook: undefined,
            notifyOnCompletion: undefined,
            notifyTarget: { url: "https://inline.example/hook", secretRef: enteredRef },
            projectId: null,
          })
          .pipe(Effect.flip),
      );
      expect(error.message).toContain("request_secret");
      expect(h.secrets.size).toBe(0);
    }),
  );

  it.effect("watches an outside launch that chose a target even without a default url", () =>
    Effect.gen(function* () {
      const h = yield* harness({ ...routed, url: "" });
      const watched = yield* withWebhook(h.layer, (webhook) =>
        webhook.watchesExternal({ notifyWebhook: false, webhookTarget: named("bot-a") }),
      );
      expect(watched).toBe(true);
    }),
  );

  it.effect("refuses an inline url that reaches this machine, its networks, or metadata", () =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      h.dns.set("intranet.example", ["93.184.215.14", "10.1.2.3"]);
      const refusals = yield* withWebhook(h.layer, (webhook) =>
        Effect.forEach(
          [
            "http://127.0.0.1:3790/hook",
            "http://2130706433/hook",
            "http://[::1]/hook",
            "http://[::ffff:127.0.0.1]/hook",
            "http://169.254.169.254/latest/meta-data",
            "http://[fe80::1]/hook",
            "http://192.168.1.10/hook",
            "http://100.100.100.100/hook",
            "http://0.0.0.0/hook",
            "http://localhost:3790/hook",
            "https://intranet.example/hook",
            "https://missing.invalid/hook",
          ],
          (url) =>
            webhook
              .resolveRoute({
                notifyWebhook: undefined,
                notifyOnCompletion: undefined,
                notifyTarget: { url, secretRef: enteredRef },
                projectId: project,
              })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.message),
              ),
        ),
      );
      expect(refusals.slice(0, -1).every((message) => message.includes("named target"))).toBe(true);
      expect(refusals.at(-1)).toContain("could not be resolved");
      // The secret was never consumed for a refused url.
      expect(h.secrets.size).toBe(0);
    }),
  );

  it.effect.each([
    "2002:a00:1::1",
    "2002:a9fe:a9fe::1",
    "2002:7f00:1::1",
    "2002::1",
    "fec0::1",
    "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "2001:db8::1",
    "::ffff:192.0.2.1",
    "64:ff9b::c000:201",
    "2002:c000:201::1",
  ])("refuses non-public notify target %s directly and through DNS", (address) =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      h.dns.set("blocked.example", [address]);
      const host = address.includes(":") ? `[${address}]` : address;
      yield* withWebhook(h.layer, (webhook) =>
        Effect.forEach([`https://${host}/hook`, "https://blocked.example/hook"], (url) =>
          Effect.gen(function* () {
            const error = yield* webhook
              .resolveRoute({
                notifyWebhook: undefined,
                notifyOnCompletion: undefined,
                notifyTarget: { url },
                projectId: null,
              })
              .pipe(Effect.flip);
            expect(error.message).toContain("named target");
          }),
        ),
      );
      expect(h.log).toEqual([]);
    }),
  );

  it.effect.each([
    "2002:808:808::1",
    "2002:808::1",
    "2002:0808:0808:0:0:0:0:1",
    "2002:808:808::192.0.2.1",
    "2001:4860:4860::8888",
    "8.8.8.8",
  ])("allows public notify target %s directly and through DNS", (address) =>
    Effect.gen(function* () {
      const h = yield* harness(routed);
      h.dns.set("public.example", [address]);
      const host = address.includes(":") ? `[${address}]` : address;
      yield* withWebhook(h.layer, (webhook) =>
        Effect.forEach([`https://${host}/hook`, "https://public.example/hook"], (url) =>
          Effect.gen(function* () {
            const route = yield* webhook.resolveRoute({
              notifyWebhook: undefined,
              notifyOnCompletion: undefined,
              notifyTarget: { url },
              projectId: null,
            });
            expect(route.webhookTarget).toMatchObject({ type: "inline", url });
          }),
        ),
      );
    }),
  );

  it.effect.each(["169.254.169.254", "2002:a00:1::1", "fec0::1", "2001:db8::1"])(
    "stops posting to an inline host that later resolves to %s",
    (address) =>
      Effect.gen(function* () {
        const h = yield* harness(routed);
        yield* withWebhook(h.layer, (webhook) =>
          Effect.gen(function* () {
            const route = yield* webhook.resolveRoute({
              notifyWebhook: undefined,
              notifyOnCompletion: undefined,
              notifyTarget: { url: "https://rebind.example/hook" },
              projectId: null,
            });
            h.dns.set("rebind.example", [address]);
            yield* webhook.notify(
              watchFor({ notifyWebhook: false, webhookTarget: route.webhookTarget }),
              runReport(),
            );
            yield* Queue.take(h.completed);
            yield* TestClock.adjust(60_000);
          }),
        );
        expect(h.log).toHaveLength(0);
      }),
  );

  it.effect("still posts to loopback receivers the server's settings name", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        ...routed,
        url: "http://127.0.0.1:3790/hooks/goat",
        targets: { local: { url: "http://127.0.0.1:3790/hooks/local", secret: "s" } },
      });
      yield* withWebhook(h.layer, (webhook) =>
        Effect.gen(function* () {
          const route = yield* webhook.resolveRoute({
            notifyWebhook: undefined,
            notifyOnCompletion: undefined,
            notifyTarget: { name: "local" },
            projectId: null,
          });
          yield* webhook.notify(
            watchFor({ notifyWebhook: false, webhookTarget: route.webhookTarget }),
            runReport("named"),
          );
          yield* webhook.notify(watchFor({ notifyWebhook: true }), runReport("default"));
          yield* Queue.take(h.received);
          yield* Queue.take(h.received);
        }),
      );
      expect(h.log.map((request) => request.url).sort()).toEqual([
        "http://127.0.0.1:3790/hooks/goat",
        "http://127.0.0.1:3790/hooks/local",
      ]);
    }),
  );
});
