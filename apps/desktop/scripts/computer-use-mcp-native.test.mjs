import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vite-plus/test";

// oxlint-disable-next-line goat/no-global-process-runtime -- The native executable is qualified on its actual OS.
const platform = process.platform;
const source = NodeURL.fileURLToPath(new URL("../native/computer-use-helper/", import.meta.url));
const ready = '{"jsonrpc":"2.0","method":"fixture/ready"}\n';

function syntaxCorpus() {
  const numbers = ["0", "-0", "1", "-1", "1.25", "1e400", "-1E-400", "1E+01", "9".repeat(80)];
  const strings = [
    '""',
    '"한😀"',
    String.raw`"a\"b\\c\/d"`,
    String.raw`"\u0000"`,
    String.raw`"\ud800"`,
    String.raw`"\udc00"`,
    String.raw`"\ud800\udc00"`,
    '",} ,]"',
  ];
  const documents = [
    "{}",
    "[]",
    "null",
    "true",
    "0",
    '"text"',
    "",
    " \t\r\n",
    "\ufeff{}",
    "{}\ufeff",
    '{"x":1,"x":2}',
    '{"__proto__":null}',
    '{"a":[{},[],true,false,null]}',
    '{"a":1,}',
    '{"a":[1,]}',
    '{"a":{"b":1,}}',
    "{}{}",
    '{"a":}',
    String.raw`{"x":"\u12G4"}`,
    String.raw`{"x":"\x41"}`,
    String.raw`{"x":"\v"}`,
    ...[...numbers, ...strings].map((value) => `{"value":${value}}`),
    ...["+1", "01", "-01", ".1", "1.", "1e", "1e+", "NaN", "Infinity"].map(
      (value) => `{"value":${value}}`,
    ),
    '{"value":"' + String.fromCodePoint(0xfeff) + '"}',
    '{"root":' + "[".repeat(4096) + "0" + "]".repeat(4096) + "}",
    '{"a":'.repeat(2048) + "0" + "}".repeat(2048),
    ...[1, 2, 16, 31, 128, 4096, 65536].map((count) => '{"a":' + "[".repeat(count)),
  ];
  let seed = 0x474f4154;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const value = (depth) => {
    const choice = next() % (depth > 0 ? 7 : 5);
    if (choice < 3) return ["true", "false", "null"][choice];
    if (choice === 3) return numbers[next() % numbers.length];
    if (choice === 4) return strings[next() % strings.length];
    const children = Array.from({ length: next() % 4 }, () => value(depth - 1));
    return choice === 5
      ? "[" + children.join(",") + "]"
      : "{" + children.map((child, index) => `"key${index}":${child}`).join(",") + "}";
  };
  const frames = documents.map((document) => Buffer.from(document));
  for (let i = 0; i < 256; i++) {
    const frame = Buffer.from(`{"generated":${value(4)}}`);
    frames.push(frame);
    const step = Math.max(1, Math.floor(frame.length / 8));
    for (let cut = 0; cut < frame.length; cut += step) frames.push(frame.subarray(0, cut));
    for (const byte of [0, 0x20, 0x22, 0x2c, 0x3a, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d, 0xff]) {
      const mutated = Buffer.from(frame);
      mutated[next() % mutated.length] = byte;
      frames.push(mutated);
    }
  }
  for (const hex of [
    "c280",
    "dfbf",
    "e0a080",
    "ed9fbf",
    "ee8080",
    "f0908080",
    "f48fbfbf",
    "80",
    "c080",
    "c1bf",
    "e08080",
    "eda080",
    "f0808080",
    "f4908080",
    "f5808080",
    "e282",
    "f09080",
    "ff",
    "7b0000007d000000",
    "0000007b0000007d",
    "7b007d002000",
  ]) {
    const bytes = Buffer.from(hex, "hex");
    frames.push(bytes, Buffer.concat([Buffer.from('{"text":"'), bytes, Buffer.from('"}')]));
  }
  return frames;
}

