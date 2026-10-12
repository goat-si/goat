import { useRef } from "react";
import { STANDING_INSTRUCTIONS_MAX_CHARS } from "@t3tools/contracts";

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
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["standingInstructions"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["standingInstructions"]}
      mixed={mixed}
      {...searchableSetting("standing-instructions")}
      description={
        isProjectScope
          ? "Put in front of the first message of every thread an agent launches in this project, in place of the environment's."
          : "Put in front of the first message of every thread an agent launches here, including launches from other machines. Projects can replace them. The thread shows them collapsed."
      }
      resetAction={
        mixed || settings.standingInstructions !== "" ? (
          <SettingResetButton
            label="standing instructions"
            onClick={() => updateSettings({ standingInstructions: "" })}
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${settings.standingInstructions}`}
          aria-label="Standing instructions"
          maxLength={STANDING_INSTRUCTIONS_MAX_CHARS}
          onChange={() => {
            edited.current = true;
          }}
          rows={4}
          defaultValue={mixed ? "" : settings.standingInstructions}
          placeholder={
            mixed
              ? "Mixed. Enter instructions to apply to all selected targets."
              : "Use sol for subagents. Work without waiting for approval. One topic per PR."
          }
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.standingInstructions))
              updateSettings({ standingInstructions: value });
            edited.current = false;
          }}
        />
      </div>
    </SettingsRow>
  );
}
