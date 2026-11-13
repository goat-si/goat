import { PenDiscovery, PenMembership, type PenMemberStatus } from "@goat/client-runtime/connection";
import { createRuntimeCommand } from "@goat/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { penGuidance, penMemberText } from "./PenMachinesSection.logic";

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
}: {
  readonly statuses: ReadonlyArray<PenMemberStatus>;
  readonly guidance: string | null;
  readonly onRetry: (nodeId: string) => void;
  readonly onSetUp: (nodeId: string) => void;
}) {
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
                member.state === "not-set-up" ? (
                  <Button size="sm" variant="outline" onClick={() => onSetUp(member.nodeId)}>
                    Set up
                  </Button>
                ) : member.state === "failed" || member.state === "key-rejected" ? (
                  <Button size="sm" variant="outline" onClick={() => onRetry(member.nodeId)}>
                    Retry
                  </Button>
                ) : undefined
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
  const statuses = useEnvironmentQuery(statusesAtom).data ?? [];
  const membership = useEnvironmentQuery(membershipAtom).data;
  const retryMember = useAtomCommand(retry);
  const setUpMember = useAtomCommand(setUp);
  return (
    <PenMachinesView
      statuses={statuses}
      guidance={penGuidance(
        membership === null || membership === undefined
          ? undefined
          : Option.getOrUndefined(membership),
        statuses,
      )}
      onRetry={(nodeId) => void retryMember(nodeId)}
      onSetUp={(nodeId) => void setUpMember(nodeId)}
    />
  );
}
