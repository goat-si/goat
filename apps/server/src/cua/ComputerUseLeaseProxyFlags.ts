import type * as Contracts from "@goat/contracts";

type ActiveUpdate = Extract<Contracts.ComputerUseLeaseUpdate, { readonly state: "active" }>;

/**
 * The flags of the lease update the proxy's own refusals read. A received update tightens at once;
 * only an applied one loosens, so an older applied update cannot lift the latest restriction.
 */
export const makeLeaseFlags = () => {
  let shared = false;
  let sharedTaken = false;
  // Absent means strict, so an older server never loosens the proxy's guards.
  let strict = true;
  let strictTaken = true;
  return {
    apply: (update: ActiveUpdate) => {
      shared = update.shared === true;
      strict = update.strictInputGuards !== false;
    },
    take: (update: ActiveUpdate) => {
      sharedTaken = update.shared === true;
      strictTaken = update.strictInputGuards !== false;
    },
    strict: () => strict || strictTaken,
    /** Another thread holds this screen; it denies only while the person keeps strict guards. */
    sharedNow: () => (strict || strictTaken) && (shared || sharedTaken),
  };
};
