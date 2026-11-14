import { homeWorkGoverns } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { channelEnvironment } from "~/state/channels";

/** Whether Home governs an environment, as one boolean: its readers re-render only when it flips. */
export const goatBotGovernedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    homeWorkGoverns(get(channelEnvironment.homeCurrentOpenableWorkByEnvironment(environmentId))),
  ).pipe(Atom.withLabel(`goat-bot:home-governed:${environmentId}`)),
);
