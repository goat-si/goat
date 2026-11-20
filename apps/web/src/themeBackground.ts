import {
  createEnvironmentRpcQueryAtomFamily,
  executeAtomQuery,
} from "@goat/client-runtime/state/runtime";
import { resolveAssetUrl } from "@goat/client-runtime/state/assets";
import { WS_METHODS, type EnvironmentId } from "@goat/contracts";
import { PUBLISHED_BACKGROUND_MAX_BYTES } from "@goat/contracts/themeRpc";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { connectionAtomRuntime } from "./connection/runtime";
import { environmentThemeDefinition } from "./hooks/useEnvironmentTheme";
import { getThemeSnapshot, subscribeRenderedAppearance } from "./hooks/useTheme";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { themeEnvironmentIdAtom } from "./state/desktopHostEnvironment";
import { primaryServerEnvironmentThemesAtom } from "./state/server";
import { environmentSession } from "./state/session";
import {
  getEnvironmentThemes,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
} from "./themePalette";
import { publishedBackgroundForSelection } from "./themeBackgroundSelection";
import { fetchThemeBackground } from "./themeBackgroundFetch";

const mint = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:theme:background",
  tag: WS_METHODS.themeBackgroundUrl,
  idleTtlMs: 0,
});
type Status = "idle" | "loading" | "ready" | "unavailable";
const MAX_BACKGROUND_CHUNKS = 4096;
let status: Status = "idle";
const listeners = new Set<() => void>();
let currentKey: string | null = null;
let controller: AbortController | null = null;
let currentUrl: string | null = null;
let removeConnectionListener: (() => void) | null = null;
let watchedEnvironment: EnvironmentId | null = null;

export function themeBackgroundStatus(): Status {
  return status;
}
export function subscribeThemeBackground(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function setStatus(next: Status) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}
function show(url: string | null) {
  const root = document.documentElement;
  if (url === null) {
    root.style.removeProperty("--theme-background-image");
    delete root.dataset.publishedBackground;
  } else {
    root.style.setProperty("--theme-background-image", `url("${url}")`);
    root.dataset.publishedBackground = "true";
  }
  if (currentUrl !== null) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
}

async function boundedImage(response: Response, signal: AbortSignal): Promise<Blob> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp")
    throw new Error("Invalid theme background type.");
  const length = Number(response.headers.get("content-length"));
  if (length > PUBLISHED_BACKGROUND_MAX_BYTES) throw new Error("Theme background is too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Theme background has no body.");
  const chunks: Array<Uint8Array<ArrayBuffer>> = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > PUBLISHED_BACKGROUND_MAX_BYTES) throw new Error("Theme background is too large.");
      if (chunks.length >= MAX_BACKGROUND_CHUNKS)
        throw new Error("Theme background has too many chunks.");
      chunks.push(Uint8Array.from(part.value));
    }
    return new Blob(chunks, { type });
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function load(
  environmentId: EnvironmentId,
  themeId: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    mint({ environmentId, input: { themeId, revision } }),
    { signal, refresh: true, reportFailure: false },
  );
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (result._tag === "Failure" || result.value === null)
    throw new Error("Theme background unavailable.");
  const connection = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (connection === null) throw new Error("Theme environment is disconnected.");
  const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("Invalid theme background URL.");
  const response = await fetchThemeBackground(url, signal);
  if (!response.ok) throw new Error("Theme background unavailable.");
  return URL.createObjectURL(await boundedImage(response, signal));
}

function refresh(force = false): void {
  if (typeof document === "undefined") return;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId !== watchedEnvironment) {
    removeConnectionListener?.();
    watchedEnvironment = environmentId;
    removeConnectionListener =
      environmentId === null
        ? null
        : appAtomRegistry.subscribe(
            environmentSession.preparedConnectionValueAtom(environmentId),
            () => refresh(true),
          );
  }
  const connection =
    environmentId === null
      ? null
      : Option.getOrNull(
          appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
  const snapshot = getThemeSnapshot();
  const id = resolveThemeHalf(snapshot.theme, snapshot.themeHalves, snapshot.resolvedTheme);
  const selected = getThemeDefinition(id);
  const published = getEnvironmentThemes();
  const themes = appAtomRegistry.get(primaryServerEnvironmentThemesAtom) ?? [];
  const target = publishedBackgroundForSelection(selected, published, themes);
  const authoritative = target && themes.find((theme) => theme.id === target.themeId);
  const matches =
    authoritative && selected && Equal.equals(selected, environmentThemeDefinition(authoritative));
  const key =
    environmentId && connection && target && matches
      ? JSON.stringify([environmentId, target.themeId, target.revision])
      : null;
  if (!force && key === currentKey) return;
  currentKey = key;
  controller?.abort();
  controller = null;
  show(null);
  if (key === null || environmentId === null || target === null) {
    setStatus("idle");
    return;
  }
  const next = new AbortController();
  controller = next;
  setStatus("loading");
  void load(environmentId, target.themeId, target.revision, next.signal)
    .then((url) => {
      if (next.signal.aborted || currentKey !== key) {
        URL.revokeObjectURL(url);
        return;
      }
      controller = null;
      show(url);
      setStatus("ready");
    })
    .catch(() => {
      if (next.signal.aborted || currentKey !== key) return;
      controller = null;
      setStatus("unavailable");
    });
}

export function retryThemeBackground(): void {
  refresh(true);
}
export function startThemeBackground(): () => void {
  const cleanups = [
    subscribeRenderedAppearance(() => refresh()),
    subscribeToCustomThemes(() => refresh()),
    appAtomRegistry.subscribe(themeEnvironmentIdAtom, () => refresh()),
    appAtomRegistry.subscribe(primaryServerEnvironmentThemesAtom, () => refresh()),
  ];
  refresh();
  return () => {
    for (const cleanup of cleanups) cleanup();
    removeConnectionListener?.();
    removeConnectionListener = null;
    watchedEnvironment = null;
    controller?.abort();
    controller = null;
    currentKey = null;
    show(null);
    setStatus("idle");
  };
}
