// @effect-diagnostics nodeBuiltinImport:off -- The fake helper speaks over in-memory Node streams, and discovery reads a real temporary directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeReadline from "node:readline";

import { assert, describe, expect, it } from "@effect/vitest";

import {
  ComputerUseHelperError,
  classifyHelperBundle,
  daemonMismatch,
  makeHelperHost,
  openHelperSession,
  type HelperProcess,
} from "./ComputerUseHelper.ts";

const BUNDLE_ID = "si.goat.desktop.dev.computer-use";

/** A scripted helper on in-memory pipes: greets, then answers each request with reply(). */
function fakeHelper(options: {
  readonly greeting?: object;
  /** write sends an unrequested line before the reply goes out; after() runs once it has. */
  readonly reply?: (
    request: { id: string; method: string; params: unknown },
    write: (line: object) => void,
  ) => object | undefined;
  readonly after?: (request: { id: string; method: string }, write: (line: object) => void) => void;
}) {
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  const received: Array<{ method: string; params: unknown }> = [];
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => (exit = resolve));
  let stdinEnded = false;
  const die = () => {
    stdout.end();
    exit();
  };
  stdin.on("end", () => {
    stdinEnded = true;
    die();
  });
  const write = (line: object) => stdout.write(JSON.stringify(line) + "\n");
  NodeReadline.createInterface({ input: stdin }).on("line", (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: unknown };
    received.push({ method: request.method, params: request.params });
    const answer = options.reply?.(request, write);
    if (answer) stdout.write(JSON.stringify({ id: request.id, ...answer }) + "\n");
    options.after?.(request, write);
  });
  stdout.write(
    JSON.stringify(
      options.greeting ?? {
        type: "hello",
        protocol: 1,
        pid: 99,
        bundleId: BUNDLE_ID,
        version: "1",
      },
    ) + "\n",
  );
  const process: HelperProcess = {
    stdin,
    stdout,
    kill: () => die(),
    exited,
  };
  return { process, received, die, stdinEnded: () => stdinEnded };
}

const helperError = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  assert.instanceOf(error, ComputerUseHelperError);
  return error as ComputerUseHelperError;
};

