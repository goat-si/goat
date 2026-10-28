import * as Schema from "effect/Schema";

const Step = Schema.Struct({
  state: Schema.Literals(["pending", "done", "not_applicable"]),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const AccountOperationProgress = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Struct({
    relay_denied: Step,
    identities_retired: Step,
    intents_abandoned: Step,
    credentials_revoked: Step,
    devices_ineligible: Step,
    hooks_cleared: Step,
    relay_allowed: Step,
    completed: Step,
  }),
});
export type AccountOperationProgress = typeof AccountOperationProgress.Type;
export function operationProgress(
  kind: "suspend" | "allow" | "delete",
  completed: boolean,
): AccountOperationProgress {
  const done = { state: "done" as const, attempts: 1 };
  const pending = { state: "pending" as const, attempts: 0 };
  const unused = { state: "not_applicable" as const, attempts: 0 };
  return {
    version: 1,
    steps: {
      relay_denied: kind !== "allow" ? done : unused,
      identities_retired: kind !== "allow" ? done : unused,
      intents_abandoned: kind !== "allow" ? done : unused,
      credentials_revoked: kind !== "allow" ? done : unused,
      devices_ineligible: kind !== "allow" ? done : unused,
      hooks_cleared: kind === "allow" ? unused : completed ? done : pending,
      relay_allowed: kind === "allow" ? done : unused,
      completed: completed ? done : pending,
    },
  };
}
