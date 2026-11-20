import { migratingStorage } from "@goat/client-runtime/storage-migration";
import type { DesktopBridge } from "@goat/contracts";
import { safeErrorLogAttributes } from "@goat/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  invalidateCustomThemes,
  canonicalThemePreference,
  isKnownThemePreference,
  getThemePreferenceMode,
  getThemeDefinition,
  getThemePreviewAppearance,
  parseThemeHalves,
  resolveDesktopTheme,
  resolveThemeAppearance,
  resolveThemeHalf,
  subscribeToThemePreview,
  THEME_PREVIEW_ID,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  ThemePreference,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "../themePalette";
import { applyThemeCss } from "../themeCss";
import { isThemeCssResourceError } from "@goat/shared/themeCssErrors";
import { setThemeCssRejected } from "../themeCssRejection";

let themeValidationRevision = 0;

type Theme = ThemePreference;
type ThemeSnapshot = {
  theme: Theme;
  resolvedTheme: ThemeAppearance;
  systemDark: boolean;
  followSystem: boolean;
  appearanceMode: ThemePreferenceMode;
  themeHalves: ThemeHalves | null;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "goat:theme";
const LAST_VALID_THEME_STORAGE_KEY = "goat:theme-last-valid:v1";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  resolvedTheme: "light",
  systemDark: false,
  followSystem: true,
  appearanceMode: "system",
  themeHalves: null,
};

export function readThemeHalves(): ThemeHalves | null {
  return readStoredThemeHalves();
}

/** Capture before setTheme clears the mix; unresolved published ids may still be valid. */
export function readThemeHalvesRaw(): { light?: string; dark?: string } {
  if (typeof window === "undefined") return {};
  return readStoredThemeHalvesRaw();
}