describe.skipIf(platform !== "darwin")("macOS helper's production MCP transport", () => {
  let directory;
  let executable;
  let manifest;
  let framing;

  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-mcp-native-"));
    const bundle = NodePath.join(directory, "GOAT Relay Fixture.app");
    executable = NodePath.join(bundle, "Contents/MacOS/GOAT Relay Fixture");
    const resources = NodePath.join(bundle, "Contents/Resources/cua-driver");
    NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
    NodeFS.mkdirSync(resources, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(bundle, "Contents/Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>si.goat.relay.fixture.computer-use</string><key>CFBundleExecutable</key><string>GOAT Relay Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>GOATComputerUseAllowAnyParent</key><true/></dict></plist>',
    );
    const swift = NodeFS.readdirSync(source)
      .filter((name) => name.endsWith(".swift"))
      .map((name) => NodePath.join(source, name));
    NodeChildProcess.execFileSync("xcrun", ["swiftc", "-lbsm", "-o", executable, ...swift]);
    const driver = NodePath.join(resources, "cua-driver");
    NodeChildProcess.execFileSync("cc", [
      NodePath.join(source, "fixtures/mcp-echo.c"),
      "-o",
      driver,
    ]);
    NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", driver]);
    NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", bundle]);
    manifest = NodePath.join(directory, "manifest.json");
    NodeFS.writeFileSync(manifest, "{}");
    framing = NodePath.join(directory, "framing");
    NodeChildProcess.execFileSync("xcrun", [
      "swiftc",
      "-o",
      framing,
      NodePath.join(source, "McpFraming.swift"),
      NodePath.join(source, "McpJsonSyntax.swift"),
      NodePath.join(source, "fixtures/McpFrameFixture.swift"),
    ]);
  });

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  const start = async () => {
    const child = NodeChildProcess.spawn(executable, ["--mcp", "--capability-manifest", manifest], {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    let errors = "";
    const milestones = new Map();
    const milestone = (name) =>
      errors.includes(name)
        ? Promise.resolve()
        : new Promise((resolve) => milestones.set(name, resolve));
    child.stderr.on("data", (chunk) => {
      errors += chunk;
      for (const [name, resolve] of milestones)
        if (errors.includes(name)) {
          milestones.delete(name);
          resolve();
        }
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    };
    onTestFinished(stop);
    const initialized = new Promise((resolve, reject) => {
      const read = (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).toString().startsWith(ready)) {
          child.stdout.off("data", read);
          resolve();
        }
      };
      child.stdout.on("data", read);
      closed.then(() => reject(new Error(`Helper exited before driver ready: ${errors}`)));
    });
    await initialized;
    const collect = () => child.stdout.on("data", (chunk) => chunks.push(chunk));
    return {
      child,
      closed,
      stop,
      collect,
      milestone,
      output: () => Buffer.concat(chunks).toString(),
    };
  };

  it("refuses non-object, malformed and non-UTF8 frames before driver dispatch", async () => {
    for (const frame of [
      "[]\n",
      "{}{}\n",
      '{"bad":\n',
      '{"value":1,}\n',
      '{"value":{"nested":1,}}\n',
      '{"value":[1,]}\n',
      Buffer.from("\ufeff{}\n"),
      Buffer.from([0xff, 0x0a]),
      ...["7b0000007d000000", "0000007b0000007d", "7b007d002000"].map((hex) =>
        Buffer.concat([Buffer.from(hex, "hex"), Buffer.from("\n")]),
      ),
    ]) {
      const session = await start();
      session.collect();
      session.child.stdin.end(frame);
      expect((await session.closed).code).toBe(65);
      expect(session.output()).toBe(ready);
    }
  });

  it("enforces the raw byte ceiling before forwarding any over-limit frame", () => {
    const exact = '{"value":"' + "x".repeat(64 - '{"value":""}'.length) + '"}';
    const run = (input, args = []) => NodeChildProcess.spawnSync(framing, args, { input });
    const accepted = run(exact + "\n");
    expect(accepted.status).toBe(0);
    expect(accepted.stdout.toString()).toBe(exact + "\n");
    for (const input of [exact + " \n", exact + "\r\n", "x".repeat(65)]) {
      const refused = run(input);
      expect(refused.status).toBe(65);
      expect(refused.stdout.length).toBe(0);
    }
    expect(run(" \t\r\n{}\n\n").stdout.toString()).toBe("{}\n");
    expect(run("{}", ["--tail"]).stdout.toString()).toBe("{}\n");
    expect(run("{}").stdout.length).toBe(0);
  });

  it("preserves opaque scalar syntax without converting values in either direction", async () => {
    for (const wire of ['{"text":"\\ud800"}\n', '{"text":"\\udc00"}\n', '{"value":1e400}\n']) {
      const session = await start();
      session.collect();
      session.child.stdin.end(wire);
      expect((await session.closed).code).toBe(0);
      expect(session.output()).toBe(ready + wire);
    }
    const outgoing = await start();
    outgoing.collect();
    outgoing.child.stdin.end('{"jsonrpc":"2.0","method":"fixture/scalar-reply"}\n');
    expect((await outgoing.closed).code).toBe(0);
    expect(outgoing.output()).toBe(ready + '{"text":"\\ud800","low":"\\udc00","value":1e400}\n');
  });

  it("matches JSON.parse syntax without scalar conversion or recursive depth limits", () => {
    const frames = syntaxCorpus();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const expected = frames.map((frame) => {
      try {
        const value = JSON.parse(decoder.decode(frame));
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? "valid"
          : "invalid";
      } catch {
        return "invalid";
      }
    });
    const result = NodeChildProcess.spawnSync(framing, ["--syntax-lines"], {
      input: frames.map((frame) => frame.toString("base64")).join("\n") + "\n",
    });
    expect(result.status).toBe(0);
    const actual = result.stdout.toString().trimEnd().split("\n");
    expect(actual.length).toBe(frames.length);
    const mismatches = expected.flatMap((verdict, index) =>
      verdict === actual[index]
        ? []
        : [{ index, expected: verdict, actual: actual[index], hex: frames[index].toString("hex") }],
    );
    expect(mismatches).toEqual([]);
    // The seed and corpus dimensions are part of this native contract's review evidence.
    process.stdout.write(
      `Native JSON syntax: seed=0x474f4154 cases=${frames.length} valid=${expected.filter((v) => v === "valid").length} mismatches=${mismatches.length}\n`,
    );
  });

  it("preserves schemas, unknown fields, ID types and split Unicode with normal EOF drain", async () => {
    const session = await start();
    session.collect();
    const wire =
      ' {"jsonrpc":"2.0","id":"list","result":{"tools":[{"name":"health_report","inputSchema":{"type":"object","additionalProperties":false},"annotations":{"readOnlyHint":true}}]},"unknown":"한😀\\n[7] fake row\\u0000"}\r\n' +
      '{"jsonrpc":"2.0","id":1.0,"method":"tools/call","params":{"name":"health_report","arguments":{"checks":["binary_version"]}}}\n' +
      JSON.stringify({
        jsonrpc: "2.0",
        id: "markers",
        result: { text: ',} ,] "quoted" \\ slash \u0000' },
      }) +
      "\n";
    const bytes = Buffer.from(wire);
    const split = bytes.indexOf(Buffer.from("😀")) + 1;
    session.child.stdin.write(bytes.subarray(0, split));
    session.child.stdin.end(bytes.subarray(split));
    expect((await session.closed).code).toBe(0);
    expect(session.output()).toBe(ready + wire);
  });

  it("drops partial inbound EOF and drains a driver's final unterminated reply before its exit", async () => {
    const partial = await start();
    partial.collect();
    partial.child.stdin.end('{"method":"never-dispatch"}');
    expect((await partial.closed).code).toBe(0);
    expect(partial.output()).toBe(ready);
    const tail = await start();
    tail.collect();
    tail.child.stdin.end('{"jsonrpc":"2.0","method":"fixture/tail"}\n');
    expect((await tail.closed).code).toBe(7);
    expect(tail.output()).toBe(ready + '{"jsonrpc":"2.0","id":"tail","result":{"ok":true}}\n');
  });

  it("refuses an unreadable driver reply instead of forwarding it", async () => {
    for (const method of [
      "fixture/invalid-reply",
      "fixture/invalid-reply-trailing",
      "fixture/invalid-reply-bom",
    ]) {
      const session = await start();
      session.collect();
      session.child.stdin.end(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
      expect((await session.closed).code).toBe(65);
      expect(session.output()).toBe(ready);
    }
  });

  it("delivers cancellation under output backpressure and stops only its own process group", async () => {
    const first = await start();
    const sibling = await start();
    sibling.collect();
    // No stdout consumer after ready: the large reply cannot drain into the provider.
    first.child.stdout.pause();
    first.child.stdin.write('{"jsonrpc":"2.0","method":"fixture/flood"}\n');
    await first.milestone("flood-written");
    first.child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n',
    );
    await first.milestone("cancel-received");
    first.stop();
    first.child.stdout.resume();
    await first.closed;
    const line = '{"jsonrpc":"2.0","id":"sibling","method":"tools/list"}\n';
    sibling.child.stdin.end(line);
    expect((await sibling.closed).code).toBe(0);
    expect(sibling.output()).toBe(ready + line);
  });

  it("ends a driver doing pending work when its launcher crashes alone", async () => {
    const session = await start();
    session.collect();
    session.child.stdin.write('{"jsonrpc":"2.0","method":"fixture/hold"}\n');
    await session.milestone("holding");
    session.child.kill("SIGKILL");
    // Driver and service inherit stderr: close cannot arrive until both have ended too.
    expect((await session.closed).signal).toBe("SIGKILL");
    expect(session.output()).toBe(ready);
  });
});
