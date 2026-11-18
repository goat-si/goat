import { pickGoatBotEnvironment } from "@goat/client-runtime/goatBot";
import { Atom } from "effect/reactivity";

import { goatBotAppChannelPort } from "~/components/goatBot/goatBotAppChannelPort";
import { goatBotEnvironmentInputs } from "~/components/goatBot/goatBotEnvironmentInputs";
import {
  goatBotGoverningEnvironmentId,
  useGoatBotSessions,
} from "~/components/goatBot/goatBotSessions";
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

const goatBotSessionsAtom = Atom.make((get) => {
  get.addFinalizer(
    useGoatBotSessions.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) get.setSelf(state.sessions);
    }),
  );
  return useGoatBotSessions.getState().sessions;
}).pipe(Atom.withLabel("goat-bot-sessions"));

/**
 * The computer whose bot Home governs Threads, picked as the roster and Home pick it, and only
 * while nothing this client knows keeps its Home from opening (goatBotGoverningEnvironmentId).
 * Otherwise null, and every computer keeps the legacy rule.
 */
export const goatBotHomeEnvironmentIdAtom = Atom.make((get) => {
  const environments = goatBotEnvironmentInputs(
    [...get(environmentPresentations.presentationsAtom).entries()].map(
      ([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation),
    ),
    get(primaryEnvironmentIdAtom),
  );
  const botRef = get(goatBotRefAtom);
  const picked = pickGoatBotEnvironment(environments, botRef);
  return goatBotGoverningEnvironmentId({
    port: goatBotAppChannelPort,
    environments,
    botRef,
    session: picked === null ? undefined : get(goatBotSessionsAtom).get(picked.environmentId),
  });
}).pipe(Atom.withLabel("goat-bot-home-environment"));
