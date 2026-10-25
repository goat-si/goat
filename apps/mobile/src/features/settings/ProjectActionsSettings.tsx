import {
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  GOAT_PROJECT_FILE_NAME,
  type GoatProjectFile,
  type ProjectReadFileResult,
} from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import { goatProjectFileReadPath } from "@goat/client-runtime/goat-project-file";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { parseGoatProjectFile } from "@goat/shared/goatProjectFile";
import {
  projectScriptMenuLabel,
  projectScriptsInheritDefaults,
  resolveProjectScriptConfiguration,
  resolveProjectSetupScriptConfiguration,
} from "@goat/shared/projectScripts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import type { SettingsTarget } from "./settings-environment-filter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

type ProjectFileStatus = "unread" | "unreadable" | "loading" | "missing" | "invalid" | "valid";

/**
 * Reads the checkout's goat.json the way the server's GoatProjectFileLoader does: a present
 * goat.json wins even when invalid, and t3.json is read only when goat.json is absent.
 */
function useGoatProjectFile(member: EnvironmentProject, enabled: boolean) {
  const canRead = useEnvironmentScope(member.environmentId, AuthFilesystemReadScope);
  const read = enabled && canRead && member.workspaceRoot !== "";
  const readFile = (relativePath: string) =>
    projectEnvironment.readFile({
      environmentId: member.environmentId,
      input: { cwd: member.workspaceRoot, relativePath, allowMissing: true },
    });
  const primary = useEnvironmentQuery(read ? readFile(GOAT_PROJECT_FILE_NAME) : null);
  const primaryData = primary.data as ProjectReadFileResult | null;
  // Older servers ignore allowMissing and report absence through the read error instead.
  const relativePath =
    primaryData?.exists === false
      ? LEGACY_PROJECT_FILE_NAME
      : goatProjectFileReadPath(primaryData, primary.cause, primary.isPending);
  const legacy = useEnvironmentQuery(
    read && relativePath !== GOAT_PROJECT_FILE_NAME ? readFile(relativePath) : null,
  );
  const query = relativePath === GOAT_PROJECT_FILE_NAME ? primary : legacy;
  const data = query.data as ProjectReadFileResult | null;
  const state = (status: ProjectFileStatus, file: GoatProjectFile | null = null) => ({
    status,
    file,
    relativePath,
  });
  if (!enabled) return state("unread");
  if (!read) return state("unreadable");
  if (data === null) {
    if (query.cause === null || query.isPending) return state("loading");
    return goatProjectFileReadPath(null, query.cause) === LEGACY_PROJECT_FILE_NAME
      ? state("missing")
      : state("unreadable");
  }
  if (data.exists === false) return state("missing");
  const file = data.truncated ? null : parseGoatProjectFile(data.contents);
  return file === null ? state("invalid") : state("valid", file);
}

export function ProjectActionsSettings(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly SettingsTarget[];
}) {
  return (
    <SettingsSection title="Actions">
      {props.members.flatMap((member, index) => {
        const environment = props.environments.find(
          (entry) => entry.environmentId === member.environmentId,
        );
        return environment
          ? [
              <CheckoutActions
                key={`${member.environmentId}:${member.id}`}
                member={member}
                environment={environment}
                showCheckout={props.members.length > 1}
                divided={index > 0}
              />,
            ]
          : [];
      })}
    </SettingsSection>
  );
}

function CheckoutActions(props: {
  readonly member: EnvironmentProject;
  readonly environment: SettingsTarget;
  readonly showCheckout: boolean;
  readonly divided: boolean;
}) {
  const { member, environment } = props;
  const settings = environment.serverConfig.settings;
  const configuration = resolveProjectScriptConfiguration(settings, member);
  const file = useGoatProjectFile(member, configuration.source === "unconfigured");
  const effective = resolveProjectSetupScriptConfiguration(configuration, file.file);
  const optedOut =
    configuration.source === "project-override" && configuration.scripts.length === 0;
  const inherited = projectScriptsInheritDefaults(settings, member);
  const sourceLabel =
    effective.source === "project-file"
      ? `Repository setup from ${file.relativePath}`
      : inherited
        ? "Inherited from environment defaults"
        : "Project";
  const canTurnOff =
    !optedOut && effective.scripts.length > 0 && (effective.source === "project-file" || inherited);

  const canWrite = useEnvironmentScope(member.environmentId, AuthSettingsWriteScope);
  // Older servers drop the override record, so a write there would report success and vanish.
  const supportsOverrides =
    environment.serverConfig.environment.capabilities.projectSettingsOverrides === true;
  const refusal = !supportsOverrides
    ? "Update this environment's server to change project actions."
    : !canWrite
      ? "This connection cannot change environment settings."
      : null;
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const writeSettings = useSettingsWriter();
  const write = (change: "turn-off" | "inherit") => {
    if (
      savingRef.current ||
      !supportsOverrides ||
      !readEnvironmentScope(member.environmentId, AuthSettingsWriteScope)
    )
      return;
    const targets = resolveMobileSettingsTargets([environment], [member]);
    const writes =
      change === "turn-off"
        ? planMobileScopedSettingsPatch(targets, true, { defaultProjectScripts: [] })
        : planMobileScopedSettingsClear(targets, ["defaultProjectScripts"]);
    if (writes.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    void writeSettings(targets, writes).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  };

  const notice =
    configuration.source !== "unconfigured" || effective.scripts.length > 0
      ? null
      : {
          unread: null,
          unreadable: "This connection cannot read this checkout's repository actions.",
          loading: "Loading repository actions…",
          missing: "No actions. This checkout has no goat.json or t3.json.",
          invalid: `${file.relativePath} is invalid, so its actions are ignored. Check the JSON syntax and icon values.`,
          valid: `No actions. ${file.relativePath} declares no worktree setup action.`,
        }[file.status];

  return (
    <View className={props.divided ? "border-t border-border-subtle" : undefined}>
      {props.showCheckout ? (
        <View className="gap-0.5 px-4 pt-4">
          <Text className="font-goat-medium text-sm text-foreground">{environment.label}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {member.workspaceRoot}
          </Text>
        </View>
      ) : null}
      {optedOut ? (
        <Text className="px-4 pt-4 text-sm leading-normal text-foreground-muted">
          Actions are turned off for this project. Repository setup and inherited actions do not run
          here.
        </Text>
      ) : effective.scripts.length === 0 ? (
        <Text className="px-4 pt-4 text-sm leading-normal text-foreground-muted">
          {notice ?? "No actions."}
        </Text>
      ) : (
        effective.scripts.map((script) => (
          <View key={script.id} className="gap-1 px-4 pt-4">
            <Text className="text-base text-foreground">{projectScriptMenuLabel(script)}</Text>
            <Text className="text-xs text-foreground-muted">{sourceLabel}</Text>
            <Text className="font-mono text-xs text-foreground-muted" selectable>
              {script.command}
            </Text>
          </View>
        ))
      )}
      <View className="pt-2">
        {optedOut ? (
          <SettingsActionRow
            label="Use inherited actions"
            description={
              refusal ?? "Removes this project's empty action list so inherited actions run again."
            }
            disabled={refusal !== null}
            loading={saving}
            onPress={() => write("inherit")}
          />
        ) : canTurnOff ? (
          <SettingsActionRow
            label="Turn off actions for this project"
            description={
              refusal ??
              "Saves an empty action list for this project, so repository setup and inherited actions stop running here."
            }
            disabled={refusal !== null}
            loading={saving}
            onPress={() => write("turn-off")}
          />
        ) : null}
      </View>
    </View>
  );
}
