import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import {
  loadedMobileGoatBotRef,
  pickMobileGoatBotEnvironment,
} from "../features/goat-bot/goatBotHomeMode";
import { mobileGoatBotEnvironmentInput } from "../features/goat-bot/mobileGoatBotEnvironments";
import { channelEnvironment } from "./channels";
import { mobilePreferencesAtom } from "./preferences";
import { environmentPresentations } from "./presentation";

/** The computer whose bot Home this device opens: the same pick the roster and Home make. */
const mobileGoatBotHomeEnvironmentIdAtom = Atom.make((get) => {
  const botRef = loadedMobileGoatBotRef(get(mobilePreferencesAtom));
  // Until preferences load the Bots switch cannot open Home, so Home governs no computer.
  if (botRef === undefined) return null;
  const environments = [...get(environmentPresentations.presentationsAtom)].map(
    ([environmentId, presentation]) =>
      mobileGoatBotEnvironmentInput({
        environmentId,
        label: presentation.entry.target.label,
        connection: presentation.connection,
        serverConfig: presentation.serverConfig,
      }),
  );
  return pickMobileGoatBotEnvironment(environments, botRef)?.environmentId ?? null;
}).pipe(Atom.withLabel("mobile-goat-bot-home-environment"));

const UNGOVERNED = { rosterKnown: false, byBot: [], links: [] } as const;

/**
 * Home's work per computer, governing only the computer whose bot Home this device opens; any
 * other computer keeps dev's rule and reads nothing through Home's atoms.
 */
export const mobileGoatBotHomeWorkByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(mobileGoatBotHomeEnvironmentIdAtom) === environmentId
      ? get(channelEnvironment.homeCurrentOpenableWorkByEnvironment(environmentId))
      : UNGOVERNED,
  ).pipe(Atom.withLabel(`mobile-goat-bot-home-work:${environmentId}`)),
);
