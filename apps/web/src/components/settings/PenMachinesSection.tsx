import { PenDiscovery, PenMembership, type PenMemberStatus } from "@goat/client-runtime/connection";
import type { ClientCapabilities } from "@goat/client-runtime/platform";
import type { DesktopPenBridge } from "@goat/contracts";
import { useState } from "react";
import { createRuntimeCommand } from "@goat/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { penGuidance, penLiveStatus, penMemberText } from "./PenMachinesSection.logic";

const statusesAtom = connectionAtomRuntime.atom(
  Stream.unwrap(
    PenDiscovery.PenDiscovery.pipe(
      Effect.map((discovery) => SubscriptionRef.changes(discovery.statuses)),
    ),
  ),
);
const membershipAtom = connectionAtomRuntime.atom(
  Stream.unwrap(
    PenMembership.PenMembership.pipe(
      Effect.map((membership) => SubscriptionRef.changes(membership.latest)),
    ),
  ),
);
const retry = createRuntimeCommand(connectionAtomRuntime, {
  label: "pen:retry",
  concurrency: { mode: "singleFlight", key: (nodeId: string) => nodeId },
  execute: (nodeId: string) =>
    PenDiscovery.PenDiscovery.pipe(Effect.flatMap((service) => service.retry(nodeId))),
});
const connect = createRuntimeCommand(connectionAtomRuntime, {
  label: "pen:connect",
  concurrency: { mode: "singleFlight", key: (nodeId: string) => nodeId },
  execute: (nodeId: string) =>
    PenDiscovery.PenDiscovery.pipe(Effect.flatMap((service) => service.connect(nodeId))),
});
// Installs GOAT on that machine, so it runs only from a person's click on Set up.
const setUp = createRuntimeCommand(connectionAtomRuntime, {
  label: "pen:set-up",
  concurrency: { mode: "singleFlight", key: (nodeId: string) => nodeId },
  execute: (nodeId: string) =>
    PenDiscovery.PenDiscovery.pipe(Effect.flatMap((service) => service.setUp(nodeId))),
});

export function PenMachinesView({
  statuses,
  guidance,
  onRetry,
  onSetUp,
  onConnect,
  membership,
  revokePenMember,
}: {
  readonly statuses: ReadonlyArray<PenMemberStatus>;
  readonly guidance: string | null;
  readonly onRetry: (nodeId: string) => void;
  readonly onSetUp: (nodeId: string) => void;
  readonly onConnect?: (nodeId: string) => void;
  readonly membership?: ClientCapabilities.PenMembersInput | undefined;
  readonly revokePenMember?: DesktopPenBridge["revokePenMember"];
}) {
  const [removing, setRemoving] = useState(false);
  const remove = (member: PenMemberStatus) => {
    if (removing || membership?.kind !== "ready" || revokePenMember === undefined) return;
    const current = membership.members.find((item) => item.nodeId === member.nodeId);
    if (current === undefined) return;
    const failed = (description: string) =>
      toastManager.add({ type: "error", title: "Could not remove from Pen", description });
    setRemoving(true);
    void revokePenMember({
      meshId: membership.meshId,
      nodeId: current.nodeId,
      noisePub: current.noisePub,
    })
      .then(
        (result) => {
          if (result.status === "revoked")
            toastManager.add({ type: "success", title: `Removed ${current.name} from Pen` });
          if (result.status === "failed") failed(result.message);
        },
        (error: unknown) => failed(error instanceof Error ? error.message : String(error)),
      )
      .then(() => setRemoving(false));
  };
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  return (
    <SettingsSection title="Pen machines">
      <SettingsRow
        title="Show my Pen machines"
        description="Every machine in this computer's Pen mesh that already runs GOAT appears here and in the sidebar, and leaves when it leaves Pen. GOAT is never installed on a machine without you choosing Set up."
        control={
          <Switch
            aria-label="Show my Pen machines"
            checked={settings.showPenMachines}
            onCheckedChange={(value) => update({ showPenMachines: Boolean(value) })}
          />
        }
      />
      {settings.showPenMachines && guidance !== null ? <SettingsRow title={guidance} /> : null}
      {settings.showPenMachines
        ? statuses.map((member) => (
            <SettingsRow
              key={member.nodeId}
              title={member.name}
              description={penMemberText(member)}
              control={
                <div className="flex items-center gap-2">
                  {member.state === "waiting" ? (
                    <Button size="sm" variant="outline" onClick={() => onConnect?.(member.nodeId)}>
                      Connect
                    </Button>
                  ) : member.state === "not-set-up" ? (
                    <Button size="sm" variant="outline" onClick={() => onSetUp(member.nodeId)}>
                      Set up
                    </Button>
                  ) : member.state === "failed" || member.state === "key-rejected" ? (
                    <Button size="sm" variant="outline" onClick={() => onRetry(member.nodeId)}>
                      Retry
                    </Button>
                  ) : null}
                  {revokePenMember !== undefined &&
                  membership?.kind === "ready" &&
                  membership.members.some((item) => item.nodeId === member.nodeId) ? (
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={removing}
                      onClick={() => remove(member)}
                    >
                      Remove from Pen...
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))
        : null}
    </SettingsSection>
  );
}

/** Pen machines sit above the environments they become; only a desktop that follows Pen has them. */
export function EnvironmentsWithPenMachines() {
  return (
    <>
      {window.desktopBridge?.getPenMembers !== undefined ? <PenMachinesSection /> : null}
      <ConnectionEnvironmentsSection />
    </>
  );
}

function PenMachinesSection() {
  const { environments } = useEnvironments();
  const statuses = (useEnvironmentQuery(statusesAtom).data ?? []).map((member) =>
    penLiveStatus(
      member,
      environments.find((environment) => environment.environmentId === member.environmentId)
        ?.connection,
    ),
  );
  const membership = useEnvironmentQuery(membershipAtom).data;
  const retryMember = useAtomCommand(retry);
  const setUpMember = useAtomCommand(setUp);
  const connectMember = useAtomCommand(connect);
  const currentMembership = membership == null ? undefined : Option.getOrUndefined(membership);
  return (
    <PenMachinesView
      statuses={statuses}
      guidance={penGuidance(
        membership === null || membership === undefined
          ? undefined
          : Option.getOrUndefined(membership),
        statuses,
      )}
      membership={currentMembership}
      revokePenMember={window.desktopBridge?.revokePenMember}
      onConnect={(nodeId) => void connectMember(nodeId)}
      onRetry={(nodeId) => void retryMember(nodeId)}
      onSetUp={(nodeId) => void setUpMember(nodeId)}
    />
  );
}
