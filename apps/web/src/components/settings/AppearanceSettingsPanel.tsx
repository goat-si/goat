import { msg, useGT, useMessages } from "gt-react";
import { DesktopWindowMaterialSetting } from "./DesktopWindowMaterialSetting";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@goat/contracts/settings";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../sidebar/brandChannel";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useTheme } from "../../hooks/useTheme";
import {
  clearCustomBackdrop,
  saveCustomBackdrop,
  useCustomBackdropPresence,
} from "../../appearance/glassBackdropStore";
import { useDesktopWindowMaterial } from "../../desktop/useDesktopWindowMaterial";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<
  Exclude<EnvironmentIdentificationMode, "artwork">,
  string
> = {
  pill: msg("Channel badge"),
  none: msg("None"),
};

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: msg("Comfortable"),
  wide: msg("Wide"),
  full: msg("Full"),
};

const BACKDROP_ERROR_MESSAGES = {
  "not-image": "Choose an image file.",
  "too-large": "That image is larger than 25 MB.",
  unreadable: "The image could not be read.",
} as const;

function BackgroundSettingsRow({ glassBackdrop }: { glassBackdrop: "built-in" | "custom" }) {
  const setting = useTranslatedSearchableSetting();
  const updateSettings = useUpdateScopedSettings();
  const presence = useCustomBackdropPresence();
  const { state } = useDesktopWindowMaterial();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const nativeMaterialApplied =
    state?.applied === "macos-glass" || state?.applied === "windows-mica";
  const description =
    error ??
    (nativeMaterialApplied
      ? "Your desktop shows through the window. This background is used when System glass is off."
      : glassBackdrop === "custom" && presence === "missing"
        ? "No image on this device. Showing the built-in background."
        : "Shown behind the glass panels.");

  return (
    <SettingsRow
      {...setting("appearance-background")}
      description={description}
      control={
        <div className="flex w-full flex-wrap items-center gap-2 sm:justify-end">
          <Select
            value={glassBackdrop}
            onValueChange={(value) => {
              if (value === "built-in" || value === "custom") {
                setError(null);
                updateSettings({ glassBackdrop: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Background">
              <SelectValue>{glassBackdrop === "custom" ? "Custom image" : "Built-in"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="built-in">Built-in</SelectItem>
              <SelectItem value="custom">Custom image</SelectItem>
            </SelectPopup>
          </Select>
          <input
            ref={fileInputRef}
            aria-label="Background image"
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void saveCustomBackdrop(file).then(
                (result) => {
                  if (result.ok) {
                    setError(null);
                    updateSettings({ glassBackdrop: "custom" });
                  } else {
                    setError(BACKDROP_ERROR_MESSAGES[result.error]);
                  }
                },
                () => setError(BACKDROP_ERROR_MESSAGES.unreadable),
              );
            }}
          />
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
            Choose image…
          </Button>
          {presence === "present" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void clearCustomBackdrop().then(() => {
                  setError(null);
                  updateSettings({ glassBackdrop: "built-in" });
                });
              }}
            >
              Remove
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function AppearanceSettingsPanel() {
  const gt = useGT();
  const m = useMessages();
  const setting = useTranslatedSearchableSetting();
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentIdentificationMode =
    settings.environmentIdentificationMode === "artwork"
      ? "pill"
      : settings.environmentIdentificationMode;
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title={gt("Colors & themes")}>
        <ThemeLibrary
          appearanceMode={appearanceMode}
          customThemes={customThemes}
          initialAppearance={resolvedTheme}
          refreshTheme={refreshTheme}
          isImportOpen={isImportThemeOpen}
          setAppearanceMode={setAppearanceMode}
          setTheme={setTheme}
          setThemeHalf={setThemeHalf}
          theme={theme}
          themeHalves={themeHalves}
          onImportOpenChange={setIsImportThemeOpen}
        />
      </SettingsSection>

      <SettingsSection id="appearance-interface" title={gt("Interface")}>
        <SettingsRow
          {...setting("appearance-style")}
          description={gt("Choose the look of panels, menus, and dialogs.")}
          resetAction={
            settings.appearancePreset !== DEFAULT_UNIFIED_SETTINGS.appearancePreset ? (
              <SettingResetButton
                label="style"
                onClick={() =>
                  updateSettings({ appearancePreset: DEFAULT_UNIFIED_SETTINGS.appearancePreset })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.appearancePreset}
              onValueChange={(value) => {
                if (value === "default" || value === "liquid-glass") {
                  updateSettings({ appearancePreset: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={setting("appearance-style").title}
              >
                <SelectValue>
                  {settings.appearancePreset === "liquid-glass"
                    ? gt("Liquid Glass")
                    : gt("Default")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="default">{gt("Default")}</SelectItem>
                <SelectItem value="liquid-glass">{gt("Liquid Glass")}</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        {settings.appearancePreset === "liquid-glass" ? (
          <BackgroundSettingsRow glassBackdrop={settings.glassBackdrop} />
        ) : null}

        <SettingsRow
          {...setting("setting-appearance-contrast")}
          description={gt("Adjust the contrast of colors and borders across the interface.")}
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label={setting("setting-appearance-contrast").title}
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...setting("setting-glass-opacity")}
          description={
            settings.appearancePreset === "liquid-glass"
              ? gt("Higher values make panels, menus, dialogs, and the composer more solid.")
              : gt("Higher values make menus, dialogs, and the composer more solid.")
          }
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label={setting("setting-glass-opacity").title}
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <DesktopWindowMaterialSetting />

        {showEnvironmentIdentification ? (
          <SettingsRow
            {...setting("environment-identification")}
            description={gt("Show a Dev or Nightly badge next to the GOAT logo.")}
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={environmentIdentificationMode}
                onValueChange={(value) => {
                  if (value === "pill" || value === "none") {
                    updateSettings({ environmentIdentificationMode: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={setting("environment-identification").title}
                >
                  <SelectValue>
                    {m(ENVIRONMENT_IDENTIFICATION_LABELS[environmentIdentificationMode])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {m(label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          {...setting("diff-color-scheme")}
          description={gt("Choose colors for additions and deletions, including change counts.")}
          resetAction={
            settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme ? (
              <SettingResetButton
                label="diff colors"
                onClick={() =>
                  updateSettings({ diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.diffColorScheme}
                onValueChange={(value) => {
                  if (value === "red-green" || value === "blue-orange")
                    updateSettings({ diffColorScheme: value });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={setting("diff-color-scheme").title}
                >
                  <span
                    aria-hidden="true"
                    className={
                      settings.diffColorScheme === "blue-orange"
                        ? "flex shrink-0 flex-row-reverse gap-1"
                        : "flex shrink-0 gap-1"
                    }
                  >
                    <span className="size-2 rounded-full bg-diff-deletion" />
                    <span className="size-2 rounded-full bg-diff-addition" />
                  </span>
                  <SelectValue>
                    {settings.diffColorScheme === "blue-orange"
                      ? gt("Blue & orange")
                      : gt("Red & green")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="red-green">{gt("Red & green (default)")}</SelectItem>
                  <SelectItem value="blue-orange">{gt("Blue & orange")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />

        <SettingsRow
          {...setting("composer-context")}
          description={gt(
            "Keep branch and worktree controls below the composer after a thread starts.",
          )}
          resetAction={
            settings.persistComposerContextStrip !==
            DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
              <SettingResetButton
                label="composer context"
                onClick={() =>
                  updateSettings({
                    persistComposerContextStrip:
                      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.persistComposerContextStrip}
              onCheckedChange={(checked) =>
                updateSettings({ persistComposerContextStrip: Boolean(checked) })
              }
              aria-label="Keep composer context visible in active threads"
            />
          }
        />

        <SettingsRow
          {...setting("chat-width")}
          description={gt("Set how wide messages and the composer can grow on large screens.")}
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label="chat width"
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === "comfortable" || value === "wide" || value === "full")
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">
                  <SelectValue>{m(CHAT_WIDTH_LABELS[settings.chatWidth])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">{gt("Comfortable (default)")}</SelectItem>
                  <SelectItem value="wide">{gt("Wide")}</SelectItem>
                  <SelectItem value="full">{gt("Full")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...setting("math-rendering")}
          description={gt(
            "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.",
          )}
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                label="math rendering"
                onClick={() =>
                  updateSettings({
                    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.mathRenderingEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ mathRenderingEnabled: Boolean(checked) })
              }
              aria-label="Render math"
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="motion" title={gt("Motion")}>
        <SettingsRow
          {...setting("panel-animations")}
          description={gt("Set how fast panels open and close.")}
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label="Panel animation duration"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="panel animations"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}
