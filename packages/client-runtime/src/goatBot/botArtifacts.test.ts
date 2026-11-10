import { describe, expect, it, vi } from "vite-plus/test";
import {
  CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
  CHANNEL_BOT_ARTIFACT_MAX_BYTES,
  ChannelGatewayError,
  EnvironmentAuthorizationError,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
  type ChannelTaskStatus,
} from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";

vi.mock("effect/encoding/Base64", async (original) => {
  const real = await original<typeof import("effect/encoding/Base64")>();
  return { ...real, decode: vi.fn(real.decode) };
});
import {
  botArtifactName,
  botArtifactOpenMessage,
  botArtifactSizeLabel,
  botArtifactsFailure,
  botComputers,
  botArtifactViewKind,
  goatBotArtifactDays,
  readWholeBotArtifact,
} from "./botArtifacts.ts";

const path = "reports/summary.txt";
const chunk = (
  offset: number,
  bytes: Uint8Array,
  options: { size: number; version?: string; done?: boolean },
): ChannelReadBotArtifactResult => ({
  status: "chunk",
  relativePath: path,
  mimeType: "text/plain",
  size: options.size,
  offset,
  bytesBase64: Base64.encode(bytes),
  version: options.version ?? "v1",
  done: options.done ?? offset + bytes.length === options.size,
});
/** A server for one file, answering chunks the way the contract does. */
function fileServer(file: Uint8Array, version = () => "v1") {
  const calls: ChannelReadBotArtifactInput[] = [];
  const read = async (input: ChannelReadBotArtifactInput) => {
    calls.push(input);
    const offset = input.offset ?? 0;
    const current = version();
    if (offset > 0 && input.version !== current)
      return { status: "changed", relativePath: path } as const;
    const bytes = file.subarray(offset, offset + CHANNEL_BOT_ARTIFACT_CHUNK_BYTES);
    return chunk(offset, bytes, { size: file.length, version: current });
  };
  return { read, calls };
}

