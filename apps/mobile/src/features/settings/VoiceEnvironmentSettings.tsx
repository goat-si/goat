import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  AuthVoiceManageScope,
  DEFAULT_SPEECH_CONFIGURATION,
  type EnvironmentId,
  type SpeechConfiguration,
  type SpeechModelList,
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
    setBusy(true);
    setError(null);
    try {
      const operation =
        action === "download"
          ? downloadEnvironmentSpeechModelEffect(current, modelId)
          : action === "remove"
            ? removeEnvironmentSpeechModelEffect(current, modelId)
            : config
              ? configureEnvironmentSpeechEffect(current, { ...config, modelId })
              : null;
      if (!operation) throw new Error("The voice configuration is unavailable.");
      await runMobileSpeechRequest(operation, signal);
      const [list, nextConfig] = await Promise.all([
        runMobileSpeechRequest(listEnvironmentSpeechModelsEffect(current), signal),
        runMobileSpeechRequest(getEnvironmentSpeechConfigurationEffect(current), signal),
      ]);
      signal.throwIfAborted();
      setModels(list.models);
      setConfig(nextConfig);
    } catch (cause) {
      if (!signal.aborted)
        setError(cause instanceof Error ? cause.message : "Could not update voice models.");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
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
