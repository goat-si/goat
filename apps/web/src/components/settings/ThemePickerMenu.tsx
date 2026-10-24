import {
  CopyIcon,
  MoonIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  SunIcon,
  TrashIcon,
  UploadIcon,
} from "~/components/solar";
import { Fragment } from "react";
import type { ThemeAppearance } from "../../themePalette";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SelectButton } from "../ui/select";
import { ThemePreviewCircle, type ThemeCardPreviewColors } from "./ThemePreviewCircles";

export type ThemeSwatch = { mode: ThemeAppearance; colors: ThemeCardPreviewColors };

export type ThemeChoiceActions = {
  duplicate: () => void;
  edit?: () => void;
  exportFile?: () => void;
  remove?: () => void;
};

export type ThemeChoice = {
  key: string;
  label: string;
  /** Collection the theme was imported with; consecutive choices sharing one are grouped. */
  group?: string;
  swatches: ReadonlyArray<ThemeSwatch>;
  ownedModes: ReadonlyArray<ThemeAppearance>;
  onSelect: () => void;
  onSelectMode: (mode: ThemeAppearance) => void;
  actions: ThemeChoiceActions;
};

const MODE_LABELS: Record<ThemeAppearance, string> = { light: "Light", dark: "Dark" };

function ThemeSwatches({ swatches }: { swatches: ReadonlyArray<ThemeSwatch> }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5">
      {swatches.map((swatch) => (
        <ThemePreviewCircle
          className="size-3.5 border-0"
          colors={swatch.colors}
          key={swatch.mode}
          mode={swatch.mode}
        />
      ))}
    </span>
  );
}

function ModeIcon({ mode }: { mode: ThemeAppearance }) {
  return mode === "light" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />;
}

function OwnedModesIndicator({ ownedModes }: { ownedModes: ReadonlyArray<ThemeAppearance> }) {
  const [mode] = ownedModes;
  if (ownedModes.length !== 1 || !mode) return <MenuRadioItemIndicator />;
  return (
    <span className="flex shrink-0 text-muted-foreground">
      <ModeIcon mode={mode} />
      <span className="sr-only">, used for {mode} mode</span>
    </span>
  );
}

function ThemeChoiceActionsMenu({ choice }: { choice: ThemeChoice }) {
  const { actions } = choice;
  if (!actions.edit && !actions.exportFile && !actions.remove) {
    return (
      <MenuItem aria-label={`Duplicate ${choice.label}`} onClick={actions.duplicate}>
        <CopyIcon />
      </MenuItem>
    );
  }
  return (
    <MenuSub>
      <MenuSubTrigger aria-label={`More actions for ${choice.label}`} />
      <MenuSubPopup>
        <MenuItem onClick={actions.duplicate}>
          <CopyIcon />
          Duplicate
        </MenuItem>
        {actions.edit ? (
          <MenuItem onClick={actions.edit}>
            <PenLineIcon />
            Edit
          </MenuItem>
        ) : null}
        {actions.exportFile ? (
          <MenuItem onClick={actions.exportFile}>
            <UploadIcon />
            Export file
          </MenuItem>
        ) : null}
        {actions.remove ? (
          <MenuItem onClick={actions.remove} variant="destructive">
            <TrashIcon />
            Remove…
          </MenuItem>
        ) : null}
      </MenuSubPopup>
    </MenuSub>
  );
}

function ThemeChoiceRow({ choice }: { choice: ThemeChoice }) {
  const [onlySwatch] = choice.swatches;
  const singleMode = choice.swatches.length === 1 && onlySwatch ? onlySwatch.mode : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto]">
      <MenuRadioItem closeOnClick value={choice.key} onClick={choice.onSelect}>
        <span className="flex min-w-0 items-center gap-2">
          <ThemeSwatches swatches={choice.swatches} />
          <span className="min-w-0 flex-1 truncate">{choice.label}</span>
          {singleMode ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {MODE_LABELS[singleMode]} only
            </span>
          ) : null}
          <OwnedModesIndicator ownedModes={choice.ownedModes} />
        </span>
      </MenuRadioItem>
      <ThemeChoiceActionsMenu choice={choice} />
    </div>
  );
}

