import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseForegroundGrant,
  type ComputerUseControlEnd,
  type Handoff,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ComputerUseControl, ComputerUseLease } from "./ComputerUseLeases.ts";

type LiveGrant = Pick<Handoff, "handoffId" | "expiresAt" | "apps" | "computerUseForeground">;
interface Binding {
  readonly threadId: ThreadId;
  readonly controlId?: string;
  readonly admissionHandoffId: TurnItemId;
}

/** Durable admission cannot recreate focus authority after a pause, replacement or restart. */
export const makeForegroundApprovals = () => {
  const bindings = new Map<TurnItemId, Binding>();
  const consumed = new Set<TurnItemId>();
  let revision = 0;
  const usable = (grant: LiveGrant, now: number) =>
    grant.apps === undefined &&
    grant.computerUseForeground?.target === "desktop" &&
    grant.expiresAt !== null &&
    DateTime.toEpochMillis(grant.expiresAt) > now;
  const bound = (id: TurnItemId, threadId: ThreadId, controlId: string) => {
    const binding = bindings.get(id);
    return binding?.threadId === threadId && binding.controlId === controlId;
  };
  return {
    revision: () => revision,
    hasThread(threadId: ThreadId) {
      for (const binding of bindings.values()) if (binding.threadId === threadId) return true;
      return false;
    },
    approve(input: {
      readonly handoff: Handoff;
      readonly observedRevision: number;
      readonly controlId: string | undefined;
      readonly admissionHandoffId: TurnItemId;
      readonly now: number;
      readonly blocked: boolean;
    }) {
      const { handoff, observedRevision, controlId, now } = input;
      if (
        handoff.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH ||
        handoff.state !== "completed" ||
        !usable(handoff, now) ||
        consumed.has(handoff.handoffId)
      )
        return;
      consumed.add(handoff.handoffId);
      if (observedRevision !== revision || input.blocked) return;
      bindings.set(handoff.handoffId, {
        threadId: handoff.requestedBy.threadId,
        admissionHandoffId: input.admissionHandoffId,
        ...(controlId === undefined ? {} : { controlId }),
      });
    },
    bindPending(threadId: ThreadId, controlId: string, admissionHandoffId: TurnItemId | undefined) {
      for (const [id, binding] of bindings) {
        if (binding.threadId !== threadId || binding.controlId !== undefined) continue;
        // Full-access admission has no primary handoff; its explicit approvals remain separate.
        if (admissionHandoffId !== undefined && admissionHandoffId !== binding.admissionHandoffId)
          bindings.delete(id);
        else bindings.set(id, { ...binding, controlId });
      }
    },
    revokeControl(threadId: ThreadId, controlId: string) {
      revision++;
      for (const [id, binding] of bindings)
        if (binding.threadId === threadId && binding.controlId === controlId) bindings.delete(id);
    },
    revokeThread(threadId: ThreadId) {
      revision++;
      for (const [id, binding] of bindings) if (binding.threadId === threadId) bindings.delete(id);
    },
    clear() {
      revision++;
      bindings.clear();
    },
    available(
      threadId: ThreadId,
      controlId: string | undefined,
      purpose: string,
      grants: ReadonlyArray<LiveGrant>,
      now: number,
    ) {
      return grants.some((grant) => {
        if (!usable(grant, now) || grant.computerUseForeground?.purpose !== purpose) return false;
        const binding = bindings.get(grant.handoffId);
        return (
          binding?.threadId === threadId &&
          (binding.controlId === undefined
            ? grants[0]?.handoffId === binding.admissionHandoffId
            : binding.controlId === controlId)
        );
      });
    },
    grants(
      threadId: ThreadId,
      controlId: string,
      grants: ReadonlyArray<LiveGrant>,
      now: number,
    ): ReadonlyArray<ComputerUseForegroundGrant> {
      return grants.flatMap((grant) =>
        !bound(grant.handoffId, threadId, controlId) ||
        !usable(grant, now) ||
        grant.computerUseForeground === undefined ||
        grant.expiresAt === null
          ? []
          : [
              {
                handoffId: grant.handoffId,
                purpose: grant.computerUseForeground.purpose,
                target: "desktop" as const,
                expiresAtMillis: DateTime.toEpochMillis(grant.expiresAt),
              },
            ],
      );
    },
    bound,
  };
};

export const makeForegroundAuthority = <E>(options: {
  readonly foreground: ReturnType<typeof makeForegroundApprovals>;
  readonly controls: ReadonlyMap<
    ThreadId,
    ComputerUseControl & {
      readonly ended?: ComputerUseControlEnd;
      readonly everyApp?: string;
    }
  >;
  readonly live: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ComputerUseLease>, E>;
  readonly blocked: () => boolean;
  readonly changed: Effect.Effect<unknown>;
}) => {
  const foreground = options.foreground;
  return {
    foregroundApprovalEpoch: Effect.sync(() => foreground.revision()),
    approveForeground: Effect.fn("ComputerUseLeases.approveForeground")(function* (
      handoff: Handoff,
      observedEpoch: number,
    ) {
      const selected = (yield* options.live(handoff.requestedBy.threadId).pipe(Effect.orDie))[0];
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const current = options.controls.get(handoff.requestedBy.threadId);
      // A newly selected unattended admission mints a different control on the next attachment.
      // Only this new approval waits for that mint; existing authority never follows it.
      const awaitingAdmission =
        current?.everyApp === undefined &&
        current?.handoffId !== undefined &&
        selected?.handoffId === handoff.handoffId &&
        current.handoffId !== selected.handoffId;
      const controlId =
        current !== undefined &&
        current.ended === undefined &&
        !awaitingAdmission &&
        DateTime.toEpochMillis(current.expiresAt) > now
          ? current.controlId
          : undefined;
      foreground.approve({
        handoff,
        observedRevision: observedEpoch,
        controlId,
        // A shorter desktop approval may accompany the selected background admission. Pin
        // that admission now so pending authority cannot follow a different grant at mint.
        // When foreground itself supplies admission, retain its exact handoff binding.
        admissionHandoffId:
          selected !== undefined && selected.computerUseForeground === undefined
            ? selected.handoffId
            : handoff.handoffId,
        now,
        blocked: options.blocked(),
      });
      yield* options.changed;
    }),
    foregroundAvailable: Effect.fn("ComputerUseLeases.foregroundAvailable")(function* (
      threadId: ThreadId,
      purpose: string,
    ) {
      if (!foreground.hasThread(threadId)) return false;
      const grants = yield* options.live(threadId);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const current = options.controls.get(threadId);
      if (options.blocked()) return false;
      const controlId =
        current !== undefined &&
        current.ended === undefined &&
        DateTime.toEpochMillis(current.expiresAt) > now
          ? current.controlId
          : undefined;
      return foreground.available(threadId, controlId, purpose, grants, now);
    }),
  };
};
