import type {
  PreviewAppearancePreference,
  PreviewSessionSnapshot,
  PreviewViewportSetting,
} from "@goat/contracts";
import type { CDPSession, Page } from "playwright-core";
import type { ActionChannel } from "./actionChannel.ts";
import { fixedViewportSize } from "./ServerBrowserViewport.ts";

export const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const RENDER_SCALE = 2;
type ViewportTab = {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly desktop: unknown | null;
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
};
const mutate = <A>(channel: ActionChannel | undefined, work: () => A) =>
  channel ? channel.call(work) : work();

export const layoutSize = (tab: ViewportTab) => {
  const size = tab.page.viewportSize();
  if (!size || tab.desktop) return size;
  return {
    width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
    height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
  };
};

const applyZoom = async (tab: ViewportTab, channel?: ActionChannel) => {
  if (tab.desktop) return;
  const size = tab.page.viewportSize();
  if (!size) return;
  if (tab.zoomFactor === 1) {
    await mutate(channel, () => tab.page.setViewportSize(size));
    return;
  }
  const layout = layoutSize(tab);
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

export const broadcastViewport = (tab: ViewportTab) => {
  const size = layoutSize(tab);
  if (!size) return;
  for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
};

export const applySetting = async (
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
  await mutate(channel, () => tab.page.setViewportSize({ width: size.width, height: size.height }));
  await applyZoom(tab, channel);
  broadcastViewport(tab);
};

export const applyRendering = async (
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
    broadcastViewport(tab);
  }
};
