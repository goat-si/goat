import { useScopedSettingsWriteAllowed } from "./useScopedSettings";
import { AuthSettingsWriteScope } from "@goat/contracts";
import { EnvironmentId } from "@goat/contracts";
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
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * A project's actions on each selected environment. Actions belong to a
 * project, so this only renders at a project scope; the environment's
 * `defaultProjectScripts` is the layer a project without its own list
 * inherits. Shortcuts are environment-wide, so the same action id shares its
 * binding on an environment.
 */
export function ProjectActionsSettings() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const representativeConfig = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
        ?.serverConfig
    : undefined;
  const scripts = target?.settings.defaultProjectScripts ?? [];
  const keybindings = representativeConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const mixed = targets.some(
    (candidate) =>
      JSON.stringify(candidate.settings.defaultProjectScripts) !== JSON.stringify(scripts),
  );
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const memberById = new Map(
    isProjectScope ? scope.members.map((member) => [member.id, member]) : [],
  );
  const { saving, persist, submit } = useProjectScriptSettings(
    targets.flatMap((candidate) => {
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
          // Writes read the raw environment settings so an override entry is
          // extended, not derived from already-resolved values.
          settings: environment.serverConfig.settings,
          keybindings: environment.serverConfig.keybindings,
          ...(member ? { project: member } : {}),
        },
      ];
    }),
  );

  // Read the project's t3.json from the representative checkout so a broken
  // file is flagged below.
  const representativeMember = target?.projectId ? memberById.get(target.projectId) : undefined;
  const goatFile = useGoatProjectFileState(
    representativeMember?.environmentId ?? EnvironmentId.make("none"),
    representativeMember?.workspaceRoot ?? null,
  );

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
            disabled={saving || !canWriteSettings || targets.length === 0}
            onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        }
      />
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          keybindings={keybindings}
          disabled={saving || !canWriteSettings}
          onEdit={(script) => setRequest(editorRequestForScript(script, keybindings))}
        />
      )}
      {goatFile.status === "invalid" ? (
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
