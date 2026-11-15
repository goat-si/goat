import { type PreviewAutomationStatus, type PreviewTabId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";
import type * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import { scope } from "./ServerBrowserTestFixtures.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const certificateError = {
  url: "https://device.local/",
  code: -202,
  description: "ERR_CERT_AUTHORITY_INVALID",
};

/** A main-frame navigation request to certificateError.url that fails like Chromium reports it. */
export const certificateFailure = (page: unknown) => ({
  url: () => certificateError.url,
  method: () => "GET",
  redirectedFrom: () => null,
  isNavigationRequest: () => true,
  frame: () => page,
  failure: () => ({ errorText: "net::ERR_CERT_AUTHORITY_INVALID" }),
});

/** Each read names the page that failed, not Chromium's error page, and why it failed. */
export const assertShowsLoadError = <E>(...reads: ReadonlyArray<Effect.Effect<object, E>>) =>
  Effect.forEach(reads, (read) =>
    read.pipe(
      Effect.map((result) =>
        expect(result).toMatchObject({ url: certificateError.url, loadError: certificateError }),
      ),
    ),
  );

/** A navigation that commits Chromium's error page fails with the page and the reason. */
export const assertNavigationFails = (
  broker: Broker.PreviewAutomationBroker["Service"],
  tabId: PreviewTabId,
) =>
  Effect.gen(function* () {
    const error = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url: certificateError.url },
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "PreviewAutomationExecutionError",
      reason: `Navigation to ${certificateError.url} failed: ${certificateError.description}`,
    });
  });

/**
 * An open whose desktop page failed before automation attached fails like any open whose page
 * never connected: it names the new tab, which stays open, and keeps the URL's secrets out.
 */
export const assertDesktopOpenFails = (
  broker: Broker.PreviewAutomationBroker["Service"],
  originalTabId: PreviewTabId,
) =>
  Effect.gen(function* () {
    const manager = yield* Manager.PreviewManager;
    const channel = yield* DesktopChannel.DesktopBrowserChannel;
    const url = "https://user:secret@device.local/?token=private#fragment";
    using _failure = vi.spyOn(channel, "loadFailure").mockReturnValue({ ...certificateError, url });
    const error = yield* broker
      .invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url, reuseExistingTab: false, open: false, session: "profile" },
      })
      .pipe(Effect.flip);
    const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
    const opened = sessions.find((session) => session.tabId !== originalTabId)?.tabId;
    expect(error).toMatchObject({
      _tag: "PreviewAutomationExecutionError",
      reason: `Navigation to ${certificateError.url} failed: ${certificateError.description}; its new tab ${opened} is still open.`,
      unloadedTab: { tabId: opened, loadError: certificateError.description },
    });
    expect(encodeJson(error)).not.toMatch(/secret|private|fragment/);
    expect(sessions).toHaveLength(2);
  });
