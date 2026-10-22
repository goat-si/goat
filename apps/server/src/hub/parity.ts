import type { HubParityResult, OpenCodexInventorySnapshot } from "@goat/contracts";

const originOf = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

/** Home-owned records are authoritative; a Child does not need a local link directory. */
export function parityVerdict(input: {
  deviceAlias: string;
  checkedAt: number;
  home?: OpenCodexInventorySnapshot;
  device?: OpenCodexInventorySnapshot;
}): HubParityResult {
  const { home, device } = input;
  const source = home?.parityEvidence;
  const target = device?.parityEvidence;
  const link = home?.link.links.find(({ alias }) => alias === input.deviceAlias);
  // A Hub client has no Remote Link record; its evidence is `ocx connect status` (design §1.4 P2).
  const client = device?.hubClient;
  const checks: Array<HubParityResult["checks"][number]> = [];
  const add = (
    id: HubParityResult["checks"][number]["id"],
    status: HubParityResult["checks"][number]["status"],
    reason: string,
  ) => checks.push({ id, status, reason });

  if (!device?.runtime.healthy) add("P1", "failed", "Device OpenCodex health is unavailable.");
  else if (!target) add("P1", "unproven", "Device does not report parity evidence.");
  else
    add(
      "P1",
      target.healthRole === "client" ? "ok" : "failed",
      target.healthRole === "client"
        ? "Device serves OpenCodex as a client."
        : "Device health does not report the client role.",
    );

  if (client) {
    if (!home?.runtime.healthy || home.runtime.role !== "hub")
      add("P2", "failed", "This machine is not serving as an OpenCodex Hub.");
    else if (client.state !== "connected")
      add("P2", "failed", `Hub client connection is ${client.state}.`);
    else if (!client.apiKeyId) add("P2", "unproven", "Hub client reports no API key id.");
    else add("P2", "ok", `Hub client is connected with data key ${client.apiKeyId}.`);
  } else if (!home?.runtime.healthy || home.link.role !== "home")
    add("P2", "failed", "Home link status is unavailable.");
  else if (!home.link.available) add("P2", "unproven", "Home link status could not be read.");
  else if (!link) add("P2", "failed", "Home has no link record for this device.");
  else if (link.state !== "connected") add("P2", "failed", "Home tunnel is not connected.");
  else if (!target?.childLinkId) add("P2", "unproven", "Child link identity is not reported.");
  else
    add(
      "P2",
      device?.link.role === "child" && target.childLinkId === link.id ? "ok" : "failed",
      device?.link.role === "child" && target.childLinkId === link.id
        ? "Child identity matches the Home record."
        : "Child identity differs from the Home record.",
    );

  if (!device) add("P3", "failed", "Device cannot perform the models request.");
  else if (!target) add("P3", "unproven", "Device does not report a models request.");
  else if (target.modelsStatus !== 200 || !target.catalogDigest)
    add("P3", "failed", "Device GET /v1/models did not return a valid catalog with HTTP 200.");
  else if (!home?.runtime.healthy || source?.modelsStatus !== 200 || !source.catalogDigest)
    add("P3", "failed", "Home catalog is unavailable for comparison.");
  else
    add(
      "P3",
      target.catalogDigest === source.catalogDigest ? "ok" : "failed",
      target.catalogDigest === source.catalogDigest
        ? "Relayed catalog matches Home."
        : "Relayed catalog differs from Home.",
    );

  if (target?.servedBy && source?.instanceId)
    add(
      "P4",
      target.servedBy === source.instanceId ? "ok" : "failed",
      target.servedBy === source.instanceId
        ? "Response names this Home."
        : "Response names a different Home.",
    );
  else if (client) {
    const served = originOf(target?.hubServerUrl);
    const advertised = originOf(source?.hubDataOrigin);
    if (served === undefined || advertised === undefined)
      add("P4", "unproven", "Hub client server URL or the Home's hub data origin is unavailable.");
    else
      add(
        "P4",
        served === advertised ? "ok" : "failed",
        served === advertised
          ? "Hub client uses this Home's data origin."
          : "Hub client uses another hub's data origin.",
      );
  } else
    add("P4", "unproven", "Served-by header or stable Home instance id is unavailable (OCX-2).");

  if (client) add("P5", "skipped", "Hub clients receive no Home settings apply.");
  else if (target?.startedAt === undefined || link?.lastApplyAt === undefined)
    add("P5", "skipped", "Runtime start or Home last-apply time is unavailable (OCX-6).");
  else
    add(
      "P5",
      target.startedAt >= link.lastApplyAt ? "ok" : "failed",
      target.startedAt >= link.lastApplyAt
        ? "Device runtime started after Home apply."
        : "Device runtime predates Home apply.",
    );

  if (client)
    add("P6", "skipped", "Hub clients keep their own Codex settings; only Remote Link syncs them.");
  else if (device?.link.childSettingsApplied === false || (target && !target.settingsDigest))
    add("P6", "failed", "Home Codex settings record is missing or unreadable; no sync is proven.");
  else if (
    target?.settingsLinkId &&
    target.childLinkId &&
    target.settingsLinkId !== target.childLinkId
  )
    add("P6", "failed", "Codex settings record belongs to another link.");
  else if (target?.appliedSettingsDigest && target.appliedSettingsDigest !== target.settingsDigest)
    add("P6", "failed", "Runtime applied settings differ from the saved Home settings record.");
  else if (!target?.settingsDigest || !source?.settingsDigest)
    add("P6", "unproven", "Codex settings document digest is unavailable.");
  else
    add(
      "P6",
      target.settingsDigest === source.settingsDigest ? "ok" : "failed",
      target.settingsDigest === source.settingsDigest
        ? "Applied Codex settings match Home."
        : "Applied Codex settings differ from Home.",
    );

  const wiring = target?.wiring;
  const failedWiring = wiring?.filter(({ status }) => status === "failed");
  add(
    "P7",
    failedWiring?.length
      ? "failed"
      : !wiring || wiring.some(({ status }) => status === "unproven")
        ? "unproven"
        : "ok",
    failedWiring?.length
      ? failedWiring
          .slice(0, 3)
          .map(({ reason }) => reason)
          .join("; ")
      : wiring?.some(({ status }) => status === "unproven")
        ? "Some configured client wiring is unproven."
        : wiring
          ? "Configured clients use local OpenCodex."
          : "Client wiring evidence is unavailable.",
  );

  add(
    "P8",
    target?.localProviderCount === undefined
      ? "unproven"
      : target.localProviderCount > 0
        ? "failed"
        : "ok",
    target?.localProviderCount === undefined
      ? "Local provider state is unavailable."
      : target.localProviderCount > 0
        ? "Active local providers remain on the linked device."
        : "No active local providers remain.",
  );
  const failingCheckIds = checks.filter(({ status }) => status === "failed").map(({ id }) => id);
  const verdict = failingCheckIds.some(
    (id) => id === "P1" || id === "P2" || id === "P3" || id === "P4",
  )
    ? "broken"
    : failingCheckIds.length > 0
      ? "degraded"
      : checks.some(({ status }) => status === "unproven")
        ? "unproven"
        : "ok";
  return { verdict, checkedAt: input.checkedAt, failingCheckIds, checks };
}
