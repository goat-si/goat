import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vite-plus/test";

import { buildHelperFixture } from "./computer-use-helper-fixture.mjs";

// oxlint-disable-next-line goat/no-global-process-runtime -- The native executable is qualified on its actual OS.
const platform = process.platform;
const ready = { jsonrpc: "2.0", method: "fixture/ready" };

/** JSON lines from a stream, taken in order; each take waits for the next line. */
function lineQueue(stream) {
  const lines = [];
  const waiters = [];
  let buffered = "";
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  stream.on("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.resolve(undefined);
  });
  return {
    /** The next line, or undefined once the stream closed without one. */
    take: () =>
      lines.length > 0
        ? Promise.resolve(lines.shift())
        : ended
          ? Promise.resolve(undefined)
          : new Promise((resolve) => waiters.push({ resolve })),
  };
}

describe.skipIf(platform !== "darwin")("macOS helper service's agent sessions", () => {
  // Built while the suite is collected: compiling the whole helper can outlast a hook's ceiling
  // when other suites compile at the same time.
  // A skipped suite is still collected, so only macOS builds it.
  const directory =
    platform === "darwin"
      ? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-sessions-"))
      : "";
  const executable =
    platform === "darwin" ? buildHelperFixture(directory, { optimize: false }).executable : "";
  const manifest = NodePath.join(directory, "manifest.json");
  if (platform === "darwin") NodeFS.writeFileSync(manifest, "{}");

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  /** The desktop's side: the service it launches and its stdio channel. */
  const startService = async () => {
    const child = NodeChildProcess.spawn(executable, [], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    });
    let errors = "";
    const milestones = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errors += chunk;
      for (const milestone of milestones.splice(0))
        if (errors.includes(milestone.text)) milestone.resolve();
        else milestones.push(milestone);
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    // Every process holding the service's stderr has ended: launcher, service and drivers.
    const stdioClosed = new Promise((resolve) => child.once("close", resolve));
    const replies = new Map();
    const events = [];
    const eventWaiters = [];
    let greet;
    const hello = new Promise((resolve) => (greet = resolve));
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (message.type === "hello") greet(message);
        else if (message.type === "sessionDriverExited") {
          const waiter = eventWaiters.findIndex((entry) => entry.match(message));
          if (waiter >= 0) eventWaiters.splice(waiter, 1)[0].resolve(message);
          else events.push(message);
        } else if (message.id !== undefined) replies.get(message.id)?.(message);
      }
    });
    let next = 0;
    const request = (method, params = {}) => {
      const id = String(++next);
      const reply = new Promise((resolve) => replies.set(id, resolve));
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      return reply;
    };
    const greeting = await hello;
    const open = async (sessionId) => {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const reply = await request("openSession", {
        sessionId,
        token,
        capabilityManifestPath: manifest,
        environment: [],
      });
      expect(reply.error).toBeUndefined();
      return { sessionId, token, ...reply.result };
    };
    return {
      child,
      greeting,
      exited,
      stdioClosed,
      request,
      open,
      /** The driver exit the service reports for a session. */
      driverExit: (sessionId, generation) => {
        const match = (event) => event.sessionId === sessionId && event.generation === generation;
        const seen = events.findIndex(match);
        if (seen >= 0) return Promise.resolve(events.splice(seen, 1)[0]);
        return new Promise((resolve) => eventWaiters.push({ match, resolve }));
      },
      stderrIncludes: (text) =>
        errors.includes(text)
          ? Promise.resolve()
          : new Promise((resolve) => milestones.push({ text, resolve })),
      diagnostics: () => errors,
    };
  };

  /** An agent connection's side: one socket connection, challenged by the service. */
  const connect = async (socketPath) => {
    const socket = NodeNet.createConnection(socketPath);
    onTestFinished(() => socket.destroy());
    const lines = lineQueue(socket);
    const closed = new Promise((resolve) => socket.once("close", resolve));
    return { socket, lines, closed, send: (value) => socket.write(JSON.stringify(value) + "\n") };
  };
  const attach = async (session, channel = "mcp", override = {}) => {
    const connection = await connect(session.socketPath);
    expect(await connection.lines.take()).toEqual({ type: "challenge", protocol: 1 });
    connection.send({
      session: session.sessionId,
      launch: session.launch,
      token: session.token,
      channel,
      ...override,
    });
    return { ...connection, reply: await connection.lines.take() };
  };
  const echo = async (connection, who) => {
    const frame = { jsonrpc: "2.0", id: 1, method: "fixture/echo", params: { who } };
    connection.send(frame);
    return connection.lines.take();
  };

  it("hosts several sessions at once, each with its own driver, and keeps their replies apart", async () => {
    const service = await startService();
    const sessions = await Promise.all(["a", "b", "c", "d"].map((id) => service.open(id)));
    const socketPath = sessions[0].socketPath;
    expect(new Set(sessions.map((session) => session.socketPath))).toEqual(new Set([socketPath]));
    expect(sessions.every((session) => session.servicePid === service.greeting.pid)).toBe(true);
    const folder = NodeFS.statSync(NodePath.dirname(socketPath));
    expect(folder.mode & 0o777).toBe(0o700);
    expect(folder.uid).toBe(process.getuid());
    expect(service.greeting.features).toContain("sessions");

    const attached = await Promise.all(sessions.map((session) => attach(session)));
    for (const connection of attached) {
      expect(connection.reply).toMatchObject({
        type: "attached",
        channel: "mcp",
        servicePid: service.greeting.pid,
        generation: 1,
      });
      expect(await connection.lines.take()).toEqual(ready);
    }
    const drivers = attached.map((connection) => connection.reply.driverPid);
    expect(new Set(drivers).size).toBe(4);
    // Every session asks with the same request id; each gets its own answer and no other.
    const answers = await Promise.all(attached.map((connection, index) => echo(connection, index)));
    expect(answers.map((answer) => answer.params.who)).toEqual([0, 1, 2, 3]);
    await service.stderrIncludes("driver-parent:" + service.greeting.pid);
    const parents = service.diagnostics().match(/driver-parent:\d+/g);
    expect(parents).toEqual(Array(4).fill("driver-parent:" + service.greeting.pid));
  });

  it("admits a connection only with its own session's token on this launch", async () => {
    const service = await startService();
    const a = await service.open("a");
    const b = await service.open("b");
    for (const override of [
      { token: b.token },
      { launch: b.token },
      { session: "missing" },
      { session: "b" },
    ]) {
      const refused = await attach(a, "mcp", override);
      expect(refused.reply).toEqual({ type: "refused", reason: "unauthorized" });
      await refused.closed;
    }
    expect((await attach(a, "elsewhere")).reply).toEqual({ type: "refused", reason: "invalid" });
    // An overlay belongs to a running driver, and a session runs one at a time.
    expect((await attach(a, "overlay")).reply).toEqual({ type: "refused", reason: "no_driver" });
    const live = await attach(a);
    expect(live.reply.type).toBe("attached");
    expect((await attach(a)).reply).toEqual({ type: "refused", reason: "busy" });
    expect((await echo(await readied(live), "a")).params.who).toBe("a");
  });

  const readied = async (connection) => {
    expect(await connection.lines.take()).toEqual(ready);
    return connection;
  };

  it("stops one session's driver mid-action, leaves the others running and lets it resume", async () => {
    const service = await startService();
    const a = await service.open("a");
    const b = await service.open("b");
    const first = await readied(await attach(a));
    const other = await readied(await attach(b));
    first.send({ jsonrpc: "2.0", id: 2, method: "fixture/hold" });
    await service.stderrIncludes("holding");

    expect((await service.request("stopSession", { sessionId: "a" })).result).toEqual({
      stopped: true,
    });
    const exit = await service.driverExit("a", 1);
    expect(exit.driverPid).toBe(first.reply.driverPid);
    await first.closed;
    // Reported only after it was reaped, so the pid names nothing any more.
    expect(() => process.kill(exit.driverPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
    expect((await echo(other, "b")).params.who).toBe("b");

    const resumed = await readied(await attach(a));
    expect(resumed.reply.generation).toBe(2);
    expect(resumed.reply.driverPid).not.toBe(first.reply.driverPid);
    expect((await echo(resumed, "a again")).params.who).toBe("a again");
  });

  it("refuses a connection a Stop overtook while it was authenticating", async () => {
    const service = await startService();
    const a = await service.open("a");
    const early = await connect(a.socketPath);
    expect((await early.lines.take()).type).toBe("challenge");
    await service.request("stopSession", { sessionId: "a" });
    early.send({ session: "a", launch: a.launch, token: a.token, channel: "mcp" });
    expect(await early.lines.take()).toEqual({ type: "refused", reason: "stopped" });
    expect((await attach(a)).reply.type).toBe("attached");
  });

  it("starts no driver for an attach a Stop overtook while it read its manifest", async () => {
    const service = await startService();
    // A FIFO manifest holds the attach inside its manifest read, after it reserved the session,
    // and the writer's open settles exactly when the service starts reading.
    const fifo = NodePath.join(directory, "held-manifest-" + NodeCrypto.randomUUID());
    NodeChildProcess.execFileSync("mkfifo", [fifo]);
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const opened = await service.request("openSession", {
      sessionId: "a",
      token,
      capabilityManifestPath: fifo,
      environment: [],
    });
    const a = { sessionId: "a", token, ...opened.result };
    const reading = NodeFS.promises.open(fifo, "w");
    const connection = await connect(a.socketPath);
    expect((await connection.lines.take()).type).toBe("challenge");
    connection.send({ session: "a", launch: a.launch, token, channel: "mcp" });
    const writer = await reading;
    // The service is inside the manifest read now: it has started no driver yet.
    const children = NodeChildProcess.execFileSync("ps", ["-A", "-o", "ppid=,pid="], {
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([parent]) => parent === service.greeting.pid);
    expect(children).toEqual([]);
    expect((await service.request("stopSession", { sessionId: "a" })).result).toEqual({
      stopped: true,
    });
    await writer.writeFile("{}");
    await writer.close();
    // The Stop ended the reserved attachment with its connection, before any driver existed.
    expect(await connection.lines.take()).toBeUndefined();
    // Once every process holding the service's stderr has ended, all a driver could have said
    // has arrived: none started.
    service.child.stdin.end();
    await service.stdioClosed;
    expect(service.diagnostics()).not.toContain("driver-parent:");
  });

  it("ends a driver whose connection closes while the driver no longer reads its input", async () => {
    const service = await startService();
    const a = await service.open("a");
    const b = await service.open("b");
    const held = await readied(await attach(a));
    const other = await readied(await attach(b));
    held.send({ jsonrpc: "2.0", id: 2, method: "fixture/hold" });
    await service.stderrIncludes("holding");
    // One frame larger than the driver's input pipe: the service reads all of it from the
    // socket, then blocks writing it to a driver that stopped reading.
    const bulk = { jsonrpc: "2.0", method: "fixture/bulk", params: { data: "x".repeat(1 << 20) } };
    await new Promise((resolve) => held.socket.write(JSON.stringify(bulk) + "\n", resolve));
    held.socket.destroy();
    const exit = await service.driverExit("a", 1);
    expect(exit.driverPid).toBe(held.reply.driverPid);
    expect((await echo(other, "b")).params.who).toBe("b");
  });

  it("ends every driver, one that ignores SIGTERM too, when the service dies alone", async () => {
    const service = await startService();
    const a = await service.open("a");
    const stubborn = await readied(await attach(a));
    stubborn.send({ jsonrpc: "2.0", method: "fixture/ignore-term" });
    await service.stderrIncludes("ignoring-term");
    // Mid-action as well, so it never reads the end of its input either.
    stubborn.send({ jsonrpc: "2.0", id: 3, method: "fixture/hold" });
    await service.stderrIncludes("holding");
    process.kill(service.greeting.pid, "SIGKILL");
    // The launcher ends its whole group, itself included, while anything of it still runs, and
    // keeps the service's status only once nothing does; which it sees depends on timing.
    expect([null, 128 + 9]).toContain(await service.exited);
    // The held driver never exits by itself and holds the service's stderr, so the launcher's
    // stdio closes only once the driver was killed.
    await service.stdioClosed;
    await stubborn.closed;
  });

  it("forgets a closed session and ends every driver with the service", async () => {
    const service = await startService();
    const a = await service.open("a");
    const b = await service.open("b");
    const first = await readied(await attach(a));
    const other = await readied(await attach(b));
    expect((await service.request("closeSession", { sessionId: "a" })).result).toEqual({});
    await service.driverExit("a", 1);
    await first.closed;
    expect((await attach(a)).reply).toEqual({ type: "refused", reason: "unauthorized" });
    expect((await echo(other, "b")).params.who).toBe("b");
    // The desktop's last claim ends the service: its drivers and its socket go with it.
    service.child.stdin.end();
    expect(await service.exited).toBe(0);
    await other.closed;
    expect(NodeFS.existsSync(NodePath.dirname(a.socketPath))).toBe(false);
  });

  it("closes unauthenticated connections past the cap and auth lines past the limit", async () => {
    const service = await startService();
    const a = await service.open("a");
    const oversized = await connect(a.socketPath);
    expect((await oversized.lines.take()).type).toBe("challenge");
    oversized.socket.write("x".repeat(5000));
    expect(await oversized.lines.take()).toBeUndefined();
    const waiting = await Promise.all(Array.from({ length: 8 }, () => connect(a.socketPath)));
    for (const connection of waiting)
      expect((await connection.lines.take()).type).toBe("challenge");
    const ninth = await connect(a.socketPath);
    expect(await ninth.lines.take()).toBeUndefined();
  });
});
