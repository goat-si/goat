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
  botArtifactPreview,
  botArtifactPreviewSlot,
  botArtifactViewKind,
  goatBotArtifactDays,
  goatBotReplyFiles,
  goatBotReplyMayNameFile,
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
    // A deep toEqual walks a megabyte element by element; comparing the bytes directly is enough.
    if (result.status === "ok") {
      expect(result.bytes.length).toBe(file.length);
      expect(result.bytes.findIndex((byte, index) => byte !== file[index])).toBe(-1);
    }
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
  // @effect-diagnostics-next-line globalDate:off - days follow the device's local calendar.
  const local = (day: number, hour: number) => new Date(2026, 10, day, hour);
  const at = (day: number, hour: number) => local(day, hour).toISOString();
  const file = (name: string, modifiedAt: string) => ({ relativePath: name, size: 1, modifiedAt });

  it("puts newest-first files under one heading per local day, keeping their order", () => {
    const now = local(11, 12).getTime();
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
        }).format(local(2, 0)),
        names: ["old.csv"],
      },
    ]);
  });

  it("keeps the same date in two years apart, keyed by the local calendar date", () => {
    const now = local(11, 12).getTime();
    // Nov 2 fell on a Monday in both years, so a label without the year reads the same.
    // @effect-diagnostics-next-line globalDate:off - days follow the device's local calendar.
    const earlier = new Date(2020, 10, 2, 8).toISOString();
    const days = goatBotArtifactDays([file("this.md", at(2, 8)), file("then.md", earlier)], now);
    expect(days.map((day) => [day.key, day.files.map((entry) => entry.relativePath)])).toEqual([
      ["2026-11-02", ["this.md"]],
      ["2020-11-02", ["then.md"]],
    ]);
    expect(days[1]?.label).toContain("2020");
    expect(days[0]?.label).not.toContain("2026");
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

  it("offers text too long to show as a download", () => {
    expect(botArtifactViewKind("text/markdown", "big.md", 2 * 1024 * 1024)).toBe("download");
    expect(botArtifactViewKind("image/png", "big.png", 2 * 1024 * 1024)).toBe("image");
  });
});

