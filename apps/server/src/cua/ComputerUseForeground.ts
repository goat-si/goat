import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseForegroundGrant,
  type Handoff,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

type LiveGrant = Pick<Handoff, "handoffId" | "expiresAt" | "apps" | "computerUseForeground">;
interface Binding {
  readonly threadId: ThreadId;
  readonly controlId?: string;
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
        ...(controlId === undefined ? {} : { controlId }),
      });
    },
    bindPending(threadId: ThreadId, controlId: string, admissionHandoffId: TurnItemId | undefined) {
      for (const [id, binding] of bindings) {
        if (binding.threadId !== threadId || binding.controlId !== undefined) continue;
        // Full-access admission has no primary handoff; its explicit approvals remain separate.
        if (admissionHandoffId !== undefined && admissionHandoffId !== id) bindings.delete(id);
        else bindings.set(id, { threadId, controlId });
      }
    },
    replaceControl(threadId: ThreadId, controlId: string) {
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
            ? grants[0]?.handoffId === grant.handoffId
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
