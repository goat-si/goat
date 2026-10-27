import { DEFAULT_OPENCODEX_BASE_URL, type ProviderInstanceConfig } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ensureLocalApi } from "../../localApi";
import { CodexHomeRouteSection, type CodexHomeRouteSectionProps } from "./CodexHomeRouteSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";

type Props = Omit<
  CodexHomeRouteSectionProps,
  "settings" | "onChange" | "onOpenDashboard" | "onOpenHubSetup"
> & {
  readonly instance: ProviderInstanceConfig;
  /** The stored instance, or null when none is; the server refuses a write made against an older one. */
  readonly expectedInstance: ProviderInstanceConfig | null;
  readonly canOpenDashboard: boolean;
  readonly onConfigure: (
    instance: ProviderInstanceConfig,
    expectedInstance: ProviderInstanceConfig | null,
  ) => Promise<void>;
};
const LOCAL_ADDRESS = "Enter a local OpenCodex address such as http://127.0.0.1:10100/v1.";
function configString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Decodes one instance's Home route and writes changes back as one instance mutation over its
 * whole config, so fields this editor does not show, such as the route revision, survive.
 */
export function ProviderCodexHomeRouteSection({
  instance,
  expectedInstance,
  canOpenDashboard,
  onConfigure,
  ...props
}: Props) {
  const navigate = useNavigate();
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
      // A route saved here or elsewhere remounts the editor, so drafts start from stored values.
      key={JSON.stringify([
        props.environmentId,
        props.instanceId,
        props.driver ?? "codex",
        settings.setupMode,
        settings.modelRoute,
        settings.opencodexAuth,
        settings.opencodexBaseUrl,
      ])}
      settings={settings}
      onOpenHubSetup={() => void navigate({ to: "/settings/hub" })}
      onChange={async (route) => {
        await onConfigure(
          {
            ...instance,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              ...route,
            },
          },
          expectedInstance,
        );
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
