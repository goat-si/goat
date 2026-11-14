import { pickGoatBotEnvironment } from "@goat/client-runtime/goatBot";
import { Atom } from "effect/reactivity";

import { goatBotEnvironmentInputs } from "~/components/goatBot/goatBotEnvironmentInputs";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { projectEnvironmentPresentation } from "./environmentProjection";
import { environmentPresentations } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

const goatBotRefAtom = Atom.make((get) => {
  get.addFinalizer(
    useGlobalAgentStore.subscribe((state, previous) => {
      if (state.botRef !== previous.botRef) get.setSelf(state.botRef);
    }),
  );
  return useGlobalAgentStore.getState().botRef;
}).pipe(Atom.withLabel("goat-bot-ref"));

/**
 * The computer whose bot Home this client opens, picked exactly as the roster and Home pick it
 * (useGoatBotEnabled), so Threads and the Home on screen always name the same computer.
 */
export const goatBotHomeEnvironmentIdAtom = Atom.make(
  (get) =>
    pickGoatBotEnvironment(
      goatBotEnvironmentInputs(
        [...get(environmentPresentations.presentationsAtom).entries()].map(
          ([environmentId, presentation]) =>
            projectEnvironmentPresentation(environmentId, presentation),
        ),
        get(primaryEnvironmentIdAtom),
      ),
      get(goatBotRefAtom),
    )?.environmentId ?? null,
).pipe(Atom.withLabel("goat-bot-home-environment"));
