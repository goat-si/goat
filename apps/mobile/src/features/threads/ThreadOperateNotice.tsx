import { AuthOrchestrationOperateScope, type EnvironmentId } from "@goat/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentScopeDenied } from "../../state/session";

export function ThreadOperateNotice({
  environmentId,
  connected,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const denied = useEnvironmentScopeDenied(environmentId, AuthOrchestrationOperateScope);
  return connected && denied ? (
    <Text className="pt-2 text-xs text-foreground-muted">
      This connection cannot control this task. You can still edit your draft.
    </Text>
  ) : null;
}
