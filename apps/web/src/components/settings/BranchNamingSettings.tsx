import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";
import { msg, useGT, useMessages } from "gt-react";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { BranchNamingMode, DEFAULT_SERVER_SETTINGS } from "@goat/contracts";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODES = {
  static: msg("Static prefix"),
  semantic: msg("Semantic prefix"),
  custom: msg("Custom instructions"),
} satisfies Record<BranchNamingMode, string>;

export function BranchNamingSettings() {
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  return <BranchNamingFields key={scopeKey} />;
}

function BranchNamingFields() {
  const m = useMessages();
  const gt = useGT();
  const localizedSetting = useTranslatedSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const modeMixed = useScopedSettingsMixed(["branchNamingMode"]);
  const prefixMixed = useScopedSettingsMixed(["branchNamePrefix"]);
  const instructionsMixed = useScopedSettingsMixed(["branchNameInstructions"]);

  const prefixInput = useCommitOnBlur(
    prefixMixed ? "" : settings.branchNamePrefix,
    (value) => updateSettings({ branchNamePrefix: value.trim() }),
    { commitUnchanged: prefixMixed },
  );
  const instructionsInput = useCommitOnBlur(
    instructionsMixed ? "" : settings.branchNameInstructions,
    (value) => updateSettings({ branchNameInstructions: value.trim() }),
    { multiline: true, commitUnchanged: instructionsMixed },
  );

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["branchNamingMode"]}
        {...localizedSetting("worktree-branch-naming")}
        description={gt("Choose how new worktree branches are named from your first message.")}
        status={
          !modeMixed && settings.branchNamingMode === "semantic"
            ? gt(
                "The model chooses a prefix that describes the work, such as feat/add-search, fix/login-timeout, or refactor/auth.",
              )
            : undefined
        }
        resetAction={
          settings.branchNamingMode !== DEFAULT_SERVER_SETTINGS.branchNamingMode || modeMixed ? (
            <SettingResetButton
              label={gt("branch naming")}
              onClick={() =>
                updateSettings({ branchNamingMode: DEFAULT_SERVER_SETTINGS.branchNamingMode })
              }
            />
          ) : null
        }
        control={
          <Select
            value={modeMixed ? null : settings.branchNamingMode}
            onValueChange={(value) => {
              if (BranchNamingMode.literals.includes(value as BranchNamingMode)) {
                updateSettings({ branchNamingMode: value as BranchNamingMode });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Worktree branch naming")}>
              <SelectValue>
                {(value: BranchNamingMode | null) => (value === null ? "Mixed" : m(MODES[value]))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BranchNamingMode.literals.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {m(MODES[mode])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {!modeMixed && settings.branchNamingMode === "static" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNamePrefix"]}
          title={gt("Branch prefix")}
          description={gt(
            "For example, goat or goat/ produces goat/add-search. Leave empty for no prefix.",
          )}
          resetAction={
            prefixMixed ||
            settings.branchNamePrefix !== DEFAULT_SERVER_SETTINGS.branchNamePrefix ? (
              <SettingResetButton
                label={gt("branch prefix")}
                onClick={() =>
                  updateSettings({ branchNamePrefix: DEFAULT_SERVER_SETTINGS.branchNamePrefix })
                }
              />
            ) : null
          }
          control={
            <Input
              {...prefixInput}
              aria-label={gt("Branch prefix")}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={prefixMixed ? gt("Mixed") : gt("No prefix")}
            />
          }
        />
      ) : null}
      {!modeMixed && settings.branchNamingMode === "custom" ? (
        <SettingsRow
          serverScoped
          settingKeys={["branchNameInstructions"]}
          title={gt("Branch naming instructions")}
          description={gt(
            "Appended to the naming prompt. The model returns the complete branch name; no prefix or suffix is added.",
          )}
          resetAction={
            instructionsMixed || settings.branchNameInstructions !== "" ? (
              <SettingResetButton
                label={gt("branch naming instructions")}
                onClick={() => updateSettings({ branchNameInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              {...instructionsInput}
              aria-label={gt("Branch naming instructions")}
              rows={4}
              placeholder={
                instructionsMixed
                  ? gt("Mixed. Enter instructions to apply to all selected targets.")
                  : gt("Use feature/ followed by the issue ID and a short description.")
              }
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}
