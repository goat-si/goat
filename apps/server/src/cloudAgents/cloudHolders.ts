import type {
  CloudAgentProvider,
  CloudHolder,
  CloudHolderName,
  ProviderDiagnosis,
  ProviderDiagnosisReason,
  ProviderHostCloudCell,
  ProviderHostCloudReadiness,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/**
 * Pure decisions for cloud credential holders: what one environment's provider diagnosis says
 * about holding a provider's runs, and which holder a launch goes to.
 *
 * @module cloudAgents/cloudHolders
 */

export const CLOUD_AGENT_LABELS: Record<CloudAgentProvider, string> = {
  claudeCloud: "Claude Cloud",
  cursorCloud: "Cursor Cloud",
  devinCloud: "Devin Cloud",
};

/** What a person runs, on the machine that should hold the login. */
const CLOUD_AGENT_LOGIN_STEP: Record<CloudAgentProvider, string> = {
  claudeCloud: "run `claude auth login --claudeai`",
  cursorCloud: "sign in to Cursor in GOAT Settings and enable Cursor Cloud",
  devinCloud: "sign in to Devin (`devin auth login`) and enable Devin Cloud",
};

/** The sign-in command a person runs; fixed, so no environment value rides along. */
const LOGIN_COMMAND: Partial<Record<CloudAgentProvider, string>> = {
  claudeCloud: "claude auth login --claudeai",
  devinCloud: "devin auth login",
};

/**
 * A holder's answer leaves its machine, so it says why in fixed words. Diagnosis summaries
 * and fixes can quote paths or environment values from that machine.
 */
const REASON_TEXT: Record<ProviderDiagnosisReason, string> = {
  instance_missing: "No instance is configured.",
  driver_unavailable: "This GOAT build does not include the provider.",
  disabled: "The provider is turned off in Settings.",
  sibling_missing: "The local provider it signs in through is missing.",
  sibling_invalid: "The local provider it signs in through is not usable.",
  sibling_not_ready: "The local provider it signs in through is not ready.",
  forbidden_environment:
    "The provider's environment overrides its sign-in (API key, proxy or Git variables).",
  executable_missing: "The provider's CLI is not installed.",
  version_unsupported: "The provider's CLI is too old.",
  cloud_unsupported: "The provider's CLI cannot start cloud runs.",
  not_signed_in: "Not signed in.",
  wrong_sign_in: "Signed in to the wrong kind of account.",
  not_checked: "Not checked yet.",
  provider_error: "The provider reported an error.",
  probe_failed: "The readiness check failed.",
  repository_missing: "The project has no repository remote.",
  repository_unsupported: "The project's repository host is not supported.",
  repository_access_unverified: "Repository access is unverified.",
};

/**
 * Whether a run started outside GOAT can be followed through the holder's sign-in. Devin's CLI
 * binds sessions to the sign-in that created them, so registered Devin sessions stay link-only.
 */
export const CAN_FOLLOW_REGISTERED: Record<CloudAgentProvider, boolean> = {
  claudeCloud: true,
  cursorCloud: true,
  devinCloud: false,
};

/** The provider's best instance on one environment, reduced to the holder's answer. */
export function holderFromDiagnoses(input: {
  readonly provider: CloudAgentProvider;
  readonly host: string | null;
  readonly diagnoses: ReadonlyArray<ProviderDiagnosis>;
  readonly runtime: CloudHolder["runtime"];
  readonly accountLabel?: (instanceId: string) => string | undefined;
  readonly activeRuns?: number;
}): CloudHolder {
  const ofProvider = input.diagnoses.filter((diagnosis) => diagnosis.driver === input.provider);
  const chosen =
    ofProvider.find((diagnosis) => diagnosis.ready) ??
    ofProvider.find((diagnosis) => diagnosis.configured) ??
    ofProvider[0];
  const base = {
    provider: input.provider,
    host: input.host,
    runtime: input.runtime,
    ...(input.activeRuns === undefined ? {} : { activeRuns: input.activeRuns }),
  } as const;
  if (chosen === undefined)
    return {
      ...base,
      ready: false,
      reason: `No ${CLOUD_AGENT_LABELS[input.provider]} instance here.`,
    };
  const failed = chosen.checks.find((check) => check.status === "fail");
  const label = chosen.ready ? input.accountLabel?.(chosen.instanceId) : undefined;
  const signIn = failed?.reason === "not_signed_in" || failed?.reason === "wrong_sign_in";
  const command = signIn ? LOGIN_COMMAND[input.provider] : undefined;
  return {
    ...base,
    instanceId: chosen.instanceId,
    ready: chosen.ready,
    ...(label === undefined ? {} : { accountLabel: label.slice(0, 200) }),
    ...(failed === undefined
      ? {}
      : {
          reason:
            failed.reason === undefined ? "A readiness check failed." : REASON_TEXT[failed.reason],
        }),
    ...(command === undefined ? {} : { command }),
  };
}

const cloudCell = (holder: CloudHolder): ProviderHostCloudCell => ({
  ready: holder.ready,
  ...(holder.instanceId === undefined ? {} : { instanceId: holder.instanceId }),
  ...(holder.accountLabel === undefined ? {} : { accountLabel: holder.accountLabel }),
  ...(holder.reason === undefined ? {} : { reason: holder.reason }),
  ...(holder.command === undefined ? {} : { command: holder.command }),
  ...(holder.activeRuns === undefined ? {} : { activeRuns: holder.activeRuns }),
  ...(holder.hub === true ? { hub: true } : {}),
});

/** The matrix column for one machine: one cell per cloud driver, from `holderFromDiagnoses`. */
export function cloudReadinessFromHolders(
  holders: ReadonlyArray<CloudHolder>,
): ProviderHostCloudReadiness {
  const cell = (provider: CloudAgentProvider): ProviderHostCloudCell => {
    const holder = holders.find((item) => item.provider === provider);
    return holder === undefined
      ? { ready: false, reason: `No ${CLOUD_AGENT_LABELS[provider]} instance here.` }
      : cloudCell(holder);
  };
  return {
    claudeCloud: cell("claudeCloud"),
    cursorCloud: cell("cursorCloud"),
    devinCloud: cell("devinCloud"),
  };
}

/** A matrix cell placed back on a host. Runtime is the caller's, not the cell's. */
export function holderFromCloudCell(input: {
  readonly provider: CloudAgentProvider;
  readonly host: string | null;
  readonly runtime: CloudHolder["runtime"];
  readonly cell: ProviderHostCloudCell;
}): CloudHolder {
  return {
    provider: input.provider,
    host: input.host,
    runtime: input.runtime,
    ...cloudCell({
      provider: input.provider,
      host: input.host,
      runtime: input.runtime,
      ...input.cell,
    }),
  };
}

/** A holder that answered for a host which cannot take routed launches is shown, not used. */
const usable = (holder: CloudHolder) => holder.ready && holder.runtime === "current";

const nameOf = (holder: CloudHolder) => holder.host ?? "local";
const byLocalThenName = (left: CloudHolder, right: CloudHolder) =>
  left.host === null ? -1 : right.host === null ? 1 : left.host.localeCompare(right.host);

export type HolderChoice =
  | { readonly ok: true; readonly holder: CloudHolder }
  | { readonly ok: false; readonly message: string };

/**
 * Explicit preference first, then the hub when it holds cloud launches; otherwise a ready holder
 * whose runtime takes routed calls, the least loaded, then this environment, then hosts by name,
 * so the same table always picks the same holder. The hub is held to like an explicit choice: a
 * different holder bills a different account, so a hub without a usable login fails instead.
 */
export function chooseHolder(
  provider: CloudAgentProvider,
  holders: ReadonlyArray<CloudHolder>,
  explicit: CloudHolderName | undefined,
): HolderChoice {
  const label = CLOUD_AGENT_LABELS[provider];
  const candidates = holders.filter((holder) => holder.provider === provider);
  const hub = candidates
    .filter((holder) => holder.hub === true)
    .toSorted(byLocalThenName)
    .map(nameOf)[0];
  const preference = explicit ?? hub;
  if (preference !== undefined) {
    const wanted = candidates.find((holder) => nameOf(holder) === preference);
    if (wanted === undefined)
      return {
        ok: false,
        message: `${preference} is not a connected holder for ${label}. ${goatCallText("cloud_agent.holders")} lists them.`,
      };
    if (wanted.runtime === "update_required")
      return {
        ok: false,
        message: `Update GOAT on ${preference}: it cannot take routed ${label} launches yet.`,
      };
    if (wanted.runtime === "unreachable")
      return {
        ok: false,
        message: `${preference} is unreachable: ${wanted.reason ?? "no answer"}`,
      };
    if (!wanted.ready)
      return {
        ok: false,
        message: `${preference} holds no usable ${label} login: ${wanted.reason ?? "not ready"}${explicit === undefined ? " It is the hub, which holds cloud launches; sign in there or set hub.cloudHolder to auto." : ""}`,
      };
    return { ok: true, holder: wanted };
  }
  const ready = candidates
    .filter(usable)
    .toSorted(
      (left, right) =>
        (left.activeRuns ?? 0) - (right.activeRuns ?? 0) || byLocalThenName(left, right),
    );
  if (ready[0] !== undefined) return { ok: true, holder: ready[0] };
  const outdated = candidates.filter(
    (holder) => holder.ready && holder.runtime === "update_required",
  );
  const names = candidates.map(nameOf);
  return {
    ok: false,
    message:
      outdated.length > 0
        ? `${label} logins exist on ${outdated.map(nameOf).join(", ")}, but GOAT there is too old to take routed launches. Update GOAT on one of them.`
        : `No connected host holds a ${label} login; ${CLOUD_AGENT_LOGIN_STEP[provider]} on one of: ${names.length === 0 ? "this machine" : names.join(", ")}.`,
  };
}
