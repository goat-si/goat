import { createDecisionInboxAtoms } from "@goat/client-runtime/state/decision-inbox";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

// Lives outside ./threads: presentation pulls in the server session atoms, and
// modules that only need thread state should not load them.
export const decisionInbox = createDecisionInboxAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  presentationAtom: environmentPresentations.presentationAtom,
  details: environmentThreadDetails,
  feedAtom: serverEnvironment.decisionFeed,
});
