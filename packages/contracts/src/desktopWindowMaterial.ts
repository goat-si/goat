import * as Schema from "effect/Schema";

export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const GlassOpacity = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_GLASS_OPACITY,
    maximum: MAX_GLASS_OPACITY,
  }),
);
export type GlassOpacity = typeof GlassOpacity.Type;
export const DEFAULT_GLASS_OPACITY: GlassOpacity = 80;

export const DesktopWindowMaterialKind = Schema.Literals(["none", "macos-glass", "windows-mica"]);
export type DesktopWindowMaterialKind = typeof DesktopWindowMaterialKind.Type;

export const DesktopWindowMaterialCapability = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(true),
    material: Schema.Literals(["macos-glass", "windows-mica"]),
  }),
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.Literals(["platform", "os-version", "api-unavailable"]),
  }),
]);
export type DesktopWindowMaterialCapability = typeof DesktopWindowMaterialCapability.Type;

export const DesktopWindowMaterialReason = Schema.Literals([
  "active",
  "off",
  "opaque",
  "accessibility",
  "unrevealed",
  "fullscreen",
  "unsupported",
  "native-failed",
]);
export type DesktopWindowMaterialReason = typeof DesktopWindowMaterialReason.Type;

/** What the desktop main process actually applied to the window that asked. */
export const DesktopWindowMaterialState = Schema.Struct({
  revision: Schema.Int,
  capability: DesktopWindowMaterialCapability,
  enabled: Schema.Boolean,
  applied: DesktopWindowMaterialKind,
  reducedTransparency: Schema.Boolean,
  highContrast: Schema.Boolean,
  reason: DesktopWindowMaterialReason,
});
export type DesktopWindowMaterialState = typeof DesktopWindowMaterialState.Type;

// Optional so older desktop builds and plain browsers keep the CSS-only path.
export interface DesktopWindowMaterialBridge {
  getWindowMaterialState?: () => Promise<DesktopWindowMaterialState>;
  onWindowMaterialStateChanged?: (
    listener: (state: DesktopWindowMaterialState) => void,
  ) => () => void;
}