describe("ComputerUseHelper protocol", () => {
  it.each([
    {
      name: "another helper identity",
      greeting: { type: "hello", protocol: 1, pid: 1, bundleId: "si.goat.desktop.computer-use" },
      code: "bundle_mismatch",
    },
    {
      name: "a newer protocol",
      greeting: { type: "hello", protocol: 2, pid: 1, bundleId: BUNDLE_ID },
      code: "protocol_mismatch",
    },
    {
      name: "an untrusted launcher",
      greeting: { type: "refused", reason: "untrusted_parent", message: "not signed by team" },
      code: "untrusted_parent",
    },
  ])("refuses $name with a typed code and closes the helper", async ({ greeting, code }) => {
    const helper = fakeHelper({ greeting });
    const error = await helperError(openHelperSession(helper.process, BUNDLE_ID));
    assert.equal(error.code, code);
    assert.isTrue(helper.stdinEnded());
  });

  it("matches replies to requests and turns helper errors into typed errors", async () => {
    const helper = fakeHelper({
      reply: ({ method }) =>
        method === "permissions"
          ? { result: { accessibility: true, screenRecording: false } }
          : { error: { code: "socket_in_use", message: "Something already exists." } },
    });
    const session = await openHelperSession(helper.process, BUNDLE_ID);
    assert.equal(session.pid, 99);
    const [grants, refused] = await Promise.all([
      session.permissions(false),
      helperError(session.start({ socketPath: "/tmp/x.sock", environment: [], noOverlay: false })),
    ]);
    assert.deepEqual(grants, { accessibility: true, screenRecording: false });
    assert.equal(refused.code, "socket_in_use");
    assert.deepEqual(helper.received[0], { method: "permissions", params: { prompt: false } });
    await session.close();
  });

  it("can watch only when the helper's hello says so", async () => {
    const hello = { type: "hello", protocol: 1, pid: 99, bundleId: BUNDLE_ID };
    const older = await openHelperSession(fakeHelper({ greeting: hello }).process, BUNDLE_ID);
    const newer = await openHelperSession(
      fakeHelper({ greeting: { ...hello, features: ["watch"] } }).process,
      BUNDLE_ID,
    );
    expect([older.canWatch, newer.canWatch]).toEqual([false, true]);
    await Promise.all([older.close(), newer.close()]);
  });

  it("passes on only the frames of the capture request in force, once it is sent", async () => {
    const picture = (framesId: number) => ({
      type: "frame",
      framesId,
      key: "desktop:control:a",
      width: 320,
      height: 200,
      data: "QUJD",
    });
    const helper = fakeHelper({
      greeting: { type: "hello", protocol: 1, pid: 99, bundleId: BUNDLE_ID, features: ["frames"] },
      // A frame of the old request still in the pipe when the new one is answered.
      reply: ({ params }, write) => {
        const { framesId } = params as { framesId: number };
        write(picture(framesId - 1));
        return { result: { framesId } };
      },
      after: ({ params }, write) => {
        const { framesId } = params as { framesId: number };
        write(picture(framesId));
        write({ type: "frameUnavailable", framesId, key: "desktop:control:a", reason: "private" });
      },
    });
    const session = await openHelperSession(helper.process, BUNDLE_ID);
    assert.isTrue(session.canFrame);
    const seen: Array<{ type: string; framesId: number }> = [];
    const done = new Promise<void>((resolve) =>
      session.onFrame((frame) => {
        seen.push({ type: frame.type, framesId: frame.framesId });
        if (frame.type === "frameUnavailable") resolve();
      }),
    );
    await session.frames(5, [
      { key: "desktop:control:a", pid: 7, windowId: 3, maxWidth: 320, intervalMs: 500 },
    ]);
    await done;
    assert.deepEqual(seen, [
      { type: "frame", framesId: 5 },
      { type: "frameUnavailable", framesId: 5 },
    ]);
    assert.deepEqual(helper.received.at(-1)?.method, "frames");
    await session.close();
  });

  it("delivers the events of the watch in force, switching watches as the answer is read", async () => {
    const target = (windowId: number) => ({ pid: 7, windowId });
    const event = (watchId: string, active: boolean, windowId: number) => ({
      type: "event",
      watchId,
      event: { type: "privateMode", active, target: target(windowId) },
    });
    const helper = fakeHelper({
      reply: (request, write) => {
        const params = request.params as { watchId?: string };
        // The old watch clears its active field before the new watch is answered.
        if (request.method === "watch" && params.watchId === "w2") write(event("w1", false, 1));
        // A stray event of a watch that is not in force.
        if (request.method === "watch") write(event("other", true, 9));
        return { result: { watchId: params.watchId } };
      },
      after: (request, write) => {
        const params = request as unknown as { params: { watchId?: string } };
        if (request.method === "watch")
          write(event(params.params.watchId ?? "", true, params.params.watchId === "w1" ? 1 : 2));
      },
    });
    const session = await openHelperSession(helper.process, BUNDLE_ID);
    const seen: Array<{ active: boolean; windowId: number }> = [];
    const done = new Promise<void>((resolve) =>
      session.onEvent((delivered) => {
        if (delivered.type !== "privateMode") return;
        seen.push({ active: delivered.active, windowId: delivered.target.windowId });
        if (seen.length === 3) resolve();
      }),
    );
    await session.watch("w1");
    await session.watch("w2");
    await done;
    // w1's first state, w1's clearing under the old watch, then w2's first state.
    expect(seen).toEqual([
      { active: true, windowId: 1 },
      { active: false, windowId: 1 },
      { active: true, windowId: 2 },
    ]);
    expect(helper.received.map(({ method }) => method)).toEqual(["watch", "watch"]);
    await session.close();
  });

  it("fails a request in flight when the helper exits, and reports the session ended", async () => {
    const helper = fakeHelper({});
    const session = await openHelperSession(helper.process, BUNDLE_ID);
    const pending = session.stop();
    helper.die();
    assert.equal((await helperError(pending)).code, "helper_exited");
    await session.ended;
    assert.equal((await helperError(session.permissions(false))).code, "helper_exited");
  });
});

