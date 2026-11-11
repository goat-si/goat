import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthVoiceManageScope,
  DEFAULT_SPEECH_CONFIGURATION,
  type EnvironmentId,
  type SpeechConfiguration,
  type SpeechModelList,
  speechBenchmarkTiers,
} from "@goat/contracts";
import {
  configureEnvironmentSpeechEffect,
  downloadEnvironmentSpeechModelEffect,
  getEnvironmentSpeechConfigurationEffect,
  listEnvironmentSpeechModelsEffect,
  removeEnvironmentSpeechModelEffect,
} from "@goat/client-runtime/voice-input";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import {
  readEnvironmentProxiedByHub,
  readEnvironmentScope,
  useEnvironmentScope,
  usePreparedConnection,
} from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { voiceRequestContextsAtom } from "../voice-input/voiceEnvironment";
import { chooseVoiceEnvironment, voiceGrantAtom } from "../voice-input/voiceGrant";
import { runMobileSpeechRequest } from "../voice-input/mobileSpeechRequest";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function VoiceEnvironmentSettings() {
  const { environments } = useEnvironments();
  const grant = useAtomValue(voiceGrantAtom);
  const [error, setError] = useState<string | null>(null);
  const choose = (environmentId: EnvironmentId | null) => {
    try {
      chooseVoiceEnvironment(environmentId);
      setError(null);
    } catch {
      setError("Could not save the voice choice on this device.");
    }
  };
  return (
    <>
      <SettingsSection title="Voice transcription">
        <SettingsActionRow
          icon="iphone"
          label="Use existing voice input"
          detail={grant === null ? "Selected" : undefined}
          onPress={() => choose(null)}
        />
        {environments.map((environment) => (
          <EnvironmentRow
            key={environment.environmentId}
            environment={environment}
            selected={grant?.environmentId === environment.environmentId}
            onChoose={() => choose(environment.environmentId)}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Choosing an environment sends this device's recordings there for transcription. This choice
        stays on this device.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="px-2 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {grant ? <VoiceModels key={grant.environmentId} environmentId={grant.environmentId} /> : null}
    </>
  );
}

function EnvironmentRow({
  environment,
  selected,
  onChoose,
}: {
  environment: EnvironmentPresentation;
  selected: boolean;
  onChoose: () => void;
}) {
  const hasScope = useEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(environment.environmentId);
  const allowed =
    hasScope &&
    Option.isSome(connection) &&
    connection.value.target._tag !== "HubProxyConnectionTarget";
  return (
    <SettingsActionRow
      icon="server.rack"
      label={`Transcribe on ${environment.label}`}
      detail={selected ? "Selected" : undefined}
      disabled={!allowed}
      onPress={() => {
        if (
          readEnvironmentScope(environment.environmentId, AuthOrchestrationOperateScope) &&
          !readEnvironmentProxiedByHub(environment.environmentId)
        )
          onChoose();
      }}
    />
  );
}

type Model = (typeof SpeechModelList.Type.models)[number];
export function VoiceModelManagementSettings() {
  const { environments } = useEnvironments();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  return (
    <>
      <SettingsSection title="Environment voice models">
        {environments.map((environment) => (
          <ManagementEnvironmentRow
            key={environment.environmentId}
            environment={environment}
            selected={selected === environment.environmentId}
            onChoose={() => setSelected(environment.environmentId)}
          />
        ))}
      </SettingsSection>
      {selected ? <VoiceModels key={selected} environmentId={selected} /> : null}
    </>
  );
}

function ManagementEnvironmentRow({
  environment,
  selected,
  onChoose,
}: {
  environment: EnvironmentPresentation;
  selected: boolean;
  onChoose: () => void;
}) {
  const canManage = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environment.environmentId, {
      patch: { speech: DEFAULT_SPEECH_CONFIGURATION },
    }),
  );
  const connection = usePreparedConnection(environment.environmentId);
  const allowed =
    canManage &&
    Option.isSome(connection) &&
    connection.value.target._tag !== "HubProxyConnectionTarget";
  return (
    <SettingsActionRow
      icon="server.rack"
      label={`Manage models on ${environment.label}`}
      detail={selected ? "Selected" : undefined}
      disabled={!allowed}
      onPress={() => {
        if (
          readEnvironmentScope(environment.environmentId, AuthVoiceManageScope) &&
          !readEnvironmentProxiedByHub(environment.environmentId)
        )
          onChoose();
      }}
    />
  );
}

function VoiceModels({ environmentId }: { environmentId: EnvironmentId }) {
  const canManage = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: { speech: DEFAULT_SPEECH_CONFIGURATION },
    }),
  );
  const contexts = useAtomValue(voiceRequestContextsAtom);
  const context = contexts.get(environmentId);
  const [models, setModels] = useState<readonly Model[]>([]);
  const [config, setConfig] = useState<SpeechConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Model requests belong to the selected environment and stop when it changes.
  useEffect(() => {
    if (!context || !canManage || context.prepared.target._tag === "HubProxyConnectionTarget")
      return;
    const controller = new AbortController();
    active.current = controller;
    void Promise.all([
      runMobileSpeechRequest(listEnvironmentSpeechModelsEffect(context), controller.signal),
      runMobileSpeechRequest(getEnvironmentSpeechConfigurationEffect(context), controller.signal),
    ]).then(
      ([list, current]) => {
        if (controller.signal.aborted) return;
        setModels(list.models);
        setConfig(current);
        setBusy(false);
        setError(null);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : "Could not load voice models.");
        }
      },
    );
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [context, canManage]);
  async function change(action: "download" | "remove" | "select", modelId: string) {
    const signal = active.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      busy ||
      !canManage ||
      !readEnvironmentScope(environmentId, AuthVoiceManageScope) ||
      readEnvironmentProxiedByHub(environmentId)
    )
      return;
    const current = appAtomRegistry.get(voiceRequestContextsAtom).get(environmentId);
    if (!current) {
      setError("The environment is not connected.");
      return;
    }
    const operation =
      action === "download"
        ? downloadEnvironmentSpeechModelEffect(current, modelId)
        : action === "remove"
          ? removeEnvironmentSpeechModelEffect(current, modelId)
          : config
            ? configureEnvironmentSpeechEffect(current, { ...config, modelId })
            : null;
    if (!operation) {
      setError("The voice configuration is unavailable.");
      return;
    }
    setBusy(true);
    setError(null);
    // A promise chain instead of try/finally keeps this component compiled by React Compiler.
    const failure = await runMobileSpeechRequest(operation, signal)
      .then(() =>
        Promise.all([
          runMobileSpeechRequest(listEnvironmentSpeechModelsEffect(current), signal),
          runMobileSpeechRequest(getEnvironmentSpeechConfigurationEffect(current), signal),
        ]),
      )
      .then(([list, nextConfig]) => {
        signal.throwIfAborted();
        setModels(list.models);
        setConfig(nextConfig);
        return null;
      })
      .catch((cause: unknown) => cause ?? new Error("Could not update voice models."));
    if (signal.aborted) return;
    if (failure !== null)
      setError(failure instanceof Error ? failure.message : "Could not update voice models.");
    setBusy(false);
  }
  if (!canManage)
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        Voice management permission is required to install a model.
      </Text>
    );
  return (
    <View className="gap-2">
      <SettingsSection title="Voice models">
        {models.map((model) => (
          <View key={model.id}>
            <SettingsActionRow
              label={model.name}
              description={`${model.description} · ${(model.size / 1_000_000_000).toFixed(1)} GB`}
              detail={model.selected ? "Selected" : model.installed ? "Installed" : undefined}
              disabled={busy || (model.selected && model.installed)}
              onPress={() => void change(model.installed ? "select" : "download", model.id)}
            />
            {model.benchmark ? (
              <Text className="px-2 text-sm text-foreground-muted">
                Reference time for 30 s:{" "}
                {speechBenchmarkTiers(config?.acceleration).map((tier, index) => (
                  <Text key={tier}>
                    {index ? " · " : ""}
                    {tier === "cpu" ? "CPU" : "GPU"}{" "}
                    {model.benchmark?.[tier] == null
                      ? "not benchmarked"
                      : `${model.benchmark[tier]} s`}
                  </Text>
                ))}
              </Text>
            ) : null}
            {model.installed ? (
              <SettingsActionRow
                label={`Remove ${model.name}`}
                disabled={busy}
                onPress={() => void change("remove", model.id)}
              />
            ) : null}
          </View>
        ))}
      </SettingsSection>
      {busy ? <Text>Updating voice model…</Text> : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
