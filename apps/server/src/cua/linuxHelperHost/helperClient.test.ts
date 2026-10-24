import { assert, describe, it } from "@effect/vitest";

import { makeHelperClient } from "./helperClient.ts";
import { fakeHelper, type FakeRequest } from "./LinuxHelperHost.testkit.ts";

/** A client over a scripted helper, with deadlines the test fires by hand. */
const connect = (helper: ReturnType<typeof fakeHelper>) => {
  const deadlines: Array<() => void> = [];
  const events: unknown[] = [];
  let next = 0;
  const client = makeHelperClient({
    write: helper.process.write,
    pid: helper.process.pid,
    newId: () => "id-" + ++next,
    after: (_ms, task) => {
      deadlines.push(task);
      return () => undefined;
    },
    onEvent: (event) => events.push(event),
  });
  helper.process.onLine(client.line);
  return { client, deadlines, events };
};

describe("Linux helper client (#1223)", () => {
  it("refuses a helper whose hello names another process than the one started", async () => {
    const helper = fakeHelper({ pid: 4242, bindingPid: 999 });
    const { client } = connect(helper);
    const failed = await client.start().then(
      () => false,
      () => true,
    );
    assert.isTrue(failed);
    assert.isUndefined(await client.request("permissions", {}, 1000));
    assert.lengthOf(helper.requests, 0);
  });

  it("delivers a reply only to its pending request, from this helper's generation", async () => {
    let held: FakeRequest | undefined;
    const helper = fakeHelper({
      answers: (request) => {
        held = request;
        return false;
      },
    });
    const { client, deadlines } = connect(helper);
    await client.start();
    const answer = client.request("permissions", {}, 1000);
    // Another generation's reply to the same id is dropped; this helper's is delivered.
    helper.send({ id: held?.id, generation: "gen-0", result: "stale" });
    helper.send({ id: held?.id, generation: "gen-1", result: "fresh" });
    assert.strictEqual(await answer, "fresh");
    // A request past its deadline resolves empty, and its late reply goes nowhere.
    const late = client.request("permissions", {}, 1000);
    deadlines.at(-1)?.();
    assert.isUndefined(await late);
    helper.send({ id: held?.id, generation: "gen-1", result: "late" });
  });

  it("hears events only of the watch in force, from when its answer arrives", async () => {
    let watchId = "";
    const helper = fakeHelper({
      onRequest: (request) => {
        if (request.method === "watch") watchId = (request.params as { watchId: string }).watchId;
      },
    });
    const { client, events } = connect(helper);
    await client.start();
    const humanInput = { type: "humanInput", source: "keyboard" };
    helper.event("not-yet", humanInput);
    assert.isTrue(await client.watch([{ pid: 7, windowId: 70 }], 1000));
    helper.event(watchId, humanInput, "gen-0");
    helper.event(watchId, humanInput);
    assert.deepEqual(events, [humanInput]);
    await client.unwatch(1000);
    helper.event(watchId, humanInput);
    assert.lengthOf(events, 1);
  });
});