function ModeThemeSubmenu({
  mode,
  choices,
}: {
  mode: ThemeAppearance;
  choices: ReadonlyArray<ThemeChoice>;
}) {
  const options = choices.flatMap((choice) => {
    const swatch = choice.swatches.find((candidate) => candidate.mode === mode);
    return swatch ? [{ choice, swatch }] : [];
  });
  const current = options.find(({ choice }) => choice.ownedModes.includes(mode));
  return (
    <MenuSub>
      <MenuSubTrigger>
        <ModeIcon mode={mode} />
        <span className="shrink-0">For {mode} mode</span>
        {current ? (
          <span className="min-w-0 flex-1 truncate text-end text-xs text-muted-foreground">
            {current.choice.label}
          </span>
        ) : null}
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuRadioGroup
          aria-label={`${MODE_LABELS[mode]} mode theme`}
          value={current?.choice.key ?? ""}
        >
          {options.map(({ choice, swatch }) => (
            <MenuRadioItem
              closeOnClick
              key={choice.key}
              value={choice.key}
              onClick={() => choice.onSelectMode(mode)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <ThemeSwatches swatches={[swatch]} />
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

function groupChoices(choices: ReadonlyArray<ThemeChoice>) {
  const groups: Array<{ label: string | undefined; choices: ThemeChoice[] }> = [];
  for (const choice of choices) {
    const last = groups.at(-1);
    if (last && choice.group !== undefined && last.label === choice.group)
      last.choices.push(choice);
    else groups.push({ label: choice.group, choices: [choice] });
  }
  return groups;
}

export function ThemePickerMenu({
  choices,
  lightLabel,
  darkLabel,
  triggerSwatches,
  onCreate,
  onAdd,
}: {
  choices: ReadonlyArray<ThemeChoice>;
  lightLabel: string;
  darkLabel: string;
  triggerSwatches: ReadonlyArray<ThemeSwatch>;
  onCreate: () => void;
  onAdd: () => void;
}) {
  const isSplit = lightLabel !== darkLabel;
  const groups = groupChoices(choices);
  const checkedKey = choices.find((choice) => choice.ownedModes.length === 2)?.key ?? "";
  return (
    <Menu>
      <MenuTrigger
        aria-label={
          isSplit
            ? `Theme: ${lightLabel} for light mode, ${darkLabel} for dark mode`
            : `Theme: ${lightLabel}`
        }
        className="w-full sm:w-56"
        render={<SelectButton size="sm" />}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ThemeSwatches swatches={triggerSwatches} />
          <span className="min-w-0 truncate">
            {isSplit ? `${lightLabel} / ${darkLabel}` : lightLabel}
          </span>
        </span>
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        <MenuRadioGroup aria-label="Themes" value={checkedKey}>
          {groups.map((group, index) => {
            const previous = groups[index - 1];
            const separated =
              previous !== undefined && (group.label !== undefined || previous.label !== undefined);
            const rows = group.choices.map((choice) => (
              <ThemeChoiceRow choice={choice} key={choice.key} />
            ));
            return (
              <Fragment key={group.choices[0]?.key ?? group.label}>
                {separated ? <MenuSeparator /> : null}
                {group.label !== undefined ? (
                  <MenuGroup>
                    <MenuGroupLabel>{group.label}</MenuGroupLabel>
                    {rows}
                  </MenuGroup>
                ) : (
                  rows
                )}
              </Fragment>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <ModeThemeSubmenu choices={choices} mode="light" />
        <ModeThemeSubmenu choices={choices} mode="dark" />
        <MenuSeparator />
        <MenuItem onClick={onCreate}>
          <PaintbrushIcon />
          Create theme…
        </MenuItem>
        <MenuItem onClick={onAdd}>
          <PlusIcon />
          Add theme…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
