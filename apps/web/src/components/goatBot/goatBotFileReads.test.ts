import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  afterLastChunkRequest,
  MAX_WAITING_PREVIEW_READS,
  queuePreviewRead,
} from "./goatBotFileReads";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** A read the test finishes by hand; `started` settles when the scheduler sends it. */
function read(name: string, log: string[]) {
  const started = deferred<void>();
  const finished = deferred<string>();
  return {
    request: () => {
      log.push(name);
      started.resolve();
      return finished.promise;
    },
    started: started.promise,
    finish: () => finished.resolve(name),
  };
}

describe("Library reads on one server", () => {
  it("sends one at a time, and an opened file's read goes before waiting previews", async () => {
    const server = EnvironmentId.make("reads-order");
    const log: string[] = [];
    const first = read("preview-1", log);
    const second = read("preview-2", log);
    const opened = read("opened", log);
    queuePreviewRead(server, first.request);
    const waiting = queuePreviewRead(server, second.request);
    const openedResult = afterLastChunkRequest(server, opened.request);
    expect(log).toEqual(["preview-1"]);
    first.finish();
    await opened.started;
    expect(log).toEqual(["preview-1", "opened"]);
    opened.finish();
    await expect(openedResult).resolves.toBe("opened");
    await second.started;
    second.finish();
    await expect(waiting.result).resolves.toBe("preview-2");
  });

  it("keeps only the newest previews waiting; older ones never reach the server", async () => {
    const server = EnvironmentId.make("reads-cap");
    const log: string[] = [];
    const running = read("running", log);
    queuePreviewRead(server, running.request);
    const queued = Array.from({ length: MAX_WAITING_PREVIEW_READS + 2 }, (_, index) =>
      read("preview-" + index, log),
    );
    const results = queued.map((entry) => queuePreviewRead(server, entry.request).result);
    await expect(results[0]).resolves.toBeNull();
    await expect(results[1]).resolves.toBeNull();
    running.finish();
    for (const entry of queued.slice(2)) {
      await entry.started;
      entry.finish();
    }
    expect(log).toEqual([
      "running",
      ...queued.slice(2).map((_, index) => "preview-" + (index + 2)),
    ]);
  });

  it("drops a preview whose card went away before its turn", async () => {
    const server = EnvironmentId.make("reads-cancel");
    const log: string[] = [];
    const running = read("running", log);
    const gone = read("gone", log);
    const next = read("next", log);
    queuePreviewRead(server, running.request);
    const leaving = queuePreviewRead(server, gone.request);
    const staying = queuePreviewRead(server, next.request);
    leaving.cancel();
    await expect(leaving.result).resolves.toBeNull();
    running.finish();
    await next.started;
    next.finish();
    await expect(staying.result).resolves.toBe("next");
    expect(log).toEqual(["running", "next"]);
  });
});