describe("readWholeBotArtifact", () => {
  it("reads chunks one after another, passing the first chunk's version", async () => {
    const file = new Uint8Array(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const server = fileServer(file);
    const result = await readWholeBotArtifact(path, server.read);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.bytes).toEqual(file);
    expect(server.calls).toEqual([
      { relativePath: path },
      { relativePath: path, offset: CHANNEL_BOT_ARTIFACT_CHUNK_BYTES, version: "v1" },
      { relativePath: path, offset: CHANNEL_BOT_ARTIFACT_CHUNK_BYTES * 2, version: "v1" },
    ]);
  });

  it("reads an empty file as one finished chunk", async () => {
    const result = await readWholeBotArtifact(path, fileServer(new Uint8Array()).read);
    expect(result).toMatchObject({ status: "ok", size: 0 });
  });

  it("reads a file of exactly the cap", async () => {
    const file = new Uint8Array(CHANNEL_BOT_ARTIFACT_MAX_BYTES);
    const server = fileServer(file);
    const result = await readWholeBotArtifact(path, server.read);
    expect(result.status).toBe("ok");
    expect(server.calls).toHaveLength(
      CHANNEL_BOT_ARTIFACT_MAX_BYTES / CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
    );
  });

  it("starts over once when the file changes during the read", async () => {
    const file = new Uint8Array(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES + 1);
    let reads = 0;
    const server = fileServer(file, () => (++reads <= 1 ? "v1" : "v2"));
    const result = await readWholeBotArtifact(path, server.read);
    expect(result.status).toBe("ok");
    expect(server.calls.map((call) => call.offset ?? 0)).toEqual([
      0,
      CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
      0,
      CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
    ]);
  });

  it("gives up when the file changes twice", async () => {
    const file = new Uint8Array(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES + 1);
    let reads = 0;
    const server = fileServer(file, () => `v${++reads}`);
    expect(await readWholeBotArtifact(path, server.read)).toEqual({ status: "changed" });
    expect(server.calls).toHaveLength(4);
  });

  it("passes too_large and busy through", async () => {
    expect(
      await readWholeBotArtifact(path, async () => ({
        status: "too_large",
        relativePath: path,
        size: 30_000_000,
        maxBytes: CHANNEL_BOT_ARTIFACT_MAX_BYTES,
      })),
    ).toEqual({ status: "too_large", size: 30_000_000, maxBytes: CHANNEL_BOT_ARTIFACT_MAX_BYTES });
    expect(
      await readWholeBotArtifact(path, async () => ({ status: "busy", relativePath: path })),
    ).toEqual({ status: "busy" });
  });

  it.each([
    {
      name: "a first size above the cap",
      answers: [
        chunk(0, new Uint8Array(1), { size: CHANNEL_BOT_ARTIFACT_MAX_BYTES + 1, done: false }),
      ],
    },
    {
      name: "a chunk longer than a chunk may be",
      answers: [
        chunk(0, new Uint8Array(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES + 1), {
          size: CHANNEL_BOT_ARTIFACT_CHUNK_BYTES + 1,
        }),
      ],
    },
    {
      name: "an empty chunk that is not the last",
      answers: [chunk(0, new Uint8Array(), { size: 10, done: false })],
    },
    {
      name: "done before the end",
      answers: [chunk(0, new Uint8Array(4), { size: 10, done: true })],
    },
    {
      name: "done missing on the last chunk",
      answers: [chunk(0, new Uint8Array(10), { size: 10, done: false })],
    },
  ])("refuses $name without asking again", async ({ answers }) => {
    const read = vi.fn(async () => answers.shift()!);
    expect(await readWholeBotArtifact(path, read)).toEqual({ status: "invalid" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "too long to be one chunk",
      text: "A".repeat(4 * Math.ceil(CHANNEL_BOT_ARTIFACT_CHUNK_BYTES / 3) + 4),
    },
    { name: "not base64", text: "ab!=" },
    { name: "a length that is not a multiple of four", text: "abc" },
  ])("refuses a chunk whose base64 is $name before decoding it", async ({ text }) => {
    const decode = vi.mocked(Base64.decode);
    decode.mockClear();
    const read = vi.fn(async () => ({
      status: "chunk" as const,
      relativePath: path,
      mimeType: "text/plain",
      size: 10,
      offset: 0,
      bytesBase64: text,
      version: "v1",
      done: false,
    }));
    expect(await readWholeBotArtifact(path, read)).toEqual({ status: "invalid" });
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("Library copy", () => {
  it("names the file and its size", () => {
    expect(botArtifactName("reports/2026/summary.txt")).toBe("summary.txt");
    expect(botArtifactSizeLabel(512)).toBe("512 B");
    expect(botArtifactSizeLabel(1536)).toBe("1.5 KB");
    expect(botArtifactSizeLabel(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("says why a file did not open", () => {
    expect(
      botArtifactOpenMessage("big.zip", { status: "too_large", size: 1, maxBytes: 1 }, "Goaty"),
    ).toBe("big.zip is larger than 20 MB, so Goaty can't send it here.");
    expect(botArtifactOpenMessage("a.txt", { status: "busy" })).toBe(
      "Another file is still opening. Try again in a moment.",
    );
    expect(botArtifactOpenMessage("a.txt", { status: "changed" })).toBe(
      "a.txt changed while it was opening. Try again.",
    );
    expect(botArtifactOpenMessage("a.txt", { status: "invalid" })).toBe(
      "Couldn't open a.txt. Try again.",
    );
  });

  it("says why the list cannot load and whether trying again helps", () => {
    expect(
      botArtifactsFailure(
        new EnvironmentAuthorizationError({ message: "no", requiredScope: "filesystem:read" }),
        "Goaty",
      ),
    ).toEqual({ message: "This device can't read Goaty's files.", retry: false });
    expect(botArtifactsFailure(new ChannelGatewayError({ reason: "not_home" }), "Goaty")).toEqual({
      message: "Goaty's files are on its home computer.",
      retry: false,
    });
    expect(botArtifactsFailure(new Error("x"), "Goaty")).toEqual({
      message: "Couldn't load Goaty's files.",
      retry: true,
    });
  });
});

const task = (
  taskId: string,
  status: ChannelTaskStatus,
  options: { host?: string; worker?: { host?: string }; updatedAt?: string } = {},
) => ({
  taskId,
  title: `Task ${taskId}`,
  status,
  updatedAt: options.updatedAt ?? "2026-11-07T10:00:00.000Z",
  ...(options.host === undefined ? {} : { host: options.host }),
  ...(options.worker === undefined ? {} : { worker: options.worker }),
});

describe("botComputers", () => {
  it("groups running work by machine, GOAT Bot's own first, and drops finished work", () => {
    const groups = botComputers([
      task("a", "running", { worker: { host: "studio" } }),
      task("b", "running", { worker: {} }),
      task("c", "completed", { worker: { host: "laptop" } }),
      task("d", "waiting_input", { worker: { host: "build-box" } }),
      task("e", "received", { host: "studio", updatedAt: "2026-11-07T11:00:00.000Z" }),
    ]);
    expect(groups.map((group) => [group.host, group.tasks.map((item) => item.taskId)])).toEqual([
      [null, ["b"]],
      ["build-box", ["d"]],
      ["studio", ["e", "a"]],
    ]);
  });

  it("a worker on GOAT Bot's own machine wins over an older requested host", () => {
    expect(
      botComputers([task("a", "running", { host: "studio", worker: {} })])[0]?.host,
    ).toBeNull();
  });
});

describe("goatBotArtifactDays", () => {
  // Local times, since days follow the device's calendar.
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();
  const file = (name: string, modifiedAt: string) => ({ relativePath: name, size: 1, modifiedAt });

  it("puts newest-first files under one heading per local day, keeping their order", () => {
    const now = new Date(2026, 10, 11, 12).getTime();
    const files = [
      file("late.md", at(11, 9)),
      file("early.md", at(11, 0)),
      file("night.png", at(10, 23)),
      file("old.csv", at(2, 8)),
    ];
    expect(
      goatBotArtifactDays(files, now).map((day) => ({
        label: day.label,
        names: day.files.map((entry) => entry.relativePath),
      })),
    ).toEqual([
      { label: "Today", names: ["late.md", "early.md"] },
      { label: "Yesterday", names: ["night.png"] },
      {
        label: new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(new Date(2026, 10, 2)),
        names: ["old.csv"],
      },
    ]);
  });
});

describe("botArtifactViewKind", () => {
  it("renders markdown by type or name, shows text and images, and downloads the rest", () => {
    expect(botArtifactViewKind("text/markdown; charset=utf-8", "notes")).toBe("markdown");
    expect(botArtifactViewKind("application/octet-stream", "reports/summary.MD")).toBe("markdown");
    expect(botArtifactViewKind("text/plain", "log.txt")).toBe("text");
    expect(botArtifactViewKind("application/json", "data.json")).toBe("text");
    expect(botArtifactViewKind("image/png", "chart.png")).toBe("image");
    expect(botArtifactViewKind("application/pdf", "report.pdf")).toBe("download");
  });
});
