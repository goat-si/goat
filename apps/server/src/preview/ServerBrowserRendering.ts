import type {
  PreviewAppearancePreference,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CDPSession, Page } from "playwright-core";
import type { ActionChannel } from "./actionChannel.ts";
import * as ViewerInput from "./ServerBrowserViewerInput.ts";
import { fixedViewportSize } from "./ServerBrowserViewport.ts";
import { initialTabChannel } from "./tabActionGate.ts";

export const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const RENDER_SCALE = 2;
/** A dialog blocks page script, so a desktop size read gives up after this. */
const DESKTOP_VIEWPORT_READ_TIMEOUT = "1 second";
type Size = { readonly width: number; readonly height: number };
type ViewportTab = {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly desktop: unknown | null;
  readonly dialog: unknown | null;
  readonly closing: boolean;
  readonly viewers: Iterable<{
    readonly requestedSize: { width: number; height: number; order: number } | null;
    readonly push: (output: {
      readonly _tag: "viewport";
      readonly width: number;
      readonly height: number;
    }) => void;
  }>;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: number;
  /** Last usable CSS size measured on the desktop. */
  desktopViewport: Size | null;
  desktopViewportRead: Promise<Size | null>;
  /** A read queued behind `desktopViewportRead`, shared by every caller that waits for it. */
  desktopViewportNext: Promise<Size | null> | null;
  /** A page resize or load since the last read started; status measures again. */
  desktopViewportStale: boolean;
  /** Counts page resizes, loads and dialog closes, so a caller can tell one landed during a read. */
  desktopViewportChanges: number;
};
const mutate = <A>(channel: ActionChannel | undefined, work: () => A) =>
  channel ? channel.call(work) : work();

export const makeRendering = (runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>) => {
  // Desktop pages have no Playwright viewport; an isolated world keeps page script
  // from overriding the CSS size. A failed read answers null and keeps the last usable size.
  const readDesktopViewport = async (tab: ViewportTab) => {
    const readSize = async () => {
      const { frameTree } = await tab.cdp.send("Page.getFrameTree");
      const { executionContextId } = await tab.cdp.send("Page.createIsolatedWorld", {
        frameId: frameTree.frame.id,
        worldName: "goat-preview-viewport",
      });
      const { result } = await tab.cdp.send("Runtime.evaluate", {
        expression: "({ width: innerWidth, height: innerHeight })",
        contextId: executionContextId,
        returnByValue: true,
      });
      return ViewerInput.asRecord(result.value);
    };
    const size = await runPromise(
      // A navigation can destroy the isolated world mid-read.
      Effect.promise(() => readSize().catch(() => null)).pipe(
        Effect.timeoutOption(DESKTOP_VIEWPORT_READ_TIMEOUT),
        Effect.map(Option.getOrNull),
      ),
    );
    const width = size?.width;
    const height = size?.height;
    if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0)
      return (tab.desktopViewport = { width, height });
    tab.desktopViewportStale = true;
    return null;
  };

  // Reads run one at a time, and callers that arrive during a read share the next one.
  const measureDesktopViewport = (tab: ViewportTab) =>
    (tab.desktopViewportNext ??= tab.desktopViewportRead.then(() => {
      tab.desktopViewportNext = null;
      tab.desktopViewportStale = false;
      return (tab.desktopViewportRead = readDesktopViewport(tab));
    }));

  const layoutSize = async (tab: ViewportTab) => {
    // A dialog blocks page script; its close measures again.
    if (tab.desktop) {
      return tab.dialog
        ? tab.desktopViewport
        : ((await measureDesktopViewport(tab)) ?? tab.desktopViewport);
    }
    const size = tab.page.viewportSize();
    if (!size) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  // Page resizes and loads mark the size stale; only then does status read the page. One
  // during the read it waits for can leave that answer old, so it reads once more.
  const desktopStatusViewport = async (tab: ViewportTab) => {
    const changes = tab.desktopViewportChanges;
    await (tab.desktopViewportStale || tab.dialog ? layoutSize(tab) : tab.desktopViewportRead);
    if (tab.desktopViewportChanges !== changes) await layoutSize(tab);
    return tab.desktopViewport;
  };

  const applyZoom = async (tab: ViewportTab, channel?: ActionChannel) => {
    if (tab.desktop) return;
    const size = tab.page.viewportSize();
    if (!size) return;
    if (tab.zoomFactor === 1) {
      await mutate(channel, () => tab.page.setViewportSize(size));
      return;
    }
    const layout = await layoutSize(tab);
    if (!layout) return;
    await mutate(channel, () =>
      tab.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: layout.width,
        height: layout.height,
        deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
        mobile: false,
      }),
    );
  };

  const broadcastViewport = async (tab: ViewportTab) => {
    const size = await layoutSize(tab);
    if (!size || tab.closing) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (
    tab: ViewportTab,
    setting: PreviewViewportSetting,
    channel?: ActionChannel,
  ) => {
    tab.setting = setting;

    if (tab.desktop) return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await mutate(channel, () =>
      tab.page.setViewportSize({ width: size.width, height: size.height }),
    );
    await applyZoom(tab, channel);
    await broadcastViewport(tab);
  };

  const applyRendering = async (
    tab: ViewportTab,
    snapshot: PreviewSessionSnapshot,
    channel?: ActionChannel,
  ) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await mutate(channel, () =>
        tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme }),
      );
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && !tab.desktop) {
      tab.zoomFactor = zoomFactor;
      await applyZoom(tab, channel);
      await broadcastViewport(tab);
    }
  };

  const applyOpenRendering = (
    tab: ViewportTab & Parameters<typeof initialTabChannel>[0],
    snapshot: PreviewSessionSnapshot,
    fence: Parameters<typeof initialTabChannel>[1] & {
      capture(threadId: string): { runId: string } | undefined;
    },
    signal?: AbortSignal,
  ) =>
    applyRendering(
      tab,
      snapshot,
      signal
        ? initialTabChannel(tab, fence, fence.capture(tab.threadId)?.runId, tab.page.url(), signal)
        : undefined,
    );

  return {
    layoutSize,
    measureDesktopViewport,
    desktopStatusViewport,
    broadcastViewport,
    applySetting,
    applyRendering,
    applyOpenRendering,
  };
};
