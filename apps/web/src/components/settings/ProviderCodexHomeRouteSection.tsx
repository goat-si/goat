import { DEFAULT_OPENCODEX_BASE_URL, type ProviderInstanceConfig } from "@goat/contracts";
import { ensureLocalApi } from "../../localApi";
import { CodexHomeRouteSection, type CodexHomeRouteSectionProps } from "./CodexHomeRouteSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";

type Props = Omit<CodexHomeRouteSectionProps, "settings" | "onChange" | "onOpenDashboard"> & {
  readonly instance: ProviderInstanceConfig;
  readonly canOpenDashboard: boolean;
  readonly onConfigure: (instance: ProviderInstanceConfig) => Promise<void>;
};
const LOCAL_ADDRESS = "Enter a local OpenCodex address such as http://127.0.0.1:10100/v1.";
function configString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Decodes one Codex instance's Home route and writes changes back as one instance mutation. */
export function ProviderCodexHomeRouteSection({
  instance,
  canOpenDashboard,
  onConfigure,
  ...props
}: Props) {
  const settings = {
    setupMode: readCodexSetupMode(instance.config),
    modelRoute:
      configString(instance.config, "modelRoute") === "opencodex"
        ? ("opencodex" as const)
        : ("default" as const),
    opencodexBaseUrl:
      configString(instance.config, "opencodexBaseUrl") ?? DEFAULT_OPENCODEX_BASE_URL,
    opencodexAuth:
      configString(instance.config, "opencodexAuth") === "none"
        ? ("none" as const)
        : ("openai" as const),
  };
  return (
    <CodexHomeRouteSection
      {...props}
      // A saved route remounts the editor so its drafts start from the stored values.
      key={`${props.instanceId}:${settings.modelRoute}:${settings.opencodexAuth}:${settings.opencodexBaseUrl}`}
      settings={settings}
      onChange={async (route) => {
        await onConfigure({
          ...instance,
          config: {
            ...(instance.config !== null && typeof instance.config === "object"
              ? instance.config
              : {}),
            ...route,
          },
        });
      }}
      onOpenDashboard={
        canOpenDashboard
          ? async () => {
              const baseUrl = settings.opencodexBaseUrl;
              if (!URL.canParse(baseUrl)) throw new Error(LOCAL_ADDRESS);
              const url = new URL(baseUrl);
              if (
                url.protocol !== "http:" ||
                !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
                url.username ||
                url.password
              )
                throw new Error(LOCAL_ADDRESS);
              await ensureLocalApi().shell.openExternal(url.origin);
            }
          : undefined
      }
    />
  );
}
