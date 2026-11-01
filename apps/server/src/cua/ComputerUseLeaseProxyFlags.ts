import type * as Contracts from "@goat/contracts";

type ActiveUpdate = Extract<Contracts.ComputerUseLeaseUpdate, { readonly state: "active" }>;

/**
 * The flags of the lease update the proxy's own refusals read. A received update tightens at once;
 * only an applied one loosens, so neither an older applied update nor a newer received one lifts
 * a strict update still waiting to be applied.
 */
export const makeLeaseFlags = () => {
  let shared = false;
  let sharedTaken = false;
  // Absent means strict, so an older server never loosens the proxy's guards.
  let strict = true;
  // Received and not yet applied, in order; updates are applied in the order they arrive.
  const pending: Array<ActiveUpdate> = [];
  const strictNow = () => strict || pending.some((update) => update.strictInputGuards !== false);
  return {
    apply: (update: ActiveUpdate) => {
      shared = update.shared === true;
      strict = update.strictInputGuards !== false;
      const at = pending.indexOf(update);
      if (at >= 0) pending.splice(0, at + 1);
    },
    take: (update: ActiveUpdate) => {
      sharedTaken = update.shared === true;
      pending.push(update);
    },
    strict: strictNow,
    /** Another thread holds this screen; it denies only while the person keeps strict guards. */
    sharedNow: () => strictNow() && (shared || sharedTaken),
  };
};
