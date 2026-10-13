// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import {
  type CompletionWebhookSettings,
  type ProjectId,
  type RunId,
  SecretRef,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import { backoffMs, type LaunchWatch, type LaunchWatchWebhookTarget } from "./launchWatch.ts";

/**
 * Posts launch watch reports to a webhook, so an agent outside GOAT hears what
 * the launcher thread hears. Delivery is opt in per launch: a watch posts to
 * the target its launch chose (a named one from `completionWebhook.targets`
 * or an inline URL), else to `completionWebhook.url` when the launch passed
 * notifyWebhook or the settings take every such launch. Delivery runs on its
 * own fiber and never holds back the wake. A launcherless watch, for a launch
 * from outside any thread, has no wake and reports only here. It is best effort: a report whose
 * POST has not succeeded when the server stops is lost, and one whose wake is
 * replayed after a crash before the watch state was saved can post twice under
 * the same id.
 */

export type CompletionWebhookEvent = "run.completed" | "question" | "host.unavailable";

/** One report, as the launch watch knows it when its wake is settled. */
export interface CompletionWebhookReport {
  /** Stable per reported event: the wake's command id. */
  readonly id: string;
  readonly event: CompletionWebhookEvent;
  readonly runId: RunId;
  readonly requestId?: string;
  /** The run status, `waiting` for a question, `unreachable` for an outage. */
  readonly status: string;
  readonly title: string | null;
  readonly summary: string;
  readonly excerpt: string | null;
  readonly prUrl: string | null;
}

export interface CompletionWebhookPayload {
  readonly id: string;
  readonly event: CompletionWebhookEvent;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly requestId?: string;
  readonly host: string | null;
  readonly title: string | null;
  readonly status: string;
  readonly summary: string;
  readonly excerpt: string | null;
  readonly prUrl?: string;
  /** Null when the launch came from outside any GOAT thread. */
  readonly launcherThreadId: ThreadId | null;
  readonly at: string;
}

export const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const SEEN_LIMIT = 500;
/** Store names for inline targets' signing secrets; one per launch that passed a secretRef. */
const INLINE_SECRET_PREFIX = "completion-webhook-watch-";

/** The `notifyTarget` launch argument. Exactly one of name and url. */
export const NotifyTargetInput = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "A target configured in server settings (completionWebhook.targets.<name>).",
  }),
  url: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "An http(s) URL to post this launch's reports to, instead of a named target.",
  }),
  secretRef: Schema.optional(SecretRef).annotate({
    description:
      "With url: a signing secret the user entered through request_secret. Posts carry x-goat-signature: sha256=<hex HMAC of the body>. It is consumed by this launch. Omit to post unsigned.",
  }),
});
export type NotifyTargetInput = typeof NotifyTargetInput.Type;

/** How a launch's watch reaches a webhook, as stored on the watch. */
export interface WebhookRoute {
  readonly notifyWebhook: boolean;
  readonly webhookTarget: LaunchWatchWebhookTarget | null;
}

/** A launch's webhook choice that cannot be honored; the launch is refused before it starts. */
export class CompletionWebhookTargetError extends Data.TaggedError("CompletionWebhookTargetError")<{
  readonly message: string;
}> {}

