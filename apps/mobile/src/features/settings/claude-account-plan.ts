import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@goat/client-runtime/provider-instance-ids";
import {
  defaultInstanceIdForDriver,
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

export function claudeAccountDirectory(instance: ProviderInstanceConfig): string {
  const config = instance.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  return "homePath" in config && typeof config.homePath === "string" ? config.homePath : "";
}

export function planClaudeAccountEdit(
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
  directory: string,
  supportsPreconditions: boolean,
  name?: string,
) {
  const config =
    instance.config && typeof instance.config === "object" && !Array.isArray(instance.config)
      ? (instance.config as Record<string, unknown>)
      : {};
  const { homePath: _old, ...remaining } = config;
  const homePath = directory.trim();
  const { displayName: _oldName, ...otherFields } = instance;
  const label = name?.trim();
  const identity =
    name === undefined ? instance : { ...otherFields, ...(label ? { displayName: label } : {}) };
  return {
    operation: "upsert" as const,
    instanceId,
    instance: { ...identity, config: homePath ? { ...remaining, homePath } : remaining },
    ...(supportsPreconditions ? { expectedInstance: instance } : {}),
  };
}

export function planClaudeAccountRemoval(instanceId: ProviderInstanceId) {
  if (instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")))
    return null;
  return { operation: "remove" as const, instanceId };
}
