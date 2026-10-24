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
  readonly reply?: (request: { id: string; method: string; params: unknown }) => object | undefined;
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
  NodeReadline.createInterface({ input: stdin }).on("line", (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: unknown };
    received.push({ method: request.method, params: request.params });
    const answer = options.reply?.(request);
    if (answer) stdout.write(JSON.stringify({ id: request.id, ...answer }) + "\n");
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
});

describe("ComputerUseHelper bundle discovery", () => {
  const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-test-"));
  const makeBundle = (root: string) => {
    const bundle = NodePath.join(root, "GOAT Computer Use.app");
    NodeFS.mkdirSync(NodePath.join(bundle, "Contents", "MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bundle, "Contents", "MacOS", "GOAT Computer Use"), "", {
      mode: 0o755,
    });
    return bundle;
  };

  it("falls back only when nothing at all is at the helper path", async () => {
    const root = scratch();
    expect(await classifyHelperBundle(NodePath.join(root, "GOAT Computer Use.app"), false)).toEqual(
      { kind: "absent" },
    );
    // A path the developer set must exist.
    expect(
      (await classifyHelperBundle(NodePath.join(root, "GOAT Computer Use.app"), true)).kind,
    ).toBe("unusable");
  });

  it("treats a dangling link or a bundle without its executable as unusable, not absent", async () => {
    const root = scratch();
    const link = NodePath.join(root, "GOAT Computer Use.app");
    NodeFS.symlinkSync(NodePath.join(root, "missing.app"), link);
    expect(await classifyHelperBundle(link, false)).toMatchObject({
      kind: "unusable",
      message: expect.stringContaining("ENOENT"),
    });
    const empty = NodePath.join(scratch(), "GOAT Computer Use.app");
    NodeFS.mkdirSync(empty);
    expect((await classifyHelperBundle(empty, false)).kind).toBe("unusable");
  });

  it("finds a bundle through a link at its resolved path", async () => {
    const root = scratch();
    const bundle = makeBundle(root);
    const link = NodePath.join(scratch(), "GOAT Computer Use.app");
    NodeFS.symlinkSync(bundle, link);
    expect(await classifyHelperBundle(link, false)).toEqual({
      kind: "found",
      path: NodeFS.realpathSync(bundle),
    });
  });
});
