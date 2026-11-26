import type { EnvironmentId } from "@goat/contracts";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import type { EnvironmentPresentation } from "~/state/environments";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { EmptyRemoteEnvironments } from "./EmptyRemoteEnvironments";

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
  hasPendingAdds,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly hasPendingAdds: boolean;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={hasPendingAdds ? null : <EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 && !hasPendingAdds ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}
