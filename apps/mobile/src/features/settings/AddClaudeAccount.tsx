import { useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope } from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { planClaudeAccount } from "./claude-account-plan";
import type { SettingsTarget } from "./settings-environment-filter";

export function AddClaudeAccount({ environment }: { readonly environment: SettingsTarget }) {
  const environmentId = environment.environmentId;
  const permitted = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const hasScope = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const config = useEnvironmentQuery(
    serverEnvironment.configProjection({ environmentId, input: {} }),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const enabled =
    permitted && hasScope && config.data !== null && !config.isPending && config.error === null;
  async function save() {
    if (
      pendingRef.current ||
      !enabled ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope)
    )
      return;
    const settings = config.data?.config.settings;
    if (!settings) return;
    const result = planClaudeAccount(name, directory, settings.providerInstances);
    if (result.error !== undefined) {
      setError(result.error);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    await mutate({
      environmentId,
      input: { patch: {}, providerInstanceMutation: result.mutation },
    })
      .then((saved) => {
        if (saved._tag === "Failure") {
          const failure = squashAtomCommandFailure(saved);
          setError(
            failure instanceof Error ? failure.message : "Could not add the Claude account.",
          );
          return;
        }
        setAdding(false);
        setName("");
        setDirectory("");
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }
  if (!adding)
    return (
      <ListActionRow
        icon="plus"
        label="Add Claude account"
        description="Use a Claude config folder already signed in on this environment."
        disabled={!enabled}
        onPress={() => setAdding(true)}
      />
    );
  return (
    <View className="gap-2 px-4 py-3">
      <Text
        textRole="footnote"
        className="text-foreground-muted"
      >{`Enter a Claude config folder on ${environment.label} that is already signed in.`}</Text>
      <TextInput
        accessibilityLabel="Account name"
        placeholder="Name, e.g. Work"
        value={name}
        onChangeText={setName}
        editable={!pending}
        autoCorrect={false}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      />
      <TextInput
        accessibilityLabel="Claude config folder"
        placeholder="Config folder, e.g. ~/.claude-work"
        value={directory}
        onChangeText={setDirectory}
        editable={!pending}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-2">
        <ControlPill
          variant="pill"
          label="Cancel"
          disabled={pending}
          onPress={() => setAdding(false)}
        />
        <ControlPill
          variant="primary"
          label="Add"
          disabled={!enabled || pending}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
