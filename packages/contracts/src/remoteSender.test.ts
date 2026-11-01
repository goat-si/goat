import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationMessageContext } from "./composerContext.ts";
import { OrchestratorMcpThreadSendInput } from "./orchestratorMcp.ts";

const remoteSender = {
  environmentId: "mac-studio",
  environmentLabel: "mac-studio",
  threadId: "coordinator",
  title: "Coordinator",
};
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
// A client built before the sender existed.
const decodePreSenderContext = Schema.decodeUnknownSync(
  OrchestrationMessageContext.mapFields(({ remoteSender: _sender, ...fields }) => fields),
);
const decodeSend = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);

describe("remote sender attribution", () => {
  it("rides on a message's context and is ignored by clients from before it", () => {
    const context = { version: 1, records: [], remoteSender };
    expect(decodeContext(context).remoteSender).toEqual(remoteSender);
    expect(decodeContext({ version: 1, records: [] }).remoteSender).toBeUndefined();
    expect(decodePreSenderContext(context)).toEqual({ version: 1, records: [] });
  });

  it("is an optional goat_thread_send argument, bounded like the label it is", () => {
    const send = { threadId: "lane", message: "Rebase" };
    expect(decodeSend(send).remoteSender).toBeUndefined();
    expect(decodeSend({ ...send, remoteSender }).remoteSender).toEqual(remoteSender);
    expect(() =>
      decodeSend({ ...send, remoteSender: { ...remoteSender, title: "x".repeat(201) } }),
    ).toThrow();
  });
});
