import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line goat/no-global-process-runtime -- Compile the production Swift module on its supported OS.
const platform = process.platform;
const source = NodeURL.fileURLToPath(new URL("../native/computer-use-helper/", import.meta.url));
const routingKeys = [
  "jsonrpc",
  "id",
  "method",
  "params",
  "name",
  "arguments",
  "result",
  "error",
  "tools",
  "requestId",
  "code",
  "message",
  "structuredContent",
  "content",
  "pid",
  "window_id",
  "since",
  "invalidated_snapshot_ids",
  "session",
];
const encoded = (text) => Buffer.from(text).toString("base64");
const decoded = (text) => Buffer.from(text, "base64").toString();

// quarantine: #1506 This production Swift transport module targets macOS; Windows is a separate implementation.
describe.skipIf(platform !== "darwin")("selective production MCP object routing", () => {
  let directory;
  let executable;

  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-mcp-object-"));
    executable = NodePath.join(directory, "object");
    NodeChildProcess.execFileSync("xcrun", [
      "swiftc",
      "-o",
      executable,
      ...[
        "McpObject.swift",
        "McpFraming.swift",
        "McpJsonSyntax.swift",
        "fixtures/McpObjectFixture.swift",
      ].map((name) => NodePath.join(source, name)),
    ]);
  });

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  const inspect = (commands) => {
    const input =
      commands
        .map(({ frame, replacement, ...command }) =>
          JSON.stringify({
            ...command,
            frame: encoded(frame),
            ...(replacement === undefined ? {} : { replacement: encoded(replacement) }),
          }),
        )
        .join("\n") + "\n";
    return NodeChildProcess.execFileSync(executable, [], { input, maxBuffer: 16 * 1024 * 1024 })
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };

  it("recognizes every routing key's escaped ASCII spelling and ignores unknown keys", () => {
    const escaped = (key) =>
      [...key].map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    const members = routingKeys.map((key) => `"${escaped(key)}":"${key}"`);
    const unknown = "x".repeat(200_000);
    members.push(`"${unknown}":{"id":7}`, String.raw`"\ud800":1`, '"ID":2', '"id\\n":3');
    const frame = "{" + members.join(",") + "}";
    const [reply] = inspect([{ frame, keys: [...routingKeys, unknown, "ID", "id\n"] }]);
    expect(decoded(reply.data)).toBe(frame);
    for (const key of routingKeys) {
      expect(reply.counts[key]).toBe(1);
      expect(reply.strings[key]).toBe(key);
    }
    for (const key of [unknown, "ID", "id\n"]) {
      expect(reply.counts[key]).toBe(0);
      expect(reply.spans[key]).toBeUndefined();
    }
    const spellings = routingKeys.flatMap((key) =>
      [...key].map((char, index) => ({
        key,
        frame: `{"${key.slice(0, index)}\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}${key.slice(index + 1)}":true}`,
        keys: [key],
      })),
    );
    inspect(spellings).forEach((result, index) => {
      const key = spellings[index].key;
      expect(result.counts[key]).toBe(1);
      expect(decoded(result.raw[key])).toBe("true");
    });
  });

  it("counts escaped duplicates with last-member semantics while isolating nested scopes", () => {
    const frame = String.raw`{"id":0,"unknown":1,"params":{"id":2,"id":3},"unknown":2,"\u0069d":1e400,"method":"tools/\u0063all"}`;
    const [root, nested] = inspect([
      {
        frame,
        keys: ["id", "params", "method", "unknown"],
        replaceKey: "id",
        replacement: '"owned"',
      },
      { frame, keys: ["id", "unknown"], path: ["params"] },
    ]);
    expect(root.counts).toEqual({ id: 2, params: 1, method: 1, unknown: 0 });
    expect(decoded(root.raw.id)).toBe("1e400");
    expect(root.strings.method).toBe("tools/call");
    expect(decoded(root.replaced)).toBe(frame.replace("1e400", '"owned"'));
    expect(nested.counts.id).toBe(2);
    expect(decoded(nested.raw.id)).toBe("3");
  });

  it("keeps opaque scalars and deep containers byte-identical when replacing a correlation ID", () => {
    const lexicals = [
      String.raw`"\ud800"`,
      String.raw`"\udc00"`,
      "-9E+999999",
      "9".repeat(2048),
      String.raw`{"text":"[,{}]\\\"","id":8}`,
      "[".repeat(12_000) + "0" + "]".repeat(12_000),
    ];
    const commands = lexicals.map((value) => ({
      frame: ` \t{ "id" : -0.00e+00, "unknown" : ${value}, "method":"한😀" }\r`,
      keys: ["id", "method"],
      replaceKey: "id",
      replacement: '"mapped"',
    }));
    const replies = inspect(commands);
    replies.forEach((reply, index) => {
      expect(decoded(reply.data)).toBe(commands[index].frame);
      expect(decoded(reply.raw.id)).toBe("-0.00e+00");
      expect(reply.strings.method).toBe("한😀");
      expect(decoded(reply.replaced)).toBe(commands[index].frame.replace("-0.00e+00", '"mapped"'));
    });
    const unknown = Array.from({ length: 4096 }, (_, index) => `"unknown${index}":{"id":1}`).join(
      ",",
    );
    const frame = `{${unknown},"message":"\\ud800","id":9}`;
    const [reply] = inspect([
      { frame, keys: ["message", "id", "unknown4095"], replaceKey: "id", replacement: "10" },
    ]);
    expect(reply.counts).toEqual({ message: 1, id: 1, unknown4095: 0 });
    expect(decoded(reply.raw.message)).toBe(String.raw`"\ud800"`);
    expect(reply.strings.message).toBeUndefined();
    expect(decoded(reply.replaced)).toBe(frame.slice(0, -2) + "10}");
  });

  it("borrows nested ranges with absolute UTF-8 spans and preserves the enclosing frame on replacement", () => {
    const frame = String.raw` {"message":"한😀","params" : {"arguments": {"session":"a\n\u0062","pid":77,"window_id":19}}} `;
    const [reply, absent] = inspect([
      {
        frame,
        prefix: 13,
        keys: ["session", "pid", "window_id"],
        path: ["params", "arguments"],
        replaceKey: "pid",
        replacement: "88",
      },
      { frame, keys: ["id"], replaceKey: "id", replacement: "1" },
    ]);
    expect(reply.start).toBe(13);
    expect(reply.strings.session).toBe("a\nb");
    const start = Buffer.from(frame).indexOf(Buffer.from("77")) + 13;
    expect(reply.spans.pid).toEqual([start, start + 2]);
    expect(decoded(reply.data)).toBe(frame);
    expect(decoded(reply.replaced)).toBe(frame.replace("77", "88"));
    expect(decoded(absent.replaced)).toBe(frame);
  });
});