function readStoredThemeHalves(): ThemeHalves | null {
  if (typeof window === "undefined") return null;
  try {
    return parseThemeHalves(
      migratingStorage(window.localStorage).getItem(THEME_HALVES_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

// Pruning unresolved published palettes would erase their halves when merging.
function readStoredThemeHalvesRaw(): { light?: string; dark?: string } {
  try {
    const value: unknown = JSON.parse(
      migratingStorage(window.localStorage).getItem(THEME_HALVES_STORAGE_KEY) ?? "null",
    );
    if (value === null || typeof value !== "object") return {};
    const halves: { light?: string; dark?: string } = {};
    for (const appearance of ["light", "dark"] as const) {
      const themeId = (value as Record<string, unknown>)[appearance];
      if (typeof themeId === "string") halves[appearance] = themeId;
    }
    return halves;
  } catch {
    return {};
  }
}

function themeHalvesSignature(halves: ThemeHalves | null): string {
  return `${halves?.light ?? ""}|${halves?.dark ?? ""}`;
}

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedError<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let snapshotStale = true;
let lastDesktopTheme: "light" | "dark" | "system" | null = null;
let lastAppliedTheme: Omit<ThemeSnapshot, "resolvedTheme"> | null = null;
let lastValidTheme: Omit<ThemeSnapshot, "resolvedTheme"> | null = readLastValidTheme();
let themeStorageReadFailure: ThemeStorageError | null = null;

function readLastValidTheme(): Omit<ThemeSnapshot, "resolvedTheme"> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = migratingStorage(window.localStorage).getItem(LAST_VALID_THEME_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (typeof selection.theme !== "string" || !isKnownThemePreference(selection.theme))
      return null;
    if (
      typeof selection.appearanceMode !== "string" ||
      !isThemePreferenceMode(selection.appearanceMode)
    )
      return null;
    const themeHalves = parseThemeHalves(JSON.stringify(selection.themeHalves));
    const followSystem = selection.appearanceMode === "system";
    return {
      theme: canonicalThemePreference(selection.theme),
      appearanceMode: selection.appearanceMode,
      followSystem,
      systemDark: followSystem && getSystemDark(),
      themeHalves,
    };
  } catch {
    return null;
  }
}

function emitChange() {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function readStoredFollowSystem(theme: Theme): boolean {
  if (typeof window === "undefined") return theme === "system";

  try {
    const raw = migratingStorage(window.localStorage).getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {}

  return theme === "system";
}

function isThemePreferenceMode(value: string | null): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function readAppearanceModePreference(theme: Theme): ThemePreferenceMode {
  if (typeof window !== "undefined") {
    try {
      const raw = migratingStorage(window.localStorage).getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
      if (isThemePreferenceMode(raw)) return raw;
    } catch {}
  }

  if (readStoredFollowSystem(theme)) return "system";
  return getThemePreferenceMode(theme) ?? "light";
}

function writeAppearanceModePreference(appearanceMode: ThemePreferenceMode): void {
  if (typeof window === "undefined") return;
  try {
    migratingStorage(window.localStorage).setItem(
      THEME_APPEARANCE_MODE_STORAGE_KEY,
      appearanceMode,
    );
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
      cause,
    });
  }
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = migratingStorage(window.localStorage).getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw !== null && isKnownThemePreference(raw)) {
    return canonicalThemePreference(raw);
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    migratingStorage(window.localStorage).setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
    return;
  }
  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}

function applyTheme(
  theme: Theme,
  { suppressTransitions = false, preservePreview = true, validated = false } = {},
) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (preservePreview && document.documentElement.dataset?.themeId === THEME_PREVIEW_ID) {
    return;
  }
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.followSystem === followSystem &&
    lastAppliedTheme.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastAppliedTheme.themeHalves) === themeHalvesSignature(themeHalves)
  ) {
    syncDesktopTheme(theme, followSystem, appearanceMode);
    return;
  }

  const resolvedAppearance = resolveThemeAppearance(
    theme,
    systemDark,
    followSystem,
    appearanceMode,
    themeHalves,
  );
  const resolvedTheme = resolveThemeHalf(theme, themeHalves, resolvedAppearance);
  const css = getThemeDefinition(resolvedTheme)?.css;
  if (css && !validated) {
    const revision = ++themeValidationRevision;
    void import("@goat/shared/themeCssSanitizer")
      .then(({ sanitizeThemeCss }) => {
        sanitizeThemeCss(css);
        if (revision !== themeValidationRevision) return;
        setThemeCssRejected(false);
        applyTheme(theme, { suppressTransitions, preservePreview, validated: true });
      })
      .catch((error: unknown) => {
        if (revision !== themeValidationRevision) return;
        const previous = lastValidTheme;
        lastAppliedTheme = null;
        if (previous === null) {
          setThemeValidated("system");
        } else {
          try {
            writeThemePreference(previous.theme);
            writeAppearanceModePreference(previous.appearanceMode);
            const storage = migratingStorage(window.localStorage);
            if (previous.themeHalves === null) storage.removeItem(THEME_HALVES_STORAGE_KEY);
            else storage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(previous.themeHalves));
            applyTheme(previous.theme, { suppressTransitions: true });
            emitChange();
          } catch (cause) {
            console.error("Could not restore the previous theme", safeErrorLogAttributes(cause));
          }
        }
        setThemeCssRejected(isThemeCssResourceError(error) ? "resource" : "invalid");
      });
    return;
  }
  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  applyThemePalette(resolvedTheme, resolvedAppearance);
  void applyThemeCss(getThemeDefinition(resolvedTheme)?.css).catch((error: unknown) => {
    console.error("Could not apply theme CSS", safeErrorLogAttributes(error));
  });
  document.documentElement.classList.toggle("dark", resolvedAppearance === "dark");
  lastAppliedTheme = { theme, systemDark, followSystem, appearanceMode, themeHalves };
  lastValidTheme = lastAppliedTheme;
  try {
    migratingStorage(window.localStorage).setItem(
      LAST_VALID_THEME_STORAGE_KEY,
      JSON.stringify({ theme, appearanceMode, themeHalves }),
    );
  } catch (cause) {
    console.error("Could not save the last valid theme", safeErrorLogAttributes(cause));
  }
  syncBrowserChromeTheme();
  syncDesktopTheme(theme, followSystem, appearanceMode);
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    void document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves: ThemeHalves | null = readStoredThemeHalves(),
): Promise<void> {
  try {
    await bridge.setTheme(resolveDesktopTheme(theme, followSystem, appearanceMode, halves));
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

function syncDesktopTheme(
  theme: Theme,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const halves = readStoredThemeHalves();
  const desktopTheme = resolveDesktopTheme(theme, followSystem, appearanceMode, halves);
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === desktopTheme) {
    return;
  }

  lastDesktopTheme = desktopTheme;
  void syncDesktopThemePreference(bridge, theme, followSystem, appearanceMode, halves).catch(
    (cause: unknown) => {
      const error = isDesktopThemeSyncError(cause)
        ? cause
        : new DesktopThemeSyncError({ theme, cause });
      console.error(error.message, {
        theme: error.theme,
        ...safeErrorLogAttributes(error),
      });
      if (lastDesktopTheme === desktopTheme) {
        lastDesktopTheme = null;
      }
    },
  );
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  // Cache localStorage reads until signalled; useTheme calls this every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();

  const resolvedTheme = resolveThemeAppearance(
    theme,
    systemDark,
    followSystem,
    appearanceMode,
    themeHalves,
  );
  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.resolvedTheme === resolvedTheme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.followSystem === followSystem &&
    lastSnapshot.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastSnapshot.themeHalves) === themeHalvesSignature(themeHalves)
  ) {
    return lastSnapshot;
  }

  lastSnapshot = { theme, resolvedTheme, systemDark, followSystem, appearanceMode, themeHalves };
  return lastSnapshot;
}

