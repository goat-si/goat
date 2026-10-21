import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentSettings,
} from "../../hooks/useSettings";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { hostStatusAtom } from "../../state/hostStatus";
import {
  primaryServerConfigAtom,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComputerUseFirstRunPrompt } from "./ComputerUseFirstRunPrompt";
import { planFirstRunPrompts, openCodexSituation } from "./firstRunPrompts.logic";
import { GoatclawFirstRunDialog, OpenCodexFirstRunDialog } from "./HubFirstRunDialogs";
import { recordFirstRunPrompt } from "./recordFirstRunPrompt";

const hostLabel = () => (/Mac/.test(navigator.platform) ? "this Mac" : "this computer");

/**
 * The desktop's first-run questions for this machine. Each is asked once, and at most one per
 * launch, so answering one never lands the next dialog on top of where it sent you.
 */
export function FirstRunPrompts() {
  const hydrated = useClientSettingsHydrated();
  const prompts = useClientSettings((settings) => settings.firstRunPrompts);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const [closedOne, setClosedOne] = useState(false);
  if (!hydrated || closedOne || serverConfig === null || isLocalEnvironmentDisabled()) return null;
  const onClosed = () => setClosedOne(true);
  const environmentId = serverConfig.environment.environmentId;
  if (prompts.opencodex === "pending" || prompts.goatclaw === "pending")
    return <HubFirstRunPrompts environmentId={environmentId} onClosed={onClosed} />;
  return prompts.computerUse === "pending" ? (
    <ComputerUseFirstRunPrompt environmentId={environmentId} onClosed={onClosed} />
  ) : null;
}

function HubFirstRunPrompts({
  environmentId,
  onClosed,
}: {
  environmentId: EnvironmentId;
  onClosed: () => void;
}) {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const prompts = useClientSettings((settings) => settings.firstRunPrompts);
  const hostStatus = useAtomValue(hostStatusAtom(environmentId, { local: true }));
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const goatclaw = useEnvironmentSettings(environmentId, (settings) => settings.goatclaw);
  const hubOn = useEnvironmentSettings(environmentId, (settings) => settings.hub.enabled);
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const codex = providers.filter((provider) => provider.driver === "codex");
  const situation =
    hostStatus._tag === "Initial"
      ? ("loading" as const)
      : hostStatus._tag === "Success"
        ? openCodexSituation(
            hostStatus.value.hosts.find((entry) => entry.host === null)?.metrics?.opencodex,
          )
        : null;
  const plan = planFirstRunPrompts({
    prompts,
    opencodex: situation,
    codexInstanceId: codex[0]?.instanceId ?? null,
    codexUsesHome: codex.some((provider) => provider.codexRoute?.modelRoute === "opencodex"),
    goatclawOn: hubOn || goatclaw.enabled,
    canConfigure,
  });
  const answeredElsewhere = plan.answeredElsewhere.join(",");
  useEffect(() => {
    for (const id of answeredElsewhere.split(",")) {
      if (id === "opencodex" || id === "goatclaw") void recordFirstRunPrompt(id, "answered");
    }
  }, [answeredElsewhere]);

  if (plan.show === "computerUse")
    return <ComputerUseFirstRunPrompt environmentId={environmentId} onClosed={onClosed} />;
  if (situation === "loading" || situation === null) return null;
  if (plan.show === "opencodex")
    return (
      <OpenCodexFirstRunDialog
        hostLabel={hostLabel()}
        situation={situation}
        onClose={(outcome) => {
          void recordFirstRunPrompt("opencodex", outcome === "later" ? "later" : "answered");
          onClosed();
          const instanceId = codex[0]?.instanceId;
          if (outcome === "connect" && instanceId)
            void navigate({ to: "/settings/providers", search: { instanceId } });
        }}
      />
    );
  if (plan.show === "goatclaw" && situation.kind !== "linked")
    return (
      <GoatclawFirstRunDialog
        hostLabel={hostLabel()}
        situation={situation}
        profileIds={Object.keys(goatclaw.profiles)}
        defaultProfile={goatclaw.defaultProfile}
        onTurnOn={async (choice) => {
          if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)))
            return "This device can't change settings on this machine.";
          const result = await update({
            environmentId,
            input: {
              patch: {
                ...(choice.hub ? { hub: { enabled: true } } : {}),
                ...(choice.profiles
                  ? { goatclaw: { enabled: true, defaultProfile: choice.defaultProfile } }
                  : {}),
              },
            },
          });
          return result._tag === "Failure" ? "Could not save. Try again." : null;
        }}
        onClose={(outcome) => {
          void recordFirstRunPrompt("goatclaw", outcome);
          onClosed();
        }}
      />
    );
  return null;
}
