import { resolveProjectProviderInstanceEnabled, type ServerConfig } from "@goat/contracts";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { resolvePastedPath } from "@goat/shared/path";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions } from "../../lib/modelOptions";
import { resolveNewTaskBranchLabel } from "../threads/new-task-context-presentation";
import { SettingsSection } from "./components/SettingsSection";
import { FormField, SelectRow } from "./ScheduledTaskFormFields";
import { scheduledTaskDefaultModel, type ScheduledTaskDraft as Draft } from "./scheduledTaskDraft";

function PickerRow(props: {
  readonly label: string;
  readonly value: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.value}`}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.borderTop
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70 disabled:opacity-50"
      }
    >
      <Text className="text-lg text-foreground">{props.label}</Text>
      <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
        {props.value}
      </Text>
      <SymbolView
        name="chevron.right"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * Where and with what a task runs. GOAT Bot answers its routines with its own model, so for one of
 * those the project, model and workspace are neither shown nor changed.
 */
export function ScheduledTaskContextSections({
  draft,
  setDraft,
  config,
  projects,
  saving,
  locked,
  onPickModel,
  onPickBranch,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly config: ServerConfig | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly saving: boolean;
  /** Saving, dictating, or the environment is gone. */
  readonly locked: boolean;
  readonly onPickModel: () => void;
  readonly onPickBranch: () => void;
}) {
  if (draft.task?.goatBotRoutine === true)
    return (
      <SettingsSection title="GOAT Bot">
        <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
          <Text className="text-lg text-foreground">Model</Text>
          <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted">
            {"GOAT Bot's model"}
          </Text>
        </View>
        <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
          This routine sends its prompt to GOAT Bot. GOAT Bot answers with its own model settings,
          so a model chosen here would not be used.
        </Text>
      </SettingsSection>
    );
  const modelOptions = buildModelOptions(config, null, undefined, draft.projectId);
  return (
    <>
      <SettingsSection title="Context">
        <SelectRow
          label="Project"
          value={
            projects.find((project) => project.id === draft.projectId)?.title ??
            (projects.length ? "Choose project" : "No projects available")
          }
          actions={projects.map((project) => ({
            id: project.id,
            title: project.title,
            state: project.id === draft.projectId ? "on" : undefined,
          }))}
          onSelect={(id) => {
            const project = projects.find((item) => item.id === id);
            if (!project) return;
            const keepsExplicitModel =
              draft.modelSelectionIsExplicit &&
              (draft.modelSelection === null ||
                !config?.settings ||
                resolveProjectProviderInstanceEnabled(
                  config.settings,
                  project.id,
                  draft.modelSelection.instanceId,
                ));
            setDraft({
              ...draft,
              projectId: project.id,
              modelSelection: keepsExplicitModel
                ? draft.modelSelection
                : scheduledTaskDefaultModel(config, project),
              modelSelectionIsExplicit: keepsExplicitModel,
            });
          }}
        />
        <PickerRow
          label="Model"
          borderTop
          value={
            modelOptions.find(
              (option) =>
                option.selection.instanceId === draft.modelSelection?.instanceId &&
                option.selection.model === draft.modelSelection?.model,
            )?.label ??
            draft.modelSelection?.model ??
            (modelOptions.length ? "Choose model" : "No models available")
          }
          onPress={onPickModel}
          disabled={locked}
        />
      </SettingsSection>

      <SettingsSection title="Workspace">
        <SelectRow
          label="Run in"
          value={
            draft.workspace === "worktree"
              ? "New worktree"
              : draft.workspace === "root"
                ? "Project checkout"
                : "Specific checkout"
          }
          actions={[
            {
              id: "worktree",
              title: "New worktree",
              state: draft.workspace === "worktree" ? "on" : undefined,
            },
            {
              id: "root",
              title: "Project checkout",
              state: draft.workspace === "root" ? "on" : undefined,
            },
            {
              id: "existing_worktree",
              title: "Specific checkout",
              state: draft.workspace === "existing_worktree" ? "on" : undefined,
            },
          ]}
          onSelect={(id) => {
            if (id === "worktree" || id === "root" || id === "existing_worktree")
              setDraft({ ...draft, workspace: id });
          }}
        />
        {draft.workspace === "worktree" ? (
          <PickerRow
            label="Base branch"
            value={resolveNewTaskBranchLabel({
              branchName: draft.baseRef,
              startFromOrigin: draft.startFromOrigin,
              workspaceMode: "worktree",
            })}
            borderTop
            disabled={!draft.projectId || locked}
            onPress={onPickBranch}
          />
        ) : null}
        {draft.workspace === "existing_worktree" ? (
          <FormField
            label="Checkout path"
            disabled={saving}
            value={draft.checkoutPath}
            borderTop
            onChange={(checkoutPath) =>
              setDraft({
                ...draft,
                checkoutPath: resolvePastedPath(draft.checkoutPath, checkoutPath),
              })
            }
          />
        ) : null}
      </SettingsSection>
    </>
  );
}
