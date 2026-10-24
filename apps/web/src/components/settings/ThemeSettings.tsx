import { CheckIcon } from "~/components/solar";
import { useState } from "react";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { readThemeHalvesRaw } from "../../hooks/useTheme";
import {
  getThemeDefinition,
  singleAppearanceOf,
  getThemeModes,
  removeCustomThemes,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
  type ThemeHalves,
  GOAT_CHAT_THEME,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
} from "../../themePalette";
import { APPEARANCE_OPTIONS } from "../CommandPaletteThemeItems";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { ThemePickerMenu, type ThemeChoice } from "./ThemePickerMenu";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircle,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";

const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [
  GOAT_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
];

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give the
  // browser time to open the stream first.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function ThemeLibrary({
  theme,
  setTheme,
  appearanceMode,
  setAppearanceMode,
  customThemes,
  initialAppearance,
  refreshTheme,
  isImportOpen,
  onImportOpenChange,
  themeHalves,
  setThemeHalf,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  appearanceMode: ThemeMode;
  setAppearanceMode: (mode: ThemeMode) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  initialAppearance: ThemeAppearance;
  refreshTheme: () => void;
  isImportOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
  themeHalves: ThemeHalves | null;
  setThemeHalf: (appearance: ThemeAppearance, themeId: string | null) => boolean;
}) {
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const environmentThemes = useEnvironmentThemeDefinitions();
  const [themeRemovalTarget, setThemeRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  const [isThemeRemovalOpen, setIsThemeRemovalOpen] = useState(false);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<ReadonlyArray<string>>([]);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = themeRemovalTarget?.theme;
  const removeDialogCollectionThemes = themeRemovalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel =
    removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;

  const notifyThemeSaveFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t save theme selection",
        description: "Try again.",
      }),
    );
  };

  const notifyThemeRemovalFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t remove theme",
        description: "Try again.",
      }),
    );
  };

  const persistTheme = (nextTheme: string) => {
    const didSave = setTheme(nextTheme);
    if (!didSave) notifyThemeSaveFailure();
    return didSave;
  };

  const handleRemoveTheme = (
    customTheme: ThemeDefinition,
    collectionThemes: ReadonlyArray<ThemeDefinition>,
  ) => {
    setThemeRemovalTarget({ theme: customTheme, collectionThemes });
    setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
    setIsThemeRemovalOpen(true);
  };

  const handleConfirmRemoveTheme = () => {
    if (!themeRemovalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    const removesBase = removedIds.has(getThemeDefinition(theme)?.id ?? "");
    // Captured raw before persistTheme clears the mix: a half naming a
    // published theme whose set has not streamed in yet is pruned from the
    // `themeHalves` prop, and rebuilding from that would drop it.
    const storedHalves = readThemeHalvesRaw();
    if (removesBase && !persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) {
      return;
    }
    for (const appearance of ["light", "dark"] as const) {
      const half = storedHalves[appearance];
      if (half === undefined) continue;
      const next = half && removedIds.has(half) ? null : removesBase ? half : undefined;
      if (next !== undefined && !setThemeHalf(appearance, next)) {
        notifyThemeRemovalFailure();
        return;
      }
    }
    try {
      removeCustomThemes([...removedIds]);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setIsThemeRemovalOpen(false);
  };

  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;

  const assignHalf = (appearance: ThemeAppearance, cardId: string | null) => {
    const otherAppearance = appearance === "light" ? "dark" : "light";
    // Picking the default over a themed base cannot be stored as a half:
    // the base would still own that appearance. Convert the base into an
    // explicit half on the other side so this side falls back to default.
    if (cardId === null && baseCardId !== null) {
      // Read raw, before persistTheme clears the mix: the other half may
      // name a published theme that has not streamed in yet, and falling
      // back to the base would silently rewrite it.
      const otherOwner = readThemeHalvesRaw()[otherAppearance] ?? baseCardId;
      if (!persistTheme(appearanceMode === "system" ? "system" : appearanceMode)) return;
      if (!setThemeHalf(otherAppearance, otherOwner)) {
        setTheme(theme);
        notifyThemeSaveFailure();
      }
      return;
    }
    if (!setThemeHalf(appearance, cardId)) {
      notifyThemeSaveFailure();
    }
  };

  const activeThemeForAppearance =
    getThemeDefinition((initialAppearance === "light" ? lightOwner : darkOwner) ?? "") ?? null;

  const cardDefById = (id: string | null): ThemeCardDefinition => {
    if (id === null) return STANDARD_THEME_CARDS[0]!;
    const definition = getThemeDefinition(id);
    return definition ? getThemeCardDefinition(definition) : STANDARD_THEME_CARDS[0]!;
  };

  const pickColors = (id: string | null, appearance: ThemeAppearance) => {
    const card = cardDefById(id);
    return previewColorsOf(card, appearance) ?? card.previews[0]!.colors;
  };

  const setMode = (mode: ThemeMode) => {
    if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
  };

  const ownedModesFor = (cardId: string | null): ThemeAppearance[] => {
    const modes: ThemeAppearance[] = [];
    if (lightOwner === cardId) modes.push("light");
    if (darkOwner === cardId) modes.push("dark");
    return modes;
  };

  const customThemeCollections = [
    ...customThemes
      .reduce((groups, customTheme) => {
        const groupId = customTheme.collection
          ? `collection:${customTheme.collection.id}`
          : `theme:${customTheme.id}`;
        const group = groups.get(groupId);
        if (group) group.push(customTheme);
        else groups.set(groupId, [customTheme]);
        return groups;
      }, new Map<string, ThemeDefinition[]>())
      .entries(),
  ];

  const duplicate = (seedThemeId: string | null, label: string) => () =>
    openThemeEditor({
      editingThemeId: null,
      seedThemeId,
      seedName: `${label} copy`,
      initialAppearance,
    });

  const choiceFor = (
    id: string | null,
    card: ThemeCardDefinition,
    onSelect: () => void,
    extra: Partial<Pick<ThemeChoice, "group" | "actions">> = {},
  ): ThemeChoice => ({
    key: id === null ? "standard" : `theme:${id}`,
    label: card.label,
    swatches: card.previews,
    ownedModes: ownedModesFor(id),
    onSelect,
    onSelectMode: (mode) => assignHalf(mode, id),
    actions: { duplicate: duplicate(id, card.label) },
    ...extra,
  });

  const standardCard = cardDefById(null);
  const choices: ThemeChoice[] = [
    choiceFor(null, standardCard, () =>
      persistTheme(appearanceMode === "system" ? "system" : appearanceMode),
    ),
    ...MAINTAINER_THEMES.map((maintainerTheme) =>
      choiceFor(maintainerTheme.id, getThemeCardDefinition(maintainerTheme), () =>
        persistTheme(maintainerTheme.id),
      ),
    ),
    ...environmentThemes
      // A saved theme with the same id wins resolution, so only its entry may show.
      .filter(
        (environmentTheme) => !customThemes.some((custom) => custom.id === environmentTheme.id),
      )
      .map((environmentTheme) =>
        choiceFor(environmentTheme.id, getThemeCardDefinition(environmentTheme), () => {
          const half = singleAppearanceOf(environmentTheme);
          if (half === null) persistTheme(environmentTheme.id);
          else assignHalf(half, environmentTheme.id);
        }),
      ),
    ...customThemeCollections.flatMap(([, themes]) =>
      themes.map((customTheme) =>
        choiceFor(
          customTheme.id,
          getThemeCardDefinition(customTheme),
          () => {
            const modes = getThemeModes(customTheme);
            if (modes.length === 1 && modes[0]) assignHalf(modes[0], customTheme.id);
            else persistTheme(customTheme.id);
          },
          {
            ...(themes.length > 1
              ? { group: customTheme.collection?.label ?? customTheme.label }
              : {}),
            actions: {
              duplicate: duplicate(customTheme.id, customTheme.label),
              edit: () =>
                openThemeEditor({
                  editingThemeId: customTheme.id,
                  seedThemeId: null,
                  seedName: null,
                  initialAppearance,
                }),
              exportFile: () =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme)),
              remove: () => handleRemoveTheme(customTheme, themes),
            },
          },
        ),
      ),
    ),
  ];

  const ownerLabel = (id: string | null) => cardDefById(id).label;
  const appearanceOption =
    APPEARANCE_OPTIONS.find((option) => option.mode === appearanceMode) ?? APPEARANCE_OPTIONS[0];
  const AppearanceIcon = appearanceOption.icon;

  return (
    <>
      <SettingsRow
        {...searchableSetting("color-scheme")}
        description="Follow the system appearance, or stay in light or dark mode."
        control={
          <Select
            value={appearanceMode}
            onValueChange={(value) => {
              if (value === "system" || value === "light" || value === "dark") setMode(value);
            }}
          >
            <SelectTrigger aria-label="Color scheme" className="w-full sm:w-40" size="sm">
              <AppearanceIcon aria-hidden />
              <SelectValue>{appearanceOption.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => (
                <SelectItem key={mode} value={mode}>
                  <span className="flex items-center gap-2">
                    <Icon aria-hidden />
                    {label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("theme")}
        description="Choose colors for light and dark mode, or create your own theme."
        control={
          <ThemePickerMenu
            choices={choices}
            darkLabel={ownerLabel(darkOwner)}
            lightLabel={ownerLabel(lightOwner)}
            onAdd={() => onImportOpenChange(true)}
            onCreate={() =>
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: activeThemeForAppearance?.id ?? null,
                seedName: null,
                initialAppearance,
              })
            }
            triggerSwatches={[
              { mode: "light", colors: pickColors(lightOwner, "light") },
              { mode: "dark", colors: pickColors(darkOwner, "dark") },
            ]}
          />
        }
      />
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          if (updated) refreshTheme();
          const verb = updated ? "updated" : "added";
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title:
                importedThemes.length === 1
                  ? `${importedThemes[0]!.label} ${verb}`
                  : `${importedThemes.length} themes ${verb}`,
              description: importedThemes.map((imported) => imported.label).join(", "),
            }),
          );
        }}
        onImported={(importedTheme) => {
          const modes = getThemeModes(importedTheme);
          if (modes.length === 1) {
            assignHalf(modes[0]!, importedTheme.id);
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: `${importedTheme.label} added`,
                description: `It’s now your ${modes[0]!} theme.`,
              }),
            );
            return true;
          }
          if (!persistTheme(importedTheme.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} added`,
              description: "It’s now active.",
            }),
          );
          return true;
        }}
        onOpenChange={onImportOpenChange}
        open={isImportOpen}
      />
      <AlertDialog open={isThemeRemovalOpen} onOpenChange={setIsThemeRemovalOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {canRemoveCollection
                ? `Remove themes from “${removeDialogCollectionLabel}”?`
                : `Remove “${removeDialogTheme?.label}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {canRemoveCollection
                ? "Select the variants you want to remove. You can restore them by importing the extension again."
                : "You can bring it back anytime by importing its JSON file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {canRemoveCollection ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 sm:grid-cols-2">
              {removeDialogCollectionThemes.map((customTheme) => {
                const checked = themeIdsToRemoveSet.has(customTheme.id);
                const card = getThemeCardDefinition(customTheme);
                const checkboxId = `remove-theme-${customTheme.id}`;
                return (
                  <label
                    className="group relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 has-checked:border-ring has-checked:bg-accent/20 hover:bg-muted/40"
                    htmlFor={checkboxId}
                    key={customTheme.id}
                  >
                    <span className="absolute right-2 top-2 inline-grid size-5 grid-cols-1 sm:size-4">
                      <input
                        checked={checked}
                        className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring checked:focus-visible:inset-ring-3 checked:focus-visible:inset-ring-background dark:not-checked:bg-input/32 forced-colors:appearance-auto"
                        id={checkboxId}
                        name="themes-to-remove"
                        type="checkbox"
                        onChange={(event) => {
                          const shouldRemove = event.currentTarget.checked;
                          setThemeIdsToRemove((current) =>
                            shouldRemove
                              ? [...current, customTheme.id]
                              : current.filter((themeId) => themeId !== customTheme.id),
                          );
                        }}
                      />
                      <CheckIcon className="pointer-events-none col-start-1 row-start-1 size-3.5 shrink-0 self-center justify-self-center stroke-primary-foreground opacity-0 group-has-checked:opacity-100 sm:size-3" />
                    </span>
                    <span className="flex min-h-12 items-center justify-center gap-1">
                      {card.previews.map((preview) => (
                        <span
                          className="flex size-11 shrink-0 items-center justify-center"
                          key={preview.mode}
                        >
                          <span className="flex scale-75">
                            <ThemePreviewCircle colors={preview.colors} mode={preview.mode} />
                          </span>
                        </span>
                      ))}
                    </span>
                    <p className="max-w-full truncate text-center text-base font-medium text-foreground sm:text-sm">
                      {customTheme.label}
                    </p>
                  </label>
                );
              })}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={themeIdsToRemove.length === 0}
              variant="destructive"
              onClick={handleConfirmRemoveTheme}
            >
              {canRemoveCollection
                ? `Remove selected${themeIdsToRemove.length > 0 ? ` (${themeIdsToRemove.length})` : ""}`
                : "Remove theme"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
