import { useGT, useMessages } from "gt-react";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { STANDING_INSTRUCTIONS_MAX_CHARS } from "@goat/contracts";

import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Dispatcher policy put in front of the first message of threads agents launch. */
export function StandingInstructionsSettings({ isProjectScope }: { isProjectScope: boolean }) {
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  // Switching targets discards the previous target's uncommitted draft.
  return <StandingInstructionsFields key={scopeKey} isProjectScope={isProjectScope} />;
}

function StandingInstructionsFields({ isProjectScope }: { isProjectScope: boolean }) {
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["standingInstructions"]);

  const input = useCommitOnBlur(
    mixed ? "" : settings.standingInstructions,
    (value) => updateSettings({ standingInstructions: value.trim() }),
    { multiline: true, commitUnchanged: mixed },
  );

  return (
    <SettingsRow
      serverScoped
      settingKeys={["standingInstructions"]}
      mixed={mixed}
      id={searchableSetting("standing-instructions").id}
      title={m(searchableSetting("standing-instructions").title)}
      description={
        isProjectScope
          ? gt(
              "Put in front of the first message of every thread an agent launches in this project, in place of the environment's.",
            )
          : gt(
              "Put in front of the first message of every thread an agent launches here, including launches from other machines. Projects can replace them. The thread shows them collapsed.",
            )
      }
      resetAction={
        mixed || settings.standingInstructions !== "" ? (
          <SettingResetButton
            label={gt("standing instructions")}
            onClick={() => updateSettings({ standingInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          {...input}
          aria-label={gt("Standing instructions")}
          maxLength={STANDING_INSTRUCTIONS_MAX_CHARS}
          rows={4}
          placeholder={
            mixed
              ? gt("Mixed. Enter instructions to apply to all selected targets.")
              : gt("Use sol for subagents. Work without waiting for approval. One topic per PR.")
          }
        />
      </div>
    </SettingsRow>
  );
}
