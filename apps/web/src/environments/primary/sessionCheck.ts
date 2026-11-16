import { Atom } from "effect/reactivity";

import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { isPrimaryAuthGateAuthenticated, probePrimarySession } from "./auth";
import { isSameOriginBrowserPrimary } from "./httpLayer";
import { createPrimarySessionCheck } from "./sessionCheckSchedule";

const primaryConnectionAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  return get(environmentPresentations.presentationsAtom).get(environmentId)?.connection ?? null;
}).pipe(Atom.withLabel("primary-environment:connection"));

/** The tab's one check of its own server's session, until the connection layer tells it apart. */
export const primarySessionCheck = createPrimarySessionCheck({
  connection: () => appAtomRegistry.get(primaryConnectionAtom),
  subscribeConnection: (listener) => appAtomRegistry.subscribe(primaryConnectionAtom, listener),
  visible: () => getDocumentActivity().visible,
  subscribeVisible: subscribeDocumentActivity,
  // Desktop and other origins sign in by bearer or send no cookie, so only a cookie tab asks.
  eligible: () => isSameOriginBrowserPrimary() && isPrimaryAuthGateAuthenticated(),
  probe: probePrimarySession,
});
