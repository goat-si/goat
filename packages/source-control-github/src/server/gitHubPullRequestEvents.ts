import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Sse from "effect/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/http";

import { normalizeHost } from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

/** Readers fetch the pull request on every event, so check suites' conclusions go unused. */
const EVENT_TYPES = [
  "com.github.pull_request.review.submitted.v1",
  "com.github.pull_request.head.changed.v1",
  "com.github.pull_request.state.changed.v1",
  "com.github.pull_request.merge_conflict.v1",
  "com.github.pull_request.check_suite.status.changed.v1",
];
const API_ORIGIN = "https://api.github.com";
/** GitHub sends a keep-alive at least every 15 seconds while a stream is idle. */
const SILENCE_LIMIT = Duration.seconds(45);
/** A connection open this long was healthy, however it ended. */
const HEALTHY_AFTER = Duration.minutes(2);
/** GitHub enables event streams per account, so a refusal or a rejected token holds for a while. */
const REFUSED_PAUSE = Duration.hours(1);
/** Another watch ending may free a slot under the per-account subscription limit. */
const LIMIT_PAUSE = Duration.minutes(10);
const MAX_FAILURES = 6;
const MAX_BACKOFF_MS = 60_000;
/** A feed waits this long for its DELETE, so ending watches and shutdown are not held up. */
const UNSUBSCRIBE_LIMIT = Duration.seconds(5);

// Decoded apart, so a subscription whose URL is refused can still be deleted by its id.
const decodeSubscriptionId = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) })),
);
const decodeEventsUrl = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ events_url: Schema.String })),
);

const decodeStreamEnd = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ outcome: Schema.String })),
);

/** How a connection ended. `renew` means the subscription expired or lost access. */
type Ending = "reconnect" | "renew" | "stop";

const endingOf = (data: string): Ending =>
  Option.match(decodeStreamEnd(data), {
    onNone: () => "reconnect",
    onSome: ({ outcome }) => (outcome === "subscription_ended" ? "renew" : "reconnect"),
  });

