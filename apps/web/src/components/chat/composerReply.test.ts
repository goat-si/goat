import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  type ResponseContextRecord,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({
  toastManager: { add: toast },
  stackedThreadToast: (options: unknown) => options,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { refuseReplyTheServerDrops } from "./composerReply";

const environmentId = EnvironmentId.make("environment-1");
const reply: ResponseContextRecord = {
  version: 1,
  kind: "response",
  contextId: "response_m1" as ComposerContextId,
  label: "The fix is in",
  citation: {
    version: 1,
    environmentId,
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("m1"),
    text: "The fix is in",
    start: 0,
    end: 13,
    prefix: "",
    suffix: "",
  },
  itemId: TurnItemId.make("item-1"),
};

function serverConfigs(capabilities: Record<string, unknown> | null) {
  const configs = new Map(
    capabilities === null ? [] : [[environmentId, { environment: { capabilities } }]],
  );
  const get = appAtomRegistry.get.bind(appAtomRegistry);
  return vi
    .spyOn(appAtomRegistry, "get")
    .mockImplementation(((atom: Atom.Atom<unknown>) =>
      atom === environmentServerConfigsAtom ? configs : get(atom)) as typeof appAtomRegistry.get);
}

it("refuses a draft reply with a sentence when the server does not check replies", () => {
  toast.mockReset();
  for (const capabilities of [null, {}, { replyToResponse: false }]) {
    using _configs = serverConfigs(capabilities);
    expect(refuseReplyTheServerDrops(reply, environmentId)).toBe(true);
  }
  expect(toast).toHaveBeenCalledTimes(3);
  expect(toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "This machine's server can't take replies" }),
  );
});

it("lets a reply through to a server that checks replies, and a send without one anywhere", () => {
  toast.mockReset();
  {
    using _configs = serverConfigs({ replyToResponse: true });
    expect(refuseReplyTheServerDrops(reply, environmentId)).toBe(false);
  }
  {
    using _configs = serverConfigs(null);
    expect(refuseReplyTheServerDrops(null, environmentId)).toBe(false);
  }
  expect(toast).not.toHaveBeenCalled();
});