export function getThemeSnapshot(): ThemeSnapshot {
  return getSnapshot();
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemAppearanceChange() {
  const storedTheme = getStored();
  if (readAppearanceModePreference(storedTheme) === "system") {
    applyTheme(storedTheme, { suppressTransitions: true });
  }
  emitChange();
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === STORAGE_KEY) {
    themeStorageReadFailure = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === THEME_FOLLOW_SYSTEM_STORAGE_KEY) {
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === THEME_APPEARANCE_MODE_STORAGE_KEY || e.key === THEME_HALVES_STORAGE_KEY) {
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === CUSTOM_THEMES_STORAGE_KEY || e.key === null) {
    if (e.key === null) themeStorageReadFailure = null;
    invalidateCustomThemes();
    lastAppliedTheme = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  }
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  if (!removeWindowListeners) {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

/** For code outside React (worker pools) that follows the rendered appearance. */
export function subscribeRenderedAppearance(listener: () => void): () => void {
  const unsubscribeTheme = subscribe(listener);
  const unsubscribePreview = subscribeToThemePreview(listener);
  return () => {
    unsubscribeTheme();
    unsubscribePreview();
  };
}

export function getRenderedAppearance(): ThemeAppearance {
  return getThemePreviewAppearance() ?? getSnapshot().resolvedTheme;
}

export function useRenderedAppearance() {
  const { resolvedTheme } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const previewAppearance = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewAppearance,
    () => null,
  );
  return previewAppearance ?? resolvedTheme;
}

export function setTheme(next: Theme): boolean {
  if (typeof window === "undefined") return false;
  const css = getThemeDefinition(next)?.css;
  const revision = ++themeValidationRevision;
  if (css) {
    void import("@goat/shared/themeCssSanitizer")
      .then(({ sanitizeThemeCss }) => {
        sanitizeThemeCss(css);
        if (revision !== themeValidationRevision) return;
        setThemeCssRejected(false);
        setThemeValidated(next);
      })
      .catch((error: unknown) => {
        if (revision === themeValidationRevision)
          setThemeCssRejected(isThemeCssResourceError(error) ? "resource" : "invalid");
      });
    return true;
  }
  setThemeCssRejected(false);
  return setThemeValidated(next);
}

function setThemeValidated(next: Theme): boolean {
  try {
    // Save the current mode first; inferring it from the new theme can switch dark to light.
    writeAppearanceModePreference(readAppearanceModePreference(getStored()));
    // A whole theme replaces the mix; retain it to restore on a failed preference write.
    const previousHalvesRaw = migratingStorage(window.localStorage).getItem(
      THEME_HALVES_STORAGE_KEY,
    );
    migratingStorage(window.localStorage).removeItem(THEME_HALVES_STORAGE_KEY);
    try {
      writeThemePreference(next);
    } catch (cause) {
      if (previousHalvesRaw !== null) {
        try {
          migratingStorage(window.localStorage).setItem(
            THEME_HALVES_STORAGE_KEY,
            previousHalvesRaw,
          );
        } catch {}
      }
      throw cause;
    }
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "write",
          storageKey: STORAGE_KEY,
          theme: next,
          cause,
        });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      theme: next,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  applyTheme(next, { suppressTransitions: true });
  emitChange();
  return true;
}

