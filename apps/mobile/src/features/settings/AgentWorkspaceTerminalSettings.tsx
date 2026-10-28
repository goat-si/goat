import { useAtomValue } from "@effect/atom-react";
import type { ServerSettingsPatch } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

type AccessKey = "agentWorkspaceAccess" | "agentTerminalAccess";

export function AgentWorkspaceTerminalSettings(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly projectSelected: boolean;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly writeEach: (writes: ReturnType<typeof planMobileScopedSettingsPatch>) => void;
}) {
  return (
    <>
      {(["agentWorkspaceAccess", "agentTerminalAccess"] as const).map((setting) => (
        <AccessSection key={setting} {...props} setting={setting} />
      ))}
    </>
  );
}

function AccessSection({
  setting,
  targets,
  projectSelected,
  disabled,
  write,
  writeEach,
}: {
  readonly setting: AccessKey;
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly projectSelected: boolean;
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly writeEach: (writes: ReturnType<typeof planMobileScopedSettingsPatch>) => void;
}) {
  const workspace = setting === "agentWorkspaceAccess";
  const choices = workspace
    ? ([
        { value: "off", label: "Off" },
        { value: "read", label: "Read" },
        { value: "read_write", label: "Read and write" },
      ] as const)
    : ([
        { value: "off", label: "Off" },
        { value: "read", label: "Read" },
        { value: "operate", label: "Operate" },
      ] as const);
  const select = (value: "off" | "read" | "read_write" | "operate") => {
    if (workspace && (value === "off" || value === "read" || value === "read_write"))
      write({ agentWorkspaceAccess: value });
    if (!workspace && (value === "off" || value === "read" || value === "operate"))
      write({ agentTerminalAccess: value });
  };
  const allowed = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const writes = planMobileScopedSettingsPatch(
            targets,
            projectSelected,
            setting === "agentWorkspaceAccess"
              ? { agentWorkspaceAccess: "off" }
              : { agentTerminalAccess: "off" },
          );
          return (
            writes.length > 0 &&
            writes.every(({ environmentId, patch: next }) =>
              get(serverEnvironment.updateSettings.permissionAtom(environmentId, { patch: next })),
            )
          );
        }),
      [targets, projectSelected, setting],
    ),
  );
  const reference = targets[0];
  const mixed = targets.some((target) => target.settings[setting] !== reference?.settings[setting]);
  const inherited =
    projectSelected && targets.every((target) => target.sources[setting] !== "project");
  const sourceMixed =
    projectSelected &&
    targets.some((target) => target.sources[setting] !== reference?.sources[setting]);
  const valueLabel = mixed
    ? "Mixed"
    : (choices.find((choice) => choice.value === reference?.settings[setting])?.label ?? "Off");
  const reset = () =>
    projectSelected ? writeEach(planMobileScopedSettingsClear(targets, [setting])) : select("off");
  return (
    <SettingsSection
      title={workspace ? "Agent workspace access" : "Agent terminal access"}
      trailing={
        <Button label="Reset" tone="text" disabled={disabled || !allowed} onPress={reset} />
      }
    >
      {projectSelected ? (
        <SettingsChoiceRow
          label="Inherit"
          description={`Follow the environment or project file. Effective: ${valueLabel}.`}
          selected={inherited}
          disabled={disabled || !allowed}
          onPress={reset}
        />
      ) : null}
      {choices.map((choice, index) => (
        <SettingsChoiceRow
          key={choice.value}
          label={choice.label}
          selected={
            !mixed && !sourceMixed && !inherited && reference?.settings[setting] === choice.value
          }
          separated={projectSelected || index > 0}
          disabled={disabled || !allowed}
          onPress={() => select(choice.value)}
        />
      ))}
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          {projectSelected
            ? `${sourceMixed ? "Mixed sources" : inherited ? "Inherited" : "Project override"}. Effective: ${valueLabel}.`
            : `Environment default: ${valueLabel}. Projects can override it.`}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {workspace
            ? "Explicit agent consent is also required. Off blocks new workspace calls."
            : "Operate permits shell execution with the server's OS file and network authority. The starting workspace directory is not a sandbox. Off blocks new calls but does not stop running terminals; close them in the terminal view."}
        </Text>
      </View>
    </SettingsSection>
  );
}
