import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_PULL_REQUEST_WATCH_CONFLICT_IDLE_DAYS,
  PullRequestWatchWakeMode,
  type PullRequestWatchPolicy,
} from "@goat/contracts/settings";

import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const MODE_LABELS = {
  react: "React",
  keep_as_context: "Keep as context",
  ignore: "Ignore",
} satisfies Record<PullRequestWatchWakeMode, string>;

const EVENTS = [
  ["checksFailed", "pull-request-watch-checks-failed"],
  ["checksPassed", "pull-request-watch-checks-passed"],
  ["humanRemarks", "pull-request-watch-human-remarks"],
  ["botRemarks", "pull-request-watch-bot-remarks"],
  ["conflicts", "pull-request-watch-conflicts"],
] as const;

export function PullRequestWatchSettings() {
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  return <PullRequestWatchFields key={scopeKey} />;
}

function PullRequestWatchFields() {
  const { pullRequestWatchPolicy: policy } = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const defaults = DEFAULT_UNIFIED_SETTINGS.pullRequestWatchPolicy;
  const fieldMixed = (field: keyof PullRequestWatchPolicy) => {
    const first = targets[0];
    return (
      first !== undefined &&
      targets.some(
        (target) =>
          JSON.stringify(target.settings.pullRequestWatchPolicy[field]) !==
          JSON.stringify(first.settings.pullRequestWatchPolicy[field]),
      )
    );
  };
  const reset = (field: keyof PullRequestWatchPolicy, label: string) =>
    fieldMixed(field) || JSON.stringify(policy[field]) !== JSON.stringify(defaults[field]) ? (
      <SettingResetButton
        label={label}
        onClick={() => updateSettings({ pullRequestWatchPolicy: { [field]: defaults[field] } })}
      />
    ) : null;
  const botsMixed = fieldMixed("allowedBotLogins");
  const botsInput = useCommitOnBlur(
    botsMixed ? "" : policy.allowedBotLogins.join(", "),
    (value) =>
      updateSettings({
        pullRequestWatchPolicy: {
          allowedBotLogins: value
            .split(",")
            .map((login) => login.trim())
            .filter(Boolean),
        },
      }),
    { commitUnchanged: botsMixed },
  );
  const daysMixed = fieldMixed("conflictMaxIdleDays");
  const daysInput = useCommitOnBlur(
    daysMixed || policy.conflictMaxIdleDays === null ? "" : String(policy.conflictMaxIdleDays),
    (value) => {
      const days = Number(value);
      if (
        Number.isInteger(days) &&
        days >= 1 &&
        days <= MAX_PULL_REQUEST_WATCH_CONFLICT_IDLE_DAYS
      ) {
        updateSettings({ pullRequestWatchPolicy: { conflictMaxIdleDays: days } });
      }
    },
    { commitUnchanged: daysMixed },
  );
  const autoWatchMixed = fieldMixed("autoWatch");

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchPolicy"]}
        mixed={autoWatchMixed}
        {...searchableSetting("pull-request-watch-automatic")}
        description="Watch pull requests a thread creates or its agent links, without keeping the thread in Working."
        resetAction={reset("autoWatch", "automatic pull request watching")}
        control={
          <Switch
            mixed={autoWatchMixed}
            checked={!autoWatchMixed && policy.autoWatch}
            onCheckedChange={(checked) =>
              updateSettings({ pullRequestWatchPolicy: { autoWatch: checked } })
            }
            aria-label="Watch pull requests automatically"
          />
        }
      />
      {EVENTS.map(([field, id]) => {
        const mixed = fieldMixed(field);
        const row = searchableSetting(id);
        return (
          <SettingsRow
            key={field}
            serverScoped
            settingKeys={["pullRequestWatchPolicy"]}
            mixed={mixed}
            {...row}
            description={
              field === "checksFailed"
                ? "React wakes the agent. Keep as context notes the update in the thread and tells the agent at its next wake. Ignore drops it."
                : undefined
            }
            resetAction={reset(field, row.title)}
            control={
              <div className="w-full sm:w-44">
                <Select
                  value={mixed ? null : policy[field]}
                  onValueChange={(value) => {
                    if (
                      PullRequestWatchWakeMode.literals.includes(value as PullRequestWatchWakeMode)
                    ) {
                      updateSettings({
                        pullRequestWatchPolicy: { [field]: value as PullRequestWatchWakeMode },
                      });
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label={row.title}>
                    <SelectValue>
                      {(value: PullRequestWatchWakeMode | null) =>
                        value === null ? "Mixed" : MODE_LABELS[value]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {PullRequestWatchWakeMode.literals.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {MODE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        );
      })}
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchPolicy"]}
        mixed={botsMixed}
        {...searchableSetting("pull-request-watch-allowed-bots")}
        description="Comma-separated bot logins. Their comments follow the policy for people."
        resetAction={reset("allowedBotLogins", "bots that count as people")}
        control={
          <div className="w-full sm:w-56">
            <Input
              {...botsInput}
              size="sm"
              placeholder={botsMixed ? "Mixed" : "coderabbitai[bot], review-bot"}
              aria-label="Bots that count as people"
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchPolicy"]}
        mixed={daysMixed}
        {...searchableSetting("pull-request-watch-conflict-idle-days")}
        description="Merge conflicts do not wake a thread that has been idle this long. Never lets them wake any thread."
        resetAction={reset("conflictMaxIdleDays", "conflict idle limit")}
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              value={daysMixed ? null : policy.conflictMaxIdleDays === null ? "never" : "days"}
              onValueChange={(value) => {
                if (value === "never" || value === "days") {
                  updateSettings({
                    pullRequestWatchPolicy: {
                      conflictMaxIdleDays: value === "never" ? null : defaults.conflictMaxIdleDays,
                    },
                  });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Conflict inactivity limit">
                <SelectValue>
                  {daysMixed
                    ? "Mixed"
                    : policy.conflictMaxIdleDays === null
                      ? "Never"
                      : "After days"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="never">Never</SelectItem>
                <SelectItem value="days">After days</SelectItem>
              </SelectPopup>
            </Select>
            {daysMixed || policy.conflictMaxIdleDays !== null ? (
              <div className="w-20">
                <Input
                  {...daysInput}
                  size="sm"
                  type="number"
                  min={1}
                  max={MAX_PULL_REQUEST_WATCH_CONFLICT_IDLE_DAYS}
                  step={1}
                  placeholder={daysMixed ? "Mixed" : undefined}
                  aria-label="Days of inactivity before skipping conflicts"
                />
              </div>
            ) : null}
          </div>
        }
      />
    </>
  );
}
