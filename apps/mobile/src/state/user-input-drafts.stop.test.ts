import {
  makeThreadRequestsResolvedAnnouncer,
  userInputDraftKey,
} from "@goat/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

// The Decisions inbox writes a typed answer where the thread's question card keeps answers. A Stop
// while the thread screen is closed then reaches it through the one resolution listener, which
// use-selected-thread-requests registers at module load.
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Platform: { OS: "ios" } }));
vi.mock("../features/threads/useSideChatCommand", () => ({ useSideChatCommand: () => vi.fn() }));
// The module's runtime imports, which load React Native; the listener reads none of them.
vi.mock("./threads", () => ({ environmentThreadDetails: {}, threadEnvironment: {} }));
vi.mock("./use-thread-detail", () => ({ useSelectedThreadPendingRequests: () => null }));
vi.mock("./use-thread-selection", () => ({ useThreadSelection: () => ({}) }));
vi.mock("./session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("./composer-attachment-uploads", async () => {
  const { Atom } = await import("effect/reactivity");
  return { composerAttachmentUploadsAtom: Atom.make({}) };
});

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { composerDraftsAtom } from "./use-composer-drafts";
import "./use-selected-thread-requests";
import {
  setUserInputDraftCustomAnswer,
  userInputDraftsByRequestKeyAtom,
} from "./user-input-drafts";

it("returns an inbox answer to the thread's draft when its question is stopped", () => {
  const environmentId = EnvironmentId.make("env");
  const threadId = ThreadId.make("thread");
  const requestId = RuntimeRequestId.make("request");
  const key = userInputDraftKey(environmentId, threadId, requestId);
  setUserInputDraftCustomAnswer(
    key,
    { id: "q", header: "Colour", question: "Which colour?", options: [], multiSelect: false },
    "Purple",
  );
  const announce = makeThreadRequestsResolvedAnnouncer(environmentId, threadId);
  announce([{ id: requestId, status: "pending" }]);
  announce([{ id: requestId, status: "cancelled" }]);
  expect(
    appAtomRegistry.get(composerDraftsAtom)[scopedThreadKey(environmentId, threadId)]?.text,
  ).toBe("Purple");
  expect(appAtomRegistry.get(userInputDraftsByRequestKeyAtom)[key]).toBeUndefined();
});