describe("ComputerUseHelper daemon admission", () => {
  it("hands an agent connection the helper's own --mcp command and starts no daemon", async () => {
    const helper = fakeHelper({ reply: () => ({ result: {} }) });
    const bundlePath = "/Applications/GOAT.app/Contents/Helpers/GOAT Computer Use.app";
    const host = makeHelperHost({
      bundle: {
        bundlePath,
        executable: bundlePath + "/Contents/MacOS/GOAT Computer Use",
        driverPath: bundlePath + "/Contents/Resources/cua-driver/cua-driver",
        bundleId: BUNDLE_ID,
      },
      driverVersion: "0.37.0",
      capabilityManifestPath: "/state/cua-driver/agents.yaml",
      environment: [{ name: "CUA_DRIVER_KEY_GAP_MS", value: "20" }],
      spawn: () => helper.process,
      readMetadata: () => Promise.reject(new Error("no daemon to read")),
      direct: true,
    });
    const connection = await host.start();
    expect(connection.mcp).toEqual({
      command: bundlePath + "/Contents/MacOS/GOAT Computer Use",
      args: ["--mcp", "--capability-manifest", "/state/cua-driver/agents.yaml"],
      environment: [{ name: "CUA_DRIVER_KEY_GAP_MS", value: "20" }],
    });
    // No socket and no daemon: the driver exists only under each connection's helper.
    expect(connection.socketPath).toBe("");
    expect(helper.received).toEqual([]);
    await host.stop();
  });

  const expected = { pid: 700, bundleId: BUNDLE_ID, driverVersion: "0.37.0" };
  const metadata = {
    driverVersion: "0.37.0",
    contractVersion: "0.8.0",
    mcpProtocolVersion: "2025-06-18",
    pid: 700,
    embedded: true,
    hostBundleId: BUNDLE_ID,
  };

  it("admits only the embedded daemon the helper started, for this helper, at the pinned version", () => {
    assert.isUndefined(daemonMismatch(metadata, expected));
    assert.match(daemonMismatch({ ...metadata, pid: 1 }, expected) ?? "", /belongs to pid 1/);
    assert.match(
      daemonMismatch({ ...metadata, embedded: false }, expected) ?? "",
      /not running embedded/,
    );
    assert.match(
      daemonMismatch({ ...metadata, hostBundleId: "si.goat.desktop" }, expected) ?? "",
      /reports host si.goat.desktop/,
    );
    assert.match(
      daemonMismatch({ ...metadata, driverVersion: "0.38.0" }, expected) ?? "",
      /0.38.0/,
    );
  });

  it("stops the driver and the helper instead of handing out a daemon that fails admission", async () => {
    const helper = fakeHelper({
      reply: ({ method, params }) =>
        method === "start"
          ? {
              result: {
                socketPath: (params as { socketPath: string }).socketPath,
                driverPid: 700,
                hostBundleId: BUNDLE_ID,
              },
            }
          : { result: {} },
    });
    const host = makeHelperHost({
      bundle: {
        bundlePath: "/Helpers/GOAT Computer Use.app",
        executable: "/Helpers/GOAT Computer Use.app/Contents/MacOS/GOAT Computer Use",
        driverPath: "/Helpers/GOAT Computer Use.app/Contents/Resources/cua-driver/cua-driver",
        bundleId: BUNDLE_ID,
      },
      driverVersion: "0.37.0",
      capabilityManifestPath: "/state/manifest.yaml",
      environment: [],
      spawn: () => helper.process,
      // Something else answered on the socket.
      readMetadata: async () => ({ ...metadata, pid: 4 }),
    });
    const error = await helperError(host.start());
    assert.equal(error.code, "incompatible_daemon");
    assert.deepEqual(
      helper.received.map(({ method }) => method),
      ["start", "stop"],
    );
    assert.isTrue(helper.stdinEnded());
    assert.isUndefined(host.servicePid());
  });

  it.each([
    { name: "the helper's relay where screenshots are guarded (Windows)", through: true },
    { name: "the driver itself elsewhere", through: false },
  ])("hands agents $name as the MCP command, with the same route", async ({ through }) => {
    const helper = fakeHelper({
      reply: ({ method, params }) =>
        method === "start"
          ? {
              result: {
                socketPath: (params as { socketPath: string }).socketPath,
                driverPid: 700,
                hostBundleId: BUNDLE_ID,
              },
            }
          : { result: {} },
    });
    const bundle = {
      bundlePath: "C:/GOAT/resources/computer-use-helper",
      executable: "C:/GOAT/resources/computer-use-helper/GOAT Computer Use.exe",
      driverPath: "C:/GOAT/resources/computer-use-helper/cua-driver/cua-driver.exe",
      bundleId: BUNDLE_ID,
    };
    const host = makeHelperHost({
      bundle,
      driverVersion: "0.37.0",
      capabilityManifestPath: "C:/state/manifest.yaml",
      environment: [],
      spawn: () => helper.process,
      readMetadata: async () => metadata,
      socket: async () => ({ path: "\\\\.\\pipe\\goat-cu-test", release: async () => {} }),
      mcpThroughHelper: through,
    });
    const connection = await host.start();
    assert.equal(connection.mcp.command, through ? bundle.executable : bundle.driverPath);
    expect(connection.mcp.args).toEqual([
      "mcp",
      "--embedded",
      "--socket",
      "\\\\.\\pipe\\goat-cu-test",
      "--host-bundle-id",
      BUNDLE_ID,
    ]);
    await host.stop();
  });
});

