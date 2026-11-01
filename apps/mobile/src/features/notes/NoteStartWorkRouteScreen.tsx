import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type ModelSelection, type NoteWorkTarget } from "@goat/contracts";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { AppBar } from "../../components/ui/AppBar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentServerConfig } from "../../state/entities";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { Button } from "../../components/ui/Button";
import { beginNoteWorkAttempt, captureNoteWorkAttempt, type NoteWorkAttempt } from "./notes-model";
import { notesCommandOptions, notesError, useNotesPermissions } from "./notes-state";
import { notesRpc } from "./rpc/notes";
import { notesQueries } from "./rpc/queries";

const attempts = new Map<string, NoteWorkAttempt>();

export function NoteStartWorkRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; path: string }>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const attemptKey = JSON.stringify([environmentId, route.params.path]);
  const [attempt, setAttempt] = useState(
    () => attempts.get(attemptKey) ?? beginNoteWorkAttempt(uuidv4()),
  );
  const storeAttempt = (next: NoteWorkAttempt) => {
    attempts.set(attemptKey, next);
    setAttempt(next);
  };
  const config = useEnvironmentServerConfig(environmentId);
  const allowed = useNotesPermissions(environmentId);
  const startWork = useAtomCommand(notesRpc.startWork, notesCommandOptions);
  const [host, setHost] = useState<string | null>(
    attempt.input?.target.type === "host" ? attempt.input.target.host : null,
  );
  const [selectedTarget, setTarget] = useState<NoteWorkTarget | null>(
    attempt.input?.target ?? null,
  );
  const [model, setModel] = useState<ModelSelection | null>(attempt.input?.modelSelection ?? null);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  usePreventRemove(pending, () => undefined);
  useEffect(() => {
    if (completed && !pending) navigation.goBack();
  }, [completed, pending, navigation]);
  const [error, setError] = useState<string | null>(null);
  const targetsQuery = useEnvironmentQuery(notesQueries.workTargets({ environmentId, input: {} }));
  const projectsQuery = useEnvironmentQuery(
    host === null ? null : notesQueries.workTargetProjects({ environmentId, input: { host } }),
  );
  const targets = targetsQuery.data;
  const remoteProjects = projectsQuery.data;
  const projectQuery = host === null ? targetsQuery : projectsQuery;
  const discoveringProjects =
    projectQuery.isPending || (!projectQuery.isSuccess && projectQuery.error === null);
  const loadingProjects = discoveringProjects && projectQuery.data === null;
  const queryError = targetsQuery.error ?? (host === null ? null : projectsQuery.error);
  // A retry uses the captured request, so discovery cannot change or strand that attempt.
  const discoveryBlocked = attempt.input === null && (discoveringProjects || Boolean(queryError));
  const hosts = useMemo(
    () =>
      [...(targets?.hosts ?? [])].sort(
        (a, b) => Number(b.kind === "linked") - Number(a.kind === "linked"),
      ),
    [targets?.hosts],
  );
  const hubProject =
    targets?.hub.projects.find(
      (project) => selectedTarget?.type === "hub" && project.projectId === selectedTarget.projectId,
    ) ?? targets?.hub.projects[0];
  const remoteProject =
    remoteProjects?.projects.find(
      (project) =>
        selectedTarget?.type === "host" &&
        selectedTarget.host === host &&
        project.path === selectedTarget.projectPath,
    ) ?? remoteProjects?.projects[0];
  const target: NoteWorkTarget | null =
    attempt.input?.target ??
    (host === null
      ? hubProject
        ? { type: "hub", projectId: hubProject.projectId }
        : null
      : remoteProject
        ? { type: "host", host, projectPath: remoteProject.path }
        : null);
  const projectId = target?.type === "hub" ? target.projectId : null;
  const models = useMemo(
    () => buildModelOptions(config, model, undefined, projectId),
    [config, model, projectId],
  );
  const selectedModel = models.find(
    (option) =>
      option.selection.instanceId === model?.instanceId && option.selection.model === model.model,
  );
  const launch = async () => {
    if (!target || pending || completed || !allowed || discoveryBlocked || attempt.ambiguous)
      return;
    const captured = captureNoteWorkAttempt(attempt, {
      path: route.params.path,
      target,
      ...(model ? { modelSelection: model } : {}),
    });
    storeAttempt(captured);
    setPending(true);
    setError(null);
    await startWork({ environmentId, input: captured.input! })
      .then((result) => {
        if (AsyncResult.isSuccess(result)) {
          attempts.delete(attemptKey);
          setCompleted(true);
        } else if (AsyncResult.isFailure(result)) {
          const failure = Cause.squash(result.cause);
          const ambiguous =
            typeof failure === "object" &&
            failure !== null &&
            "reason" in failure &&
            failure.reason === "launch_ambiguous";
          storeAttempt({ ...captured, ambiguous });
          setError(notesError(failure));
        }
      })
      .catch((error: unknown) => setError(notesError(error)))
      .finally(() => setPending(false));
  };
  const frozen = pending || completed || attempt.input !== null;
  return (
    <View className="flex-1 bg-sheet">
      <AppBar title="Start work" sidebar={false} onBack={() => navigation.goBack()} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 p-4 pb-10"
      >
        <Text className="text-foreground-muted">{route.params.path}</Text>
        <Text className="font-goat-bold text-lg text-foreground">Node</Text>
        <Menu
          accessibilityLabel="Node"
          actions={[
            {
              id: "this-hub",
              title: "This hub",
              state: host === null ? "on" : "off",
              attributes: { disabled: frozen },
            },
            ...hosts.map((entry) => ({
              id: `host:${entry.host}`,
              title: entry.label,
              state: host === entry.host ? ("on" as const) : ("off" as const),
              attributes: { disabled: frozen },
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (frozen) return;
            const nextHost =
              nativeEvent.event === "this-hub"
                ? null
                : hosts.find((entry) => `host:${entry.host}` === nativeEvent.event)?.host;
            if (nextHost === undefined || nextHost === host) return;
            setHost(nextHost);
            const first = targets?.hub.projects[0];
            setTarget(
              nextHost === null && first ? { type: "hub", projectId: first.projectId } : null,
            );
          }}
        >
          <Button
            fullWidth
            label={
              host === null
                ? "This hub"
                : (hosts.find((entry) => entry.host === host)?.label ?? host)
            }
            accessibilityLabel="Choose node"
            tone="secondary"
            disabled={frozen}
            // The surrounding Menu opens on press; the button only draws the trigger.
            onPress={() => undefined}
          />
        </Menu>
        <Text className="font-goat-bold text-lg text-foreground">Project</Text>
        {host === null
          ? targets?.hub.projects.map((project) => {
              const selected = target?.type === "hub" && target.projectId === project.projectId;
              return (
                <Button
                  fullWidth
                  key={project.projectId}
                  label={selected ? `${project.title} · Selected` : project.title}
                  selected={selected}
                  tone={selected ? "primary" : "secondary"}
                  disabled={frozen}
                  onPress={() => setTarget({ type: "hub", projectId: project.projectId })}
                />
              );
            })
          : remoteProjects?.projects.map((project) => {
              const selected =
                target?.type === "host" &&
                target.host === host &&
                target.projectPath === project.path;
              return (
                <Button
                  fullWidth
                  key={project.path}
                  label={selected ? `${project.title} · Selected` : project.title}
                  selected={selected}
                  tone={selected ? "primary" : "secondary"}
                  disabled={frozen}
                  onPress={() => setTarget({ type: "host", host, projectPath: project.path })}
                />
              );
            })}
        {loadingProjects ? <Text className="text-foreground-muted">Loading projects…</Text> : null}
        {!loadingProjects &&
        projectQuery.isSuccess &&
        (host === null
          ? targets?.hub.projects.length === 0
          : remoteProjects?.projects.length === 0) ? (
          <Text className="text-foreground-muted">No projects available on this node.</Text>
        ) : null}
        <Text className="font-goat-bold text-lg text-foreground">Model</Text>
        <Menu
          accessibilityLabel="Model"
          actions={[
            {
              id: "hub-default",
              title: "Hub default",
              state: model === null ? "on" : "off",
              attributes: { disabled: frozen },
            },
            ...groupByProvider(models).map((group) => ({
              id: `provider:${group.providerKey}`,
              title: group.providerLabel,
              attributes: { disabled: frozen },
              subactions: group.models.map((option) => ({
                id: option.key,
                title: option.label,
                state: option === selectedModel ? ("on" as const) : ("off" as const),
                attributes: { disabled: frozen || option.isUnavailable },
              })),
            })),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (frozen) return;
            if (nativeEvent.event === "hub-default") setModel(null);
            else {
              const option = models.find((option) => option.key === nativeEvent.event);
              if (option && !option.isUnavailable) setModel(option.selection);
            }
          }}
        >
          <Button
            fullWidth
            label={
              model
                ? `${selectedModel?.providerLabel ?? model.instanceId} · ${selectedModel?.label ?? model.model}`
                : "Hub default"
            }
            accessibilityLabel="Choose model"
            tone="secondary"
            disabled={frozen}
            // The surrounding Menu opens on press; the button only draws the trigger.
            onPress={() => undefined}
          />
        </Menu>
        <Text className="text-sm text-foreground-muted">
          Work starts in the project folder with the hub's default runtime mode.
        </Text>
        {attempt.input ? (
          <Text className="text-sm text-foreground-muted">
            This attempt keeps the selected node, project and model when retried.
          </Text>
        ) : null}
        {attempt.ambiguous ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            The launch outcome is unknown. Check the host's threads before choosing Start again. A
            retry will not launch another thread automatically.
          </Text>
        ) : null}
        {error || queryError ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error ?? queryError}
          </Text>
        ) : null}
        <Button
          fullWidth
          tone="primary"
          label={pending ? "Starting…" : attempt.input ? "Retry this attempt" : "Start work"}
          disabled={
            !allowed || !target || pending || completed || discoveryBlocked || attempt.ambiguous
          }
          onPress={() => void launch()}
        />
        {attempt.input ? (
          <Button
            fullWidth
            label="Start again"
            tone="secondary"
            disabled={pending || completed}
            onPress={() => {
              storeAttempt(beginNoteWorkAttempt(uuidv4()));
              setError(null);
            }}
          />
        ) : null}
        <Button
          fullWidth
          label="Reload targets"
          tone="secondary"
          disabled={pending || completed}
          onPress={() => {
            targetsQuery.refresh();
            if (host !== null) projectsQuery.refresh();
          }}
        />
      </ScrollView>
    </View>
  );
}
