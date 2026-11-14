import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import {
  loadedMobileGoatBotRef,
  mobileBotHomeListShown,
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
  const presentations = get(environmentPresentations.presentationsAtom);
  const environments = [...presentations].map(([environmentId, presentation]) =>
    mobileGoatBotEnvironmentInput({
      environmentId,
      label: presentation.entry.target.label,
      connection: presentation.connection,
      serverConfig: presentation.serverConfig,
    }),
  );
  const selected = pickMobileGoatBotEnvironment(environments, botRef);
  if (selected === null) return null;
  // Only where Home's sheet can show the bot's list, so every thread it hides opens there. Members
  // need no check here: the shared union adds them only on a server that advertises members.
  const shown = mobileBotHomeListShown({
    connected: selected.connected,
    capabilities: presentations.get(selected.environmentId)?.serverConfig?.environment.capabilities,
    member: false,
  });
  return shown ? selected.environmentId : null;
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
