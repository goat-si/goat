import type { ServerSettings } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as Settings from "../../serverSettings.ts";
import {
  coversDelegation,
  decodeDelegation,
  type Delegation,
  type StoredProvisioner,
} from "./attachModel.ts";
import { provisionerOf, type Row, samePolicy } from "./attachRow.ts";
import { disposableSwitch } from "./disposableSwitch.ts";

/** A provisioner's grant now (design section 4); undefined when it holds none for this node. */
export class Provisioners extends Context.Service<
  Provisioners,
  {
    readonly grantOf: (
      provisioner: StoredProvisioner,
      nodeId: string,
    ) => Effect.Effect<Delegation | undefined>;
  }
>()("goat/hub/disposable/attachAuthority/Provisioners") {}

/**
 * Whether a record's provisioner may still move it on (design section 4, Withdrawal): the switch is
 * on, unexpired and still the record's grant, a thread is still named, and the provisioner still
 * holds at least the grant recorded at attach start.
 */
export const makeAuthority = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const provisioners = yield* Provisioners;

  const unnamed = (row: Row, current: ServerSettings) => {
    const provisioner = provisionerOf(row);
    return (
      provisioner === undefined ||
      (provisioner.kind === "thread" &&
        !current.hub.attachDisposableMachines.provisioners.some(
          (id) => id === provisioner.threadId,
        ))
    );
  };
  // Reads goatclaw profiles through the settings service, so it never runs under the settings lock.
  const provisionerEnded = Effect.fn("DisposableAttach.provisionerEnded")(function* (
    row: Row,
    current: ServerSettings,
  ) {
    const provisioner = provisionerOf(row);
    if (provisioner === undefined || unnamed(row, current)) return "provisioner_refused" as const;
    const now = yield* provisioners.grantOf(provisioner, row.node_id);
    if (!coversDelegation(now, decodeDelegation(row.delegation_json)))
      return "delegation_lost" as const;
    return undefined;
  });
  const authorityEnded = Effect.fn("DisposableAttach.authorityEnded")(function* (
    row: Row,
    current: ServerSettings | undefined,
  ) {
    if (current === undefined) return "switch_off" as const;
    const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
    if (!gate.open) return gate.reason;
    if (gate.grant !== row.grant_id) return "switch_off" as const;
    return yield* provisionerEnded(row, current);
  });
  const settingsNow = settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  /**
   * The provisioner's grant is read outside the settings lock; under it, the switch, its grant, the
   * named thread and the goatclaw policy that grant was resolved from must be as they were.
   */
  const lockedEnded = (
    row: Row,
    before: ServerSettings,
    current: ServerSettings,
    nowMs: number,
  ) => {
    const gate = disposableSwitch(current.hub, nowMs);
    if (!gate.open) return gate.reason;
    if (gate.grant !== row.grant_id) return "switch_off" as const;
    if (unnamed(row, current)) return "provisioner_refused" as const;
    if (!samePolicy(current, before)) return "delegation_lost" as const;
    return undefined;
  };
  /** The last check before a result leaves: the grant now, then the switch under the lock. */
  const finalCheck = Effect.fn("DisposableAttach.finalCheck")(function* (row: Row) {
    const before = yield* settingsNow;
    const ended = yield* authorityEnded(row, before);
    if (ended !== undefined || before === undefined) return ended ?? ("switch_off" as const);
    return yield* settings
      .withSettingsSnapshot((current) =>
        Effect.map(Clock.currentTimeMillis, (nowMs) => lockedEnded(row, before, current, nowMs)),
      )
      .pipe(Effect.orElseSucceed(() => "switch_off" as const));
  });
  return { unnamed, authorityEnded, settingsNow, lockedEnded, finalCheck };
});
