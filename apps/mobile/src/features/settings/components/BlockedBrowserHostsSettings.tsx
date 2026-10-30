import {
  addBlockedBrowserHost,
  removeBlockedBrowserHost,
} from "@goat/client-runtime/blocked-browser-hosts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";

export function BlockedBrowserHostsSettings(props: {
  readonly hosts: readonly string[] | null;
  readonly disabled: boolean;
  readonly onChange: (hosts: readonly string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disabled = props.disabled || props.hosts === null;
  const add = () => {
    if (disabled || props.hosts === null) return;
    const result = addBlockedBrowserHost(props.hosts, input);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    props.onChange(result.hosts);
    setInput("");
    setError(null);
  };
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-base font-goat-medium text-foreground">Blocked browser hosts</Text>
      <Text className="text-sm text-foreground-muted">
        Agents cannot use these hosts or their subdomains. Select one environment to edit its list.
      </Text>
      {(props.hosts ?? []).map((host) => (
        <View key={host} className="flex-row items-center justify-between gap-2">
          <Text className="text-foreground">{host}</Text>
          <Button
            label="Remove"
            accessibilityLabel={`Remove ${host}`}
            disabled={disabled}
            onPress={() => props.onChange(removeBlockedBrowserHost(props.hosts ?? [], host))}
          />
        </View>
      ))}
      <AppTextInput
        accessibilityLabel="Host to block"
        value={input}
        onChangeText={setInput}
        editable={!disabled}
        placeholder="example.com"
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-xl px-3 py-2 text-base text-foreground"
      />
      <Button label="Add host" disabled={disabled} onPress={add} />
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
