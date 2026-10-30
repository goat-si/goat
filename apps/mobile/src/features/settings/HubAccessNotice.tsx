import { useAtomValue } from "@effect/atom-react";
import {
  hubDeviceAccess,
  hubDeviceAccessNotice,
  type HubDeviceAccess,
} from "@goat/client-runtime/hub-nodes";
import type { EnvironmentId } from "@goat/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironments } from "../../state/environments";
import { environmentSession } from "../../state/session";

/** Null until the hub's config and this phone's session there are known. */
export function useHubDeviceAccess(environmentId: EnvironmentId): HubDeviceAccess | null {
  const { environments } = useEnvironments();
  const config =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig ?? null;
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const session = result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
  if (config === null || session === null) return null;
  return hubDeviceAccess({
    hubEnabled: config.settings.hub.enabled,
    hubProxySupported: config.environment.capabilities.hubProxy === true,
    session,
  });
}

/** Explains why a hub's devices do not open on this phone, with the pairing that fixes it. */
export function HubAccessNotice({
  environmentId,
  label,
  only,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Show just this case, for screens where the others would be noise. */
  readonly only?: HubDeviceAccess;
}) {
  const access = useHubDeviceAccess(environmentId);
  const navigation = useNavigation();
  const notice =
    access === null || (only !== undefined && access !== only)
      ? null
      : hubDeviceAccessNotice(access, label);
  if (notice === null) return null;
  return (
    <View accessibilityRole="alert" className="gap-2 rounded-xl bg-grouped-card p-4">
      <Text className="font-goat-medium text-foreground">{notice.title}</Text>
      <Text className="text-sm text-foreground-muted">{notice.body}</Text>
      {notice.repairs ? (
        <Button
          label="Scan new QR"
          // Pairs this same environment again (a QR for another address of it is accepted) and
          // uses that pairing first, since older routes keep their session without hub access.
          onPress={() =>
            navigation.navigate("SettingsEnvironmentNew", {
              routeFor: environmentId,
              preferRoute: true,
            })
          }
        />
      ) : null}
    </View>
  );
}
