import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { AuthSettingsWriteScope } from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
import {
  resolveProjectScriptConfiguration,
  resolveProjectSetupScriptConfiguration,
} from "@goat/shared/projectScripts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { PlusIcon } from "~/components/solar";
import { useState } from "react";
import { useGoatProjectFileState } from "../../hooks/useGoatProjectFileScripts";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { ProjectFileActions } from "./ProjectFileActions";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectActionsSettings() {
  const { scope, targets, target, search, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const representativeConfig = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
        ?.serverConfig
    : undefined;
  const memberById = new Map(
    isProjectScope ? scope.members.map((member) => [member.id, member]) : [],
  );
  const configurations = targets.map((candidate) => {
    const member = candidate.projectId ? memberById.get(candidate.projectId) : undefined;
    const settings = environments.find((entry) => entry.environmentId === candidate.environmentId)
      ?.serverConfig?.settings;
    return member && settings
      ? resolveProjectScriptConfiguration(settings, member)
      : { scripts: candidate.settings.defaultProjectScripts, source: "defaults" as const };
  });
  const configuration = (target ? configurations[targets.indexOf(target)] : undefined) ?? {
    scripts: [],
    source: "defaults" as const,
  };
  const scripts = configuration.scripts;
  const keybindings = representativeConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const mixed = configurations.some(
    (candidate) => JSON.stringify(candidate) !== JSON.stringify(configuration),
  );
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const writableTargets = targets.flatMap((candidate) => {
    const environment = environments.find(
      (entry) => entry.environmentId === candidate.environmentId,
    );
    if (!environment?.serverConfig) return [];
    const member = candidate.projectId ? memberById.get(candidate.projectId) : undefined;
    // An older server ignores the override record, so a project edit there
    // would report success and vanish; such environments are left out and
    // the legacy per-project map keeps serving them.
    if (
      member &&
      environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
    ) {
      return [];
    }
    return [
      {
        environmentId: candidate.environmentId,
        settings: environment.serverConfig.settings,
        keybindings: environment.serverConfig.keybindings,
        ...(member ? { project: member } : {}),
      },
    ];
  });
  const { saving, persist, submit } = useProjectScriptSettings(writableTargets);
  const singleCheckout = isProjectScope && scope.members.length === 1;
  const representativeMember =
    singleCheckout && target?.projectId ? memberById.get(target.projectId) : undefined;
  const goatFile = useGoatProjectFileState(
    representativeMember?.environmentId ?? EnvironmentId.make("none"),
    representativeMember?.workspaceRoot ?? null,
  );

  const effective = resolveProjectSetupScriptConfiguration(configuration, goatFile.file);
  const optedOut = configuration.source === "project-override" && scripts.length === 0;
  const showRepository = singleCheckout && (configuration.source === "unconfigured" || optedOut);
  const disabled =
    saving ||
    !canWriteSettings ||
    writableTargets.length !== targets.length ||
    targets.length === 0;

  return (
    <SettingsSection id="project-actions" title="Actions">
      <SettingsRow
        serverScoped
        settingKeys={["defaultProjectScripts"]}
        mixed={mixed}
        title="Actions"
        description="Commands that run in this project's checkout or its worktree, with optional shortcuts."
        onResetOverride={() => void persist(() => null)}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        }
      />
      {isProjectScope && !singleCheckout ? (
        <SettingsRow
          title="Choose one checkout to inspect repository actions."
          control={
            <div className="flex flex-wrap gap-2">
              {scope.members.map((member) => (
                <Button
                  key={member.physicalProjectKey}
                  size="xs"
                  variant="outline"
                  onClick={() => selectScope({ ...search, checkout: member.physicalProjectKey })}
                >
                  <span className="max-w-64 truncate">
                    {member.environmentLabel ? `${member.environmentLabel} · ` : ""}
                    {member.workspaceRoot}
                  </span>
                </Button>
              ))}
            </div>
          }
        />
      ) : null}
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
        />
      ) : showRepository ? (
        <ProjectFileActions
          file={goatFile}
          configuration={effective}
          optedOut={optedOut}
          disabled={disabled}
          onDisable={() => void persist(() => [])}
          onRestore={() => void persist(() => null)}
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={keybindings}
          disabled={disabled}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        />
      )}
      {!showRepository && singleCheckout && goatFile.status === "invalid" ? (
        <SettingsRow
          title={`${goatFile.relativePath} is invalid`}
          description={`A ${goatFile.relativePath} exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values.`}
          className="text-warning"
        />
      ) : null}
      {target && (
        <ProjectScriptEditorDialog
          environmentId={target.environmentId}
          editScope={AuthSettingsWriteScope}
          request={request}
          scripts={scripts}
          onSubmit={submit}
          onDelete={(id) =>
            void persist((current) => current.filter((script) => script.id !== id), id, null)
          }
          onClose={() => setRequest(null)}
        />
      )}
    </SettingsSection>
  );
}