describe("files a reply names", () => {
  const files = [
    { relativePath: "reports/summary.md" },
    { relativePath: "chart.png" },
    { relativePath: "notes.txt" },
  ];

  it("finds Library files named in inline code, in order and once, by path or full path", () => {
    const text =
      "Saved `chart.png` and `/Users/me/.goat/userdata/goat-bot/artifacts/reports/summary.md`; see `chart.png` again. `summary.md` alone is ambiguous and `missing.csv` is not there.";
    expect(
      goatBotReplyFiles(text, files, "/Users/me/.goat/userdata/goat-bot/artifacts").map(
        (file) => file.relativePath,
      ),
    ).toEqual(["chart.png", "reports/summary.md"]);
  });

  const root = "/srv/goat/userdata/goat-bot/artifacts";
  const named = (code: string, listingRoot: string | undefined = root) =>
    goatBotReplyFiles(`Saved \`${code}\`.`, files, listingRoot).map((file) => file.relativePath);

  it("a full path names a file only inside this server's artifacts folder", () => {
    expect(named(`${root}/reports/summary.md`)).toEqual(["reports/summary.md"]);
    expect(named(`${root}//reports/./summary.md`)).toEqual(["reports/summary.md"]);
    expect(named("/other/artifacts/reports/summary.md")).toEqual([]);
    expect(named(`/elsewhere${root}/reports/summary.md`)).toEqual([]);
  });

  it("a full path with a '..' segment names nothing, since a link in the folder can lead outside it", () => {
    expect(named(`${root}/../../elsewhere/artifacts/reports/summary.md`)).toEqual([]);
    expect(named(`${root}/reports/../../artifacts2/chart.png`)).toEqual([]);
    // artifacts/link may point outside the folder, so link/../chart.png need not be artifacts/chart.png.
    expect(named(`${root}/link/../chart.png`)).toEqual([]);
    expect(named(`${root}/reports/../chart.png`)).toEqual([]);
  });

  it("a relative path names a file only when it is exactly a listed path", () => {
    expect(named("reports/summary.md")).toEqual(["reports/summary.md"]);
    expect(named("./reports/summary.md")).toEqual([]);
    expect(named("other/../reports/summary.md")).toEqual([]);
  });

  it("an older server's listing without its folder gives full paths no card", () => {
    const text = `Saved \`${root}/reports/summary.md\` and \`chart.png\`.`;
    expect(goatBotReplyFiles(text, files, undefined).map((file) => file.relativePath)).toEqual([
      "chart.png",
    ]);
  });

  it("a Windows server's folder matches with either separator", () => {
    const windowsRoot = "C:\\Users\\me\\.goat\\userdata\\goat-bot\\artifacts";
    expect(named(`${windowsRoot}\\reports\\summary.md`, windowsRoot)).toEqual([
      "reports/summary.md",
    ]);
    expect(named("C:/Users/me/.goat/userdata/goat-bot/artifacts/chart.png", windowsRoot)).toEqual([
      "chart.png",
    ]);
    expect(named("D:\\other\\artifacts\\chart.png", windowsRoot)).toEqual([]);
  });

  it("a Windows server's folder matches without regard to case, and a POSIX one exactly", () => {
    const windowsRoot = "C:\\Users\\me\\.goat\\userdata\\goat-bot\\artifacts";
    expect(named("c:/users/ME/.goat/userdata/goat-bot/artifacts/chart.png", windowsRoot)).toEqual([
      "chart.png",
    ]);
    expect(
      named("\\\\server\\share\\Artifacts\\chart.png", "\\\\Server\\Share\\artifacts"),
    ).toEqual(["chart.png"]);
    expect(named(`${root.toUpperCase()}/chart.png`)).toEqual([]);
  });

  it("reads the Library for any inline code the listing could hold, names without an extension too", () => {
    expect(goatBotReplyMayNameFile("Saved `README`.")).toBe(true);
    expect(goatBotReplyMayNameFile("Saved `docs/Makefile`.")).toBe(true);
    expect(goatBotReplyMayNameFile(`Saved \`${root}/LICENSE\`.`)).toBe(true);
    expect(goatBotReplyMayNameFile("Saved `reports/summary.md`.")).toBe(true);
  });

  it("skips the Library for inline code no listed file can match", () => {
    // The listing leaves out hidden names, colons, backslashes and folders.
    expect(goatBotReplyMayNameFile("Check `.env` and `.cache/x.txt`.")).toBe(false);
    expect(goatBotReplyMayNameFile("Run `a:b` in `src/` or `..`.")).toBe(false);
    expect(goatBotReplyMayNameFile("Open `reports\\summary.md`.")).toBe(false);
    expect(goatBotReplyMayNameFile("No code here: summary.md")).toBe(false);
  });
});

describe("botArtifactPreview", () => {
  const answer = (mimeType: string, bytes: Uint8Array, done = true, size = bytes.length) =>
    ({
      status: "chunk",
      relativePath: "f",
      mimeType,
      size,
      offset: 0,
      bytesBase64: Base64.encode(bytes),
      version: "v",
      done,
    }) as const;

  it("previews the start of text, a whole image, and nothing for other files", () => {
    const long = "# Title\n" + "x".repeat(5000);
    const text = botArtifactPreview(answer("text/markdown", new TextEncoder().encode(long)));
    expect(text?.kind).toBe("markdown");
    expect(text && "text" in text ? text.text.length : 0).toBe(1200);
    expect(botArtifactPreview(answer("image/png", new Uint8Array([1, 2])))?.kind).toBe("image");
    expect(botArtifactPreview(answer("image/png", new Uint8Array([1, 2]), false, 9e6))).toBeNull();
    expect(botArtifactPreview(answer("application/pdf", new Uint8Array([1])))).toBeNull();
    expect(botArtifactPreview({ status: "busy", relativePath: "f" })).toBeNull();
  });
});

describe("botArtifactPreviewSlot", () => {
  it("keeps room for a text preview or a one-chunk image, and none for other files", () => {
    expect(botArtifactPreviewSlot("reports/summary.md", 100)).toBe("text");
    expect(botArtifactPreviewSlot("chart.PNG", 1000)).toBe("image");
    expect(botArtifactPreviewSlot("huge.png", 5 * 1024 * 1024)).toBeNull();
    expect(botArtifactPreviewSlot("deck.pdf", 10)).toBeNull();
  });
});