export function completionWebhookPayload(
  watch: LaunchWatch,
  report: CompletionWebhookReport,
  at: number,
): CompletionWebhookPayload {
  return {
    id: report.id,
    event: report.event,
    threadId: watch.threadId,
    runId: report.runId,
    ...(report.requestId === undefined ? {} : { requestId: report.requestId }),
    host: watch.host,
    title: report.title ?? watch.title,
    status: report.status,
    summary: report.summary,
    excerpt: report.excerpt,
    ...(report.prUrl === null ? {} : { prUrl: report.prUrl }),
    launcherThreadId: watch.launcherThreadId,
    at: DateTime.formatIso(DateTime.makeUnsafe(at)),
  };
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** `sha256=<hex>` HMAC of the exact body, the scheme GOAT also accepts on inbound webhooks. */
function signCompletionWebhook(body: string, secret: string): string {
  return `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * The receiver a watch's reports go to now, without its secret. A watch with a target goes only
 * there; one without goes to the default URL when its launch opted in or the settings take it.
 */
function receiverFor(
  settings: CompletionWebhookSettings,
  watch: LaunchWatch,
): { readonly url: string; readonly secret: string | { readonly secretName: string } } | null {
  if (!settings.enabled) return null;
  const target = watch.webhookTarget;
  if (target?.type === "named") {
    const named = settings.targets[target.name];
    return named === undefined || named.url.length === 0
      ? null
      : { url: named.url, secret: named.secret };
  }
  if (target?.type === "inline") {
    return {
      url: target.url,
      secret: target.secretName === null ? "" : { secretName: target.secretName },
    };
  }
  const optedIn =
    watch.notifyWebhook ||
    settings.allLaunches ||
    (watch.launcherThreadId === null && settings.externalLaunches);
  return optedIn && settings.url.length > 0 ? { url: settings.url, secret: settings.secret } : null;
}

/** Whether a launch from outside any thread should get a launcherless watch. */
function completionWebhookWatchesExternal(
  settings: CompletionWebhookSettings,
  route: WebhookRoute,
): boolean {
  if (!settings.enabled) return false;
  if (route.webhookTarget !== null) return true;
  return isHttpUrl(settings.url) && (route.notifyWebhook || settings.externalLaunches);
}

const isHttpUrl = (url: string) => {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/** Network failures, timeouts and these statuses are retried; any other non-2xx is final. */
const retryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** `skipped` means nothing was sent: the webhook is off, not wanted for this watch, or misconfigured. */
type Attempt = "delivered" | "retry" | "stop" | "skipped";

export interface CompletionWebhookShape {
  /** Starts delivering one report in the background; a report id already seen is dropped. */
  readonly notify: (watch: LaunchWatch, report: CompletionWebhookReport) => Effect.Effect<void>;
  /**
   * Whether a launch from outside any thread is watched: the webhook is on and
   * the launch chose a target or asked for the default (notifyWebhook), or the
   * settings watch every such launch.
   */
  readonly watchesExternal: (route: WebhookRoute) => Effect.Effect<boolean>;
  /**
   * Whether this watch's reports would be posted now. Settings that cannot be
   * read count as yes, so a passing read failure makes nothing drop a watch.
   */
  readonly wants: (watch: LaunchWatch) => Effect.Effect<boolean>;
  /**
   * Checks a launch's webhook choice before the launch starts, and keeps an
   * inline target's secret. `projectId` is the calling thread's project, where
   * a secretRef was entered. Release the result if the launch records no watch.
   */
  readonly resolveRoute: (input: {
    readonly notifyWebhook: boolean | undefined;
    readonly notifyOnCompletion: boolean | undefined;
    readonly notifyTarget: NotifyTargetInput | undefined;
    readonly projectId: ProjectId | null;
  }) => Effect.Effect<WebhookRoute, CompletionWebhookTargetError>;
  /** Deletes the signing secret an inline target kept, once no watch uses it. */
  readonly release: (target: LaunchWatchWebhookTarget | null) => Effect.Effect<void>;
}

export class CompletionWebhook extends Context.Service<CompletionWebhook, CompletionWebhookShape>()(
  "goat/mcp/completionWebhook",
) {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const secretRequests = yield* SecretRequests.SecretRequests;
  const scope = yield* Effect.scope;
  /** Report ids delivered or in flight, oldest first. */
  const seen = new Set<string>();

  const remember = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const oldest = seen.values().next();
    if (seen.size > SEEN_LIMIT && !oldest.done) seen.delete(oldest.value);
    return true;
  };

  /** Settings are read per attempt, so turning the webhook off or rotating its secret applies to retries. */
  const attempt = (
    watch: LaunchWatch,
    report: CompletionWebhookReport,
    body: string,
    keptSecret: string | undefined,
  ): Effect.Effect<Attempt> =>
    Effect.gen(function* () {
      const settings = (yield* serverSettings.getSettings).completionWebhook;
      const receiver = receiverFor(settings, watch);
      if (receiver === null) return "skipped" satisfies Attempt;
      if (!isHttpUrl(receiver.url)) {
        yield* Effect.logWarning("completion webhook: url is not http(s)", { id: report.id });
        return "skipped" satisfies Attempt;
      }
      const secret =
        typeof receiver.secret === "string"
          ? receiver.secret
          : (keptSecret ?? (yield* readInlineSecret(receiver.secret.secretName)));
      // A signed target whose secret is gone must not start posting unsigned.
      if (secret === null) {
        yield* Effect.logWarning("completion webhook: target secret missing", { id: report.id });
        return "stop" satisfies Attempt;
      }
      const response = yield* http.execute(
        HttpClientRequest.post(receiver.url).pipe(
          HttpClientRequest.setHeaders({
            "x-goat-event": report.event,
            "x-goat-delivery": report.id,
            ...(secret.length === 0
              ? {}
              : { "x-goat-signature": signCompletionWebhook(body, secret) }),
          }),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );
      if (response.status >= 200 && response.status < 300) return "delivered" satisfies Attempt;
      yield* Effect.logWarning("completion webhook: refused", {
        id: report.id,
        status: response.status,
      });
      return retryableStatus(response.status) ? "retry" : "stop";
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.map((result) => (result._tag === "Some" ? result.value : ("retry" as const))),
      Effect.catch((cause) =>
        Effect.logWarning("completion webhook: post failed", { id: report.id, cause }).pipe(
          Effect.as("retry" as const),
        ),
      ),
    );

  const readInlineSecret = (secretName: string) =>
    secretStore
      .get(secretName)
      .pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.map(Option.getOrNull),
      );

  const deliver = (
    watch: LaunchWatch,
    report: CompletionWebhookReport,
    at: number,
    keptSecret: string | undefined,
  ) =>
    Effect.gen(function* () {
      const body = encodeJson(completionWebhookPayload(watch, report, at));
      for (let tries = 1; tries <= MAX_ATTEMPTS; tries++) {
        const outcome = yield* attempt(watch, report, body, keptSecret);
        if (outcome === "delivered" || outcome === "stop") return;
        if (outcome === "skipped") {
          // Never sent, so a later report of the same event may still go out.
          if (tries === 1) seen.delete(report.id);
          return;
        }
        if (tries < MAX_ATTEMPTS) yield* Effect.sleep(backoffMs(tries));
      }
      yield* Effect.logWarning("completion webhook: gave up", { id: report.id });
    });

  const notify: CompletionWebhookShape["notify"] = (watch, report) =>
    Effect.gen(function* () {
      if (!remember(report.id)) return;
      const at = yield* Clock.currentTimeMillis;
      // An inline target's secret goes with its watch, which may end while this report still
      // retries; read it now, while the watch is certainly saved. It never rotates.
      const target = watch.webhookTarget;
      const keptSecret =
        target?.type === "inline" && target.secretName !== null
          ? yield* readInlineSecret(target.secretName).pipe(
              Effect.map((value) => value ?? undefined),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      // Reports arrive from the launch watch's uninterruptible section; shutdown must still end retries.
      yield* deliver(watch, report, at, keptSecret).pipe(
        Effect.interruptible,
        Effect.forkIn(scope),
      );
    });

  const watchesExternal: CompletionWebhookShape["watchesExternal"] = (route) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => completionWebhookWatchesExternal(settings.completionWebhook, route)),
      Effect.catch((cause) =>
        Effect.logWarning("completion webhook: settings unreadable", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const wants: CompletionWebhookShape["wants"] = (watch) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => {
        const receiver = receiverFor(settings.completionWebhook, watch);
        return receiver !== null && isHttpUrl(receiver.url);
      }),
      Effect.catch((cause) =>
        Effect.logWarning("completion webhook: settings unreadable", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );

  const refuse = (message: string) => Effect.fail(new CompletionWebhookTargetError({ message }));

  const resolveRoute: CompletionWebhookShape["resolveRoute"] = (input) =>
    Effect.gen(function* () {
      const target = input.notifyTarget;
      if (target === undefined) {
        return { notifyWebhook: input.notifyWebhook ?? false, webhookTarget: null };
      }
      if (input.notifyWebhook === false) {
        return yield* refuse("notifyTarget sends reports to a webhook; drop notifyWebhook:false.");
      }
      if (input.notifyOnCompletion === false) {
        return yield* refuse(
          "notifyTarget reports through the launch watch; drop notifyOnCompletion:false.",
        );
      }
      if ((target.name === undefined) === (target.url === undefined)) {
        return yield* refuse("notifyTarget needs exactly one of name and url.");
      }
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((all) => all.completionWebhook),
        Effect.catch(() => refuse("Server settings could not be read; try again.")),
      );
      if (!settings.enabled) {
        return yield* refuse(
          "Completion webhooks are off on this server (completionWebhook.enabled).",
        );
      }
      if (target.name !== undefined) {
        if (target.secretRef !== undefined) {
          return yield* refuse(
            "A named target signs with the secret in server settings; pass secretRef only with url.",
          );
        }
        const named = settings.targets[target.name];
        if (named === undefined) {
          const known = Object.keys(settings.targets);
          return yield* refuse(
            `Unknown notify target "${target.name}". ${
              known.length === 0
                ? "This server has no named targets (completionWebhook.targets)."
                : `Configured targets: ${known.join(", ")}.`
            }`,
          );
        }
        if (!isHttpUrl(named.url)) {
          return yield* refuse(`Notify target "${target.name}" has no http(s) url in settings.`);
        }
        return {
          notifyWebhook: false,
          webhookTarget: { type: "named", name: target.name },
        } satisfies WebhookRoute;
      }
      const url = target.url ?? "";
      if (!isHttpUrl(url)) return yield* refuse("notifyTarget.url must be an http(s) URL.");
      if (target.secretRef === undefined) {
        return {
          notifyWebhook: false,
          webhookTarget: { type: "inline", url, secretName: null },
        } satisfies WebhookRoute;
      }
      if (input.projectId === null) {
        return yield* refuse(
          "secretRef comes from request_secret in a GOAT thread; call from one.",
        );
      }
      const value = yield* secretRequests
        .consume({ ref: target.secretRef, projectId: input.projectId })
        .pipe(Effect.catch((error) => refuse(`notifyTarget.secretRef: ${error.message}`)));
      const secretName = `${INLINE_SECRET_PREFIX}${NodeCrypto.randomUUID()}`;
      yield* secretStore
        .set(secretName, new TextEncoder().encode(value))
        .pipe(Effect.catch(() => refuse("The signing secret could not be stored; try again.")));
      return {
        notifyWebhook: false,
        webhookTarget: { type: "inline", url, secretName },
      } satisfies WebhookRoute;
    });

  const release: CompletionWebhookShape["release"] = (target) =>
    target?.type !== "inline" || target.secretName === null
      ? Effect.void
      : secretStore
          .remove(target.secretName)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("completion webhook: target secret not deleted", { cause }),
            ),
          );

  return CompletionWebhook.of({ notify, watchesExternal, wants, resolveRoute, release });
});

export const layer = Layer.effect(CompletionWebhook, make);
