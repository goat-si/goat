import { useState } from "react";
import { View } from "react-native";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { restoreConnectKeyAccess } from "./cloudAccountService";
import { refreshManagedRelayEnvironments } from "./managedRelayState";

export function RestoreConnectAccessButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-2 px-6 py-3">
      <Text>After signing in again with MFA, restore this device’s Connect access.</Text>
      <Button
        label="Restore Connect access"
        disabled={pending}
        onPress={async () => {
          setPending(true);
          setError(null);
          try {
            await restoreConnectKeyAccess();
            refreshManagedRelayEnvironments();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not restore Connect access.");
          }
          setPending(false);
        }}
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
