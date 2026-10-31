import type * as Effect from "effect/Effect";
import type { Page } from "playwright-core";
import { constVoid } from "effect/Function";
import * as AgentTabState from "./agentTabState.ts";
import type { PopupNavigationRequests } from "./PopupNavigationRequests.ts";
import type { makeBlockedTabFence } from "./blockedTabFence.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";
import type { BlockedTabRun } from "./blockedTabFence.ts";

export const closeCutAgentPopup = async (input: {
  readonly agentControlled: boolean;
  readonly signal?: AbortSignal;
  readonly visits: ReadonlyArray<{ readonly url: string; readonly run: BlockedTabRun }>;
  readonly url: string;
  readonly runSignal: (runId: string) => AbortSignal | undefined;
  readonly assertUrl: (url: string) => Promise<void>;
}) => {
  // Person-controlled and unattributed popups are adopted as ordinary tab bookkeeping.
  if (!input.agentControlled) return false;
  if (
    input.signal?.aborted ||
    input.visits.some((visit) => input.runSignal(visit.run.runId)?.aborted)
  )
    return true;
  for (const url of [...input.visits.map((visit) => visit.url), input.url]) {
    try {
      await input.assertUrl(url);
    } catch (cause) {
      if (cause instanceof BrowserControlInterrupted && cause.reason === "blocked_url") return true;
      throw cause;
    }
    if (
      input.signal?.aborted ||
      input.visits.some((visit) => input.runSignal(visit.run.runId)?.aborted)
    )
      return true;
  }
  return input.signal?.aborted === true;
};

type Fence = Effect.Success<ReturnType<typeof makeBlockedTabFence>>;
type Opener = Parameters<Fence["signal"]>[0] & {
  readonly control: import("./SessionControl.ts").SessionControl;
  readonly popups: AgentTabState.PopupAttribution;
  readonly agentOperating: boolean;
};

export const inspectPopup = async (
  opener: Opener,
  popup: Page,
  fence: Fence,
  navigation: PopupNavigationRequests,
  atLimit: (agent: string) => boolean,
  now: () => number,
) => {
  const run = fence.capture(opener.threadId);
  const signals = [
    fence.runSignal(opener.threadId, run?.runId),
    fence.signal(opener, run?.runId),
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const targetId = await AgentTabState.targetIdOf(popup).catch(() => undefined);
  const opening = opener.popups.opening(targetId);
  const agentId = opener.popups.owner(targetId, opener, now());
  const visits = navigation.take(popup).flatMap((visit) => {
    const run = visit.runs.get(opener.threadId);
    return run ? [{ url: visit.url, run }] : [];
  });
  for (const visit of visits) fence.observe(opener, visit.url, visit.run);
  fence.observe(opener, popup.url());
  if (opening?.signal) signals.push(opening.signal);
  const signal = AbortSignal.any(signals);
  const agentControlled = opening?.agentControlled === true && agentId !== null;
  const refused =
    opener.closing ||
    (agentId !== null && atLimit(agentId)) ||
    (await closeCutAgentPopup({
      agentControlled,
      signal,
      visits,
      url: popup.url(),
      runSignal: (runId) => fence.runSignal(opener.threadId, runId),
      assertUrl: fence.assertUrl,
    }));
  if (refused) await popup.close().catch(constVoid);
  return { agentId, visits, refused, signal: agentControlled ? signal : undefined };
};

export interface AdoptedPage {
  readonly page: Page;
  readonly openerTabId: string;
  readonly signal?: AbortSignal;
  readonly release: () => void;
  readonly visits: ReadonlyArray<{ readonly url: string; readonly run: BlockedTabRun }>;
}

export const closePopupOnAbort = (page: Page, signal?: AbortSignal) => {
  if (!signal) return () => {};
  const close = () => void page.close().catch(constVoid);
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  return () => signal.removeEventListener("abort", close);
};