export interface PullRequestEventsInput {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

const resourceUrlOf = (input: PullRequestEventsInput) =>
  `https://${input.host}/${input.repository}/pull/${input.number}`;

/**
 * SSE events of a text stream. A retry: field is ignored (Sse.decode fails the stream on it;
 * reconnects keep their own backoff), and an event past the parser's 10 MiB limit fails it.
 */
const sseEvents = <E, R>(
  text: Stream.Stream<string, E, R>,
): Stream.Stream<Sse.Event, E | Sse.SseError, R> =>
  Stream.suspend(() => {
    let parsed: Array<Sse.Event> = [];
    const parser = Sse.makeParser((event) => {
      if (event._tag === "Event") parsed.push(event);
    });
    return text.pipe(
      Stream.flatMap((chunk) => {
        const error = parser.feed(chunk);
        if (error !== undefined) return Stream.fail(error);
        const events = parsed;
        parsed = [];
        return Stream.fromIterable(events);
      }),
    );
  });

/**
 * Pauses belong to the credential that earned them, by its fingerprint (a hash, never the token),
 * so a replaced token or another account is asked again.
 */
const pauseKeys = (fingerprint: string, input: PullRequestEventsInput) => ({
  account: fingerprint,
  pullRequest: `${fingerprint} ${resourceUrlOf(input)}`,
});

/**
 * Emits when a connection opens, so a reader catches up on what it missed, then once per change
 * GitHub reports. Ends quietly when GitHub refuses the subscription; the caller polls meanwhile.
 */
export const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const httpClient = yield* HttpClient.HttpClient;
  /** Keyed by credential for account-wide refusals, and by pull request for one it cannot read. */
  const pausedUntil = new Map<string, number>();
  // A pause is read before the POST and written after GitHub answers, so subscribes run one at a
  // time: feeds starting together on an account without event streams send one refused POST.
  // Only github.com gets feeds, so one permit covers each of its credentials.
  const subscribes = Semaphore.makeUnsafe(1);
  const pause = (key: string, duration: Duration.Duration) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        // Expired pauses go as new ones arrive, so the map holds only live refusals.
        for (const [pausedKey, until] of pausedUntil) {
          if (until <= now) pausedUntil.delete(pausedKey);
        }
        pausedUntil.set(key, now + Duration.toMillis(duration));
      }),
    );

  const unsubscribe = Effect.fn("GitHubPullRequestEvents.unsubscribe")(function* (
    host: string,
    id: string | number,
  ) {
    yield* rest
      .rest({
        host,
        operation: "unsubscribePullRequestEvents",
        method: "DELETE",
        path: `event-subscriptions/${encodeURIComponent(String(id))}`,
      })
      .pipe(Effect.timeout(UNSUBSCRIBE_LIMIT), Effect.ignore);
  });

  const subscribe = Effect.fn("GitHubPullRequestEvents.subscribe")(function* (
    input: PullRequestEventsInput,
  ) {
    const held = yield* rest.credential(input.host).pipe(Effect.option);
    if (Option.isNone(held)) return Option.none();
    const keys = pauseKeys(held.value.fingerprint, input);
    const now = yield* Clock.currentTimeMillis;
    if (
      Math.max(pausedUntil.get(keys.account) ?? 0, pausedUntil.get(keys.pullRequest) ?? 0) > now
    ) {
      return Option.none();
    }
    const response = yield* rest
      .rest({
        host: input.host,
        operation: "subscribePullRequestEvents",
        method: "POST",
        path: "event-subscriptions",
        body: { resource_url: resourceUrlOf(input), event_types: EVENT_TYPES },
      })
      .pipe(
        Effect.asSome,
        Effect.catchTags({
          GitHubApiAuthenticationError: () =>
            pause(keys.account, REFUSED_PAUSE).pipe(Effect.as(Option.none())),
          GitHubApiNotFoundError: () =>
            pause(keys.pullRequest, REFUSED_PAUSE).pipe(Effect.as(Option.none())),
          GitHubApiResponseError: (error) =>
            // Other refusals are not asked again for an hour; server errors are.
            (error.status === 422
              ? pause(keys.account, LIMIT_PAUSE)
              : error.status >= 400 && error.status < 500 && error.status !== 429
                ? pause(keys.account, REFUSED_PAUSE)
                : Effect.void
            ).pipe(Effect.as(Option.none())),
        }),
        Effect.catch((error) =>
          Effect.logDebug("pull request event subscription failed", { error }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
    if (Option.isNone(response)) return Option.none();
    const id = decodeSubscriptionId(response.value.body);
    // The stream request carries the token, so its URL must stay on GitHub's API.
    const eventsUrl = decodeEventsUrl(response.value.body).pipe(
      Option.map(({ events_url }) => events_url),
      Option.filter((url) => URL.parse(url)?.origin === API_ORIGIN),
    );
    if (Option.isSome(id) && Option.isSome(eventsUrl)) {
      return Option.some({ id: id.value.id, events_url: eventsUrl.value });
    }
    // A subscription GOAT cannot follow is deleted, and the host is not asked again for a while.
    if (Option.isSome(id)) yield* unsubscribe(input.host, id.value.id);
    yield* pause(keys.account, REFUSED_PAUSE);
    return Option.none();
  }, subscribes.withPermit);

  /** One SSE connection: "changed" when it opens and per event, and last, how it ended. */
  const connection = (host: string, eventsUrl: string): Stream.Stream<"changed" | Ending> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const held = yield* rest.credential(host);
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(eventsUrl).pipe(
              HttpClientRequest.setHeaders({
                accept: "text/event-stream",
                "x-github-api-version": "2022-11-28",
                "user-agent": "goat",
                authorization: `Bearer ${Redacted.value(held.token)}`,
              }),
            ),
          )
          // Client spans would carry the subscription URL.
          .pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.timeout(SILENCE_LIMIT),
          );
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          return Stream.succeed<Ending>("stop");
        }
        if (response.status !== 200) return Stream.succeed<Ending>("reconnect");
        return response.stream.pipe(
          Stream.timeoutOrElse({ duration: SILENCE_LIMIT, orElse: () => Stream.fail("silent") }),
          Stream.decodeText,
          sseEvents,
          Stream.map((frame): "changed" | Ending =>
            frame.event === "github.stream.end" ? endingOf(frame.data) : "changed",
          ),
          Stream.prepend(["changed" as const]),
          // A close without GitHub's end frame is reconnected like one with it.
          Stream.concat(Stream.succeed<Ending>("reconnect")),
          Stream.takeUntil((element) => element !== "changed"),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) =>
        Stream.fromEffect(
          Effect.logDebug("pull request event stream failed", { cause }).pipe(
            Effect.as<Ending>("reconnect"),
          ),
        ),
      ),
    );

  const backoff = Effect.fn("GitHubPullRequestEvents.backoff")(function* (failures: number) {
    const jitter = yield* Random.next;
    yield* Effect.sleep(
      Duration.millis(Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures) * (0.5 + jitter / 2)),
    );
  });

  return (input: PullRequestEventsInput): Stream.Stream<void> => {
    const target = { ...input, host: normalizeHost(input.host) };
    if (target.host !== "github.com") return Stream.empty;

    /** Follows one subscription; sets `session.renew` when it needs replacing. */
    const follow = (
      session: { renew: boolean },
      eventsUrl: string,
      failuresSoFar: number,
    ): Stream.Stream<void> =>
      Stream.unwrap(
        Clock.currentTimeMillis.pipe(
          Effect.map((openedAt) => {
            let ending: Ending = "reconnect";
            let changes = 0;
            return connection(target.host, eventsUrl).pipe(
              Stream.flatMap((element) => {
                if (element === "changed") {
                  changes += 1;
                  return Stream.succeed(undefined);
                }
                ending = element;
                return Stream.empty;
              }),
              Stream.concat(
                Stream.unwrap(
                  Clock.currentTimeMillis.pipe(
                    Effect.map((closedAt) => {
                      // The first change is the opening; an event or a long life proves it worked.
                      const healthy =
                        changes > 1 || closedAt - openedAt >= Duration.toMillis(HEALTHY_AFTER);
                      const failures = healthy ? 0 : failuresSoFar + 1;
                      switch (ending) {
                        case "stop":
                          return Stream.fromEffectDrain(
                            rest.credential(target.host).pipe(
                              Effect.flatMap((held) =>
                                pause(
                                  pauseKeys(held.fingerprint, target).pullRequest,
                                  REFUSED_PAUSE,
                                ),
                              ),
                              Effect.ignore,
                            ),
                          );
                        case "renew":
                          session.renew = true;
                          return Stream.empty;
                        case "reconnect":
                          return failures > MAX_FAILURES
                            ? Stream.empty
                            : Stream.fromEffectDrain(backoff(failures)).pipe(
                                Stream.concat(follow(session, eventsUrl, failures)),
                              );
                      }
                    }),
                  ),
                ),
              ),
            );
          }),
        ),
      );

    /** One subscription, deleted once its stream has closed. */
    const subscription = (session: { renew: boolean }): Stream.Stream<void> =>
      Stream.unwrap(
        Effect.acquireRelease(subscribe(target), (held) =>
          Option.isSome(held) ? unsubscribe(target.host, held.value.id) : Effect.void,
        ).pipe(
          Effect.map(
            Option.match({
              onNone: () => Stream.empty,
              onSome: ({ events_url }) => follow(session, events_url, 0),
            }),
          ),
        ),
      );

    const subscribed = (): Stream.Stream<void> =>
      Stream.suspend(() => {
        const session = { renew: false };
        return subscription(session).pipe(
          Stream.concat(
            Stream.suspend(() =>
              session.renew
                ? Stream.fromEffectDrain(backoff(0)).pipe(Stream.concat(subscribed()))
                : Stream.empty,
            ),
          ),
        );
      });

    // Event streams are a GitHub preview read with the host credential; a refusal pauses the host.
    return subscribed();
  };
});
