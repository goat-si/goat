import type { Page } from "playwright-core";
import { startBrowserInputEvidence } from "./BrowserInputEvidence.ts";
import type { ActionChannel } from "./actionChannel.ts";

type Evidence = { readonly finish: () => Promise<boolean> };

export function makeBrowserInputRetention(
  start: () => Promise<Evidence>,
  consent: () => Promise<boolean>,
  safe: () => boolean,
) {
  let evidence: Evidence | undefined;
  return {
    onFocus: async () => {
      try {
        if ((await consent()) && safe()) evidence = await start();
      } catch {
        evidence = undefined;
      }
    },
    finish: async () => {
      if (evidence === undefined) return false;
      const captured = evidence;
      evidence = undefined;
      try {
        const observed = await captured.finish();
        return observed && (await consent()) && safe();
      } catch {
        return false;
      }
    },
  };
}

export function recordBrowserTypedAction<T extends { readonly page: Page }, A>(
  tab: T,
  text: string,
  channel: ActionChannel,
  consent: () => Promise<boolean>,
  safe: () => boolean,
  record: (
    tab: T,
    action: string,
    execute: () => Promise<A>,
    details: { typedText: string; finishRetention: () => Promise<boolean> },
  ) => Promise<A>,
  execute: (onHistoryFocus: () => Promise<void>) => Promise<A>,
) {
  const retention = makeBrowserInputRetention(
    () => startBrowserInputEvidence(tab.page, channel),
    consent,
    safe,
  );
  return record(tab, "type", () => execute(retention.onFocus), {
    typedText: text,
    finishRetention: retention.finish,
  });
}
