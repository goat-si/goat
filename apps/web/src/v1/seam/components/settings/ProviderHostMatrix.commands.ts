// Seam for v1 apps/web/src/components/settings/ProviderHostMatrix.commands.ts (goat 916b5ccc1b2): GOAT 2 has one
// host, so the sync command is never permitted (its permission atom is false and v1 hides the action) and refuses
// with that reason if run.
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentAtomCommand } from "@goat/client-runtime/state/runtime";

const never = Atom.make(false);

export const startProviderHostSync: EnvironmentAtomCommand<unknown, never, Error> = {
  label: "Sync provider to machines",
  permissionAtom: () => never,
  run: async () =>
    AsyncResult.failure(Cause.fail(new Error("GOAT 2 runs on one machine; there are no other hosts to sync to."))),
};
