import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadShells } from "../../state/threads";

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * GOAT Bot's observation threads that thread lists leave out, keyed `environmentId:threadId`:
 * none while this device shows them. Lists, moves and held orders all read this one set.
 */
export const hiddenGoatBotThreadKeysAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  if (AsyncResult.isSuccess(preferences) && preferences.value.showGoatBotThreads === true) {
    return NO_KEYS;
  }
  return get(environmentThreadShells.goatBotObservationThreadKeysAtom);
  // Kept: moves and held orders read it outside React, between list renders.
}).pipe(Atom.keepAlive, Atom.withLabel("mobile-hidden-goat-bot-thread-keys"));
