import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@goat/client-runtime/provider-instance-ids";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@goat/contracts";

export function planClaudeAccount(
  name: string,
  configDir: string,
  existing: Readonly<Record<string, ProviderInstanceConfig>>,
) {
  const label = name.trim();
  const homePath = configDir.trim();
  if (!label) return { error: "Enter a name for this account." } as const;
  if (!homePath)
    return { error: "Enter the Claude config folder this account is signed in with." } as const;
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make(
    deriveAvailableInstanceId(
      (value) => deriveInstanceId(driver, value) || driver,
      label,
      new Set([driver, ...Object.keys(existing)]),
    ),
  );
  return {
    mutation: {
      operation: "create" as const,
      instanceId,
      instance: { driver, enabled: true, displayName: label, config: { homePath } },
    },
  } as const;
}