describe("ComputerUseHelper bundle discovery", () => {
  /** A temporary directory removed when the test ends, pass or fail. */
  const scratch = (onTestFinished: (cleanup: () => void) => void) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-test-"));
    onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    return directory;
  };
  const makeBundle = (root: string) => {
    const bundle = NodePath.join(root, "GOAT Computer Use.app");
    NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bundle, "Contents", "MacOS", "GOAT Computer Use"), "", {
      mode: 0o755,
    });
    return bundle;
  };

  it("falls back only when nothing at all is at the helper path", async ({ onTestFinished }) => {
    const root = scratch(onTestFinished);
    expect(await classifyHelperBundle(NodePath.join(root, "GOAT Computer Use.app"), false)).toEqual(
      { kind: "absent" },
    );
    // A path the developer set must exist.
    expect(
      (await classifyHelperBundle(NodePath.join(root, "GOAT Computer Use.app"), true)).kind,
    ).toBe("unusable");
  });

  it("treats a dangling link or a bundle without its executable as unusable, not absent", async ({
    onTestFinished,
  }) => {
    const root = scratch(onTestFinished);
    const link = NodePath.join(root, "GOAT Computer Use.app");
    NodeFS.symlinkSync(NodePath.join(root, "missing.app"), link);
    expect(await classifyHelperBundle(link, false)).toMatchObject({
      kind: "unusable",
      message: expect.stringContaining("ENOENT"),
    });
    const empty = NodePath.join(scratch(onTestFinished), "GOAT Computer Use.app");
    NodeFS.mkdirSync(empty);
    expect((await classifyHelperBundle(empty, false)).kind).toBe("unusable");
  });

  it("finds a bundle through a link at its resolved path", async ({ onTestFinished }) => {
    const root = scratch(onTestFinished);
    const bundle = makeBundle(root);
    const link = NodePath.join(scratch(onTestFinished), "GOAT Computer Use.app");
    NodeFS.symlinkSync(bundle, link);
    expect(await classifyHelperBundle(link, false)).toEqual({
      kind: "found",
      path: NodeFS.realpathSync(bundle),
    });
  });
});
