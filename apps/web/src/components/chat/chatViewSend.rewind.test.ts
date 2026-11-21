import { scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({ httpBaseUrl: "http://localhost" })) as never,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails } from "../../state/threads";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { rewindToMessage } from "./chatViewSend";

it("shows the server's rollback rejection after an old-style file restore request", async () => {
  const base = makeThreadProjectionFixture();
  const projection = {
    ...base,
    runs: [{ id: RunId.make("run"), ordinal: 1, status: "completed" }],
  } as unknown as typeof base;
  const state = Atom.make({ data: Option.some(projection) });
  using _stateAtom = vi
    .spyOn(environmentThreadDetails, "stateAtom")
    .mockReturnValue(state as never);
  const environmentId = EnvironmentId.make("env");
  const threadId = ThreadId.make("thread");
  const routeThreadRef = scopeThreadRef(environmentId, threadId);
  const message =
    "File restore requires an isolated worktree. This workspace may contain changes from another thread. Rewind the conversation without restoring files instead.";
  const result = await rewindToMessage({
    message: {
      id: MessageId.make("message"),
      role: "user",
      text: "restore",
      attachments: [],
    } as never,
    environmentId,
    threadId,
    routeThreadRef,
    turnCount: 0,
    restoreFiles: true,
    checkpoint: undefined,
    draftTarget: routeThreadRef,
    composerHasPendingAttachments: false,
    createAssetUrl: vi.fn() as never,
    revertThreadCheckpoint: async ({ input }) => {
      appAtomRegistry.set(state, {
        data: Option.some({
          ...projection,
          thread: {
            ...projection.thread,
            rollbackFailure: { requestId: input.commandId, message },
          },
        }),
      });
      return AsyncResult.success(undefined);
    },
  });
  expect(result).toEqual({ error: message });
});