export function setAppearanceMode(nextAppearanceMode: ThemePreferenceMode): boolean {
  if (typeof window === "undefined") return false;
  try {
    writeAppearanceModePreference(nextAppearanceMode);
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "write",
          storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
          cause,
        });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  themeStorageReadFailure = null;
  applyTheme(getStored(), { suppressTransitions: true });
  emitChange();
  return true;
}

function setThemeHalf(appearance: ThemeAppearance, themeId: string | null): boolean {
  if (typeof window === "undefined") return false;
  const css = themeId === null ? undefined : getThemeDefinition(themeId)?.css;
  const revision = ++themeValidationRevision;
  if (css) {
    void import("@goat/shared/themeCssSanitizer")
      .then(({ sanitizeThemeCss }) => {
        sanitizeThemeCss(css);
        if (revision !== themeValidationRevision) return;
        setThemeCssRejected(false);
        setThemeHalfValidated(appearance, themeId);
      })
      .catch((error: unknown) => {
        if (revision === themeValidationRevision)
          setThemeCssRejected(isThemeCssResourceError(error) ? "resource" : "invalid");
      });
    return true;
  }
  setThemeCssRejected(false);
  return setThemeHalfValidated(appearance, themeId);
}

function setThemeHalfValidated(appearance: ThemeAppearance, themeId: string | null): boolean {
  try {
    const current = readStoredThemeHalvesRaw();
    const next: { light?: string; dark?: string } = { ...current };
    if (themeId === null) delete next[appearance];
    else next[appearance] = themeId;
    if (next.light === undefined && next.dark === undefined) {
      migratingStorage(window.localStorage).removeItem(THEME_HALVES_STORAGE_KEY);
    } else {
      migratingStorage(window.localStorage).setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(next));
    }
  } catch (cause) {
    const error = new ThemeStorageError({
      operation: "write",
      storageKey: THEME_HALVES_STORAGE_KEY,
      cause,
    });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  applyTheme(getStored(), { suppressTransitions: true });
  emitChange();
  return true;
}

function clearThemeHalves(): boolean {
  if (typeof window === "undefined") return false;
  try {
    migratingStorage(window.localStorage).removeItem(THEME_HALVES_STORAGE_KEY);
  } catch (cause) {
    const error = new ThemeStorageError({
      operation: "write",
      storageKey: THEME_HALVES_STORAGE_KEY,
      cause,
    });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  applyTheme(getStored(), { suppressTransitions: true });
  emitChange();
  return true;
}

function refreshTheme({ preservePreview = false } = {}): void {
  if (typeof window === "undefined") return;
  lastAppliedTheme = null;
  applyTheme(getStored(), { suppressTransitions: true, preservePreview });
  emitChange();
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { theme, resolvedTheme } = snapshot;

  const setFollowSystem = (nextFollowSystem: boolean): boolean => {
    const currentMode = readAppearanceModePreference(theme);
    const nextMode = nextFollowSystem
      ? "system"
      : currentMode === "system"
        ? (getThemePreferenceMode(theme) ?? "light")
        : currentMode;
    return setAppearanceMode(nextMode);
  };

  return {
    theme,
    setTheme,
    setAppearanceMode,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    refreshTheme,
    followSystem: snapshot.followSystem,
    appearanceMode: snapshot.appearanceMode,
    resolvedTheme,
    themeHalves: snapshot.themeHalves,
  } as const;
}
