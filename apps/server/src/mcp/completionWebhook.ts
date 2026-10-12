// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import type { CompletionWebhookSettings, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import { backoffMs, type LaunchWatch } from "./launchWatch.ts";

/**
 * Posts launch watch reports to the `completionWebhook` server setting, so an
 * agent outside GOAT hears what the launcher thread hears. Delivery runs on its
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

function completionWebhookWanted(settings: CompletionWebhookSettings, watch: LaunchWatch): boolean {
  return (
    settings.enabled &&
    settings.url.length > 0 &&
    (watch.notifyWebhook ||
      settings.allLaunches ||
      (watch.launcherThreadId === null && settings.externalLaunches))
  );
}

/** Whether a launch from outside any thread should get a launcherless watch. */
function completionWebhookWatchesExternal(
  settings: CompletionWebhookSettings,
  requested: boolean,
): boolean {
  return settings.enabled && isHttpUrl(settings.url) && (requested || settings.externalLaunches);
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
   * the launch asked for it (notifyWebhook) or the settings watch every such launch.
   */
  readonly watchesExternal: (requested: boolean) => Effect.Effect<boolean>;
  /**
   * Whether this watch's reports would be posted now. Settings that cannot be
   * read count as yes, so a passing read failure makes nothing drop a watch.
   */
  readonly wants: (watch: LaunchWatch) => Effect.Effect<boolean>;
}

export class CompletionWebhook extends Context.Service<CompletionWebhook, CompletionWebhookShape>()(
  "t3/mcp/completionWebhook",
) {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
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
  ): Effect.Effect<Attempt> =>
    Effect.gen(function* () {
      const settings = (yield* serverSettings.getSettings).completionWebhook;
      if (!completionWebhookWanted(settings, watch)) return "skipped" satisfies Attempt;
      if (!isHttpUrl(settings.url)) {
        yield* Effect.logWarning("completion webhook: url is not http(s)", { url: settings.url });
        return "skipped" satisfies Attempt;
      }
      const response = yield* http.execute(
        HttpClientRequest.post(settings.url).pipe(
          HttpClientRequest.setHeaders({
            "x-goat-event": report.event,
            "x-goat-delivery": report.id,
            ...(settings.secret.length === 0
              ? {}
              : { "x-goat-signature": signCompletionWebhook(body, settings.secret) }),
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

  const deliver = (watch: LaunchWatch, report: CompletionWebhookReport, at: number) =>
    Effect.gen(function* () {
      const body = encodeJson(completionWebhookPayload(watch, report, at));
      for (let tries = 1; tries <= MAX_ATTEMPTS; tries++) {
        const outcome = yield* attempt(watch, report, body);
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
      // Reports arrive from the launch watch's uninterruptible section; shutdown must still end retries.
      yield* deliver(watch, report, at).pipe(Effect.interruptible, Effect.forkIn(scope));
    });

  const watchesExternal: CompletionWebhookShape["watchesExternal"] = (requested) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) =>
        completionWebhookWatchesExternal(settings.completionWebhook, requested),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("completion webhook: settings unreadable", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const wants: CompletionWebhookShape["wants"] = (watch) =>
    serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          completionWebhookWanted(settings.completionWebhook, watch) &&
          isHttpUrl(settings.completionWebhook.url),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("completion webhook: settings unreadable", { cause }).pipe(
          Effect.as(true),
        ),
      ),
    );

  return CompletionWebhook.of({ notify, watchesExternal, wants });
});

export const layer = Layer.effect(CompletionWebhook, make);
