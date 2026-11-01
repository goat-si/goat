#!/usr/bin/env node
// Live check for the Windows capture guard (#1329): an agent's screenshot or zoom of a covered
// window shows that window alone. It drives the built helper exactly as GOAT's lease proxy does
// ("GOAT Computer Use.exe mcp ..." over stdio) against the fixture window, with the fixture's
// magenta "cover" window on top.
//
//   node scripts/build-computer-use-helper-windows.ts --channel dev
//   node scripts/computer-use-windows-capture-guard-smoke.ts --out <dir>
//
// Run it on the signed-in desktop (not Session 0). It opens only its two fixture windows,
// closes them by the pids it started, exits non-zero when any expectation fails, and writes the
// screenshots the agent received, the screen under the window, and transcript.json to --out.
// @effect-diagnostics nodeBuiltinImport:off -- A standalone harness around child processes and files.
// @effect-diagnostics globalTimers:off -- Waits for windows the harness itself opened.
// @effect-diagnostics globalConsole:off -- Prints progress to the person running it by hand.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

const repo = NodePath.resolve(import.meta.dirname, "..");
const outIndex = process.argv.indexOf("--out");
const out = NodePath.resolve(
  outIndex > 0 ? (process.argv[outIndex + 1] ?? "") : "computer-use-capture-guard",
);
const helperExe = NodePath.join(
  repo,
  "apps/desktop/.computer-use-helper/computer-use-helper/GOAT Computer Use.exe",
);
const frameworkDir = NodePath.join(
  process.env.WINDIR ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
);
NodeFS.mkdirSync(out, { recursive: true });

const WITHHELD = "GOAT withheld this image";
const transcript: Array<{ readonly step: string; readonly detail: unknown }> = [];
const record = (step: string, detail: unknown) => {
  transcript.push({ step, detail });
  console.log(step, JSON.stringify(detail).slice(0, 300));
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string): never => {
  throw new Error(message);
};
const expectThat = (holds: boolean, message: string) => {
  if (!holds) fail(message);
};

/** One line-delimited JSON peer on a child's stdio; replies are matched by id. */
function lines(child: {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.Readable;
}) {
  const waiting = new Map<unknown, (message: Record<string, unknown>) => void>();
  let first: (message: Record<string, unknown>) => void = () => undefined;
  const greeting = new Promise<Record<string, unknown>>((resolve) => (first = resolve));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.id !== undefined && waiting.has(message.id))
      return waiting.get(message.id)?.(message);
    first(message);
  });
  const askRaw = (line: string, id: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(line + "\n");
    });
  const ask = (message: Record<string, unknown>) => askRaw(JSON.stringify(message), message.id);
  return { greeting, ask, askRaw };
}

interface ToolResult {
  readonly content: ReadonlyArray<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  readonly isError?: boolean;
}

/** Counts magenta pixels (the cover's colour, also when a system prompt dims the screen). */
const magentaPixels = (png: string) =>
  Number(
    NodeChildProcess.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Drawing; $b = [Drawing.Bitmap]::FromFile($env:GOAT_GUARD_PNG); $n = 0; " +
          "for ($y = 0; $y -lt $b.Height; $y += 2) { for ($x = 0; $x -lt $b.Width; $x += 2) { $p = $b.GetPixel($x, $y); " +
          "if ($p.R -gt 100 -and $p.B -gt 100 -and $p.G * 3 -lt $p.R -and [Math]::Abs($p.R - $p.B) -lt 30) { $n++ } } }; $b.Dispose(); $n",
      ],
      { env: { ...process.env, GOAT_GUARD_PNG: png } },
    )
      .toString()
      .trim(),
  );

/** What a screen copy of the window's rectangle shows: the pixels the driver's fallback reads. */
const screenUnder = (windowId: number, png: string) =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Drawing; Add-Type -Namespace W -Name U -MemberDefinition " +
        "'public struct R { public int L, T, Ri, B; } [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out R r);'; " +
        "$r = New-Object W.U+R; [void][W.U]::GetWindowRect([IntPtr][long]$env:GOAT_GUARD_HWND, [ref]$r); " +
        "$w = $r.Ri - $r.L; $h = $r.B - $r.T; $b = New-Object Drawing.Bitmap $w, $h; " +
        "$g = [Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object Drawing.Size $w, $h)); " +
        "$b.Save($env:GOAT_GUARD_PNG); $g.Dispose(); $b.Dispose()",
    ],
    { env: { ...process.env, GOAT_GUARD_HWND: String(windowId), GOAT_GUARD_PNG: png } },
  );

const opened: Array<NodeChildProcess.ChildProcess> = [];
const spawnOwned = (command: string, args: ReadonlyArray<string>) => {
  const child = NodeChildProcess.spawn(command, args, { stdio: "ignore" });
  opened.push(child);
  return child;
};

async function main() {
  const fixtureExe = NodePath.join(out, "computer-use-windows-fixture.exe");
  NodeChildProcess.execFileSync(NodePath.join(frameworkDir, "csc.exe"), [
    "/nologo",
    "/target:winexe",
    "/out:" + fixtureExe,
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    NodePath.join(repo, "scripts", "computer-use-windows-fixture.cs"),
  ]);

  // The desktop's side: the helper starts the driver daemon on a private pipe.
  const host = NodeChildProcess.spawn(helperExe, [], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const hostLines = lines(host);
  const hello = await hostLines.greeting;
  record("hello", hello);
  expectThat(hello.type === "hello", "The helper refused: " + JSON.stringify(hello));
  const pipe = "\\\\.\\pipe\\goat-cu-guard-" + process.pid;
  const started = await hostLines.ask({
    id: "1",
    method: "start",
    params: { socketPath: pipe, noOverlay: true },
  });
  record("start", started);
  expectThat(started.error === undefined, "start failed");

  // The agent's side: what the lease proxy spawns.
  const relay = NodeChildProcess.spawn(
    helperExe,
    ["mcp", "--embedded", "--socket", pipe, "--host-bundle-id", String(hello.bundleId)],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  const agent = lines(relay);
  let next = 0;
  const rpc = (method: string, params: object) =>
    agent.ask({ jsonrpc: "2.0", id: ++next, method, params });
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goat-guard-smoke", version: "1" },
  });
  relay.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tool = async (name: string, args: object) =>
    ((await rpc("tools/call", { name, arguments: args })).result ??
      fail(name + " returned no result")) as ToolResult;
  const texts = (result: ToolResult) =>
    result.content.flatMap((block) => (block.text ? [block.text] : []));
  const images = (result: ToolResult) => result.content.filter((block) => block.type === "image");
  const save = (result: ToolResult, name: string) => {
    const image = images(result)[0] ?? fail(name + ": no image");
    const path = NodePath.join(out, name);
    NodeFS.writeFileSync(path, Buffer.from(image.data ?? "", "base64"));
    return path;
  };

  try {
    const target = spawnOwned(fixtureExe, ["corner"]);
    await sleep(2000);
    const listed = await tool("list_windows", { pid: target.pid });
    const windows =
      (
        listed as unknown as {
          structuredContent?: { windows?: Array<{ window_id: number; title: string }> };
        }
      ).structuredContent?.windows ?? [];
    const window =
      windows.find((entry) => /GOAT computer use fixture/u.test(entry.title)) ??
      fail("No fixture window");
    const args = { pid: target.pid, window_id: window.window_id };

    // 1. Nothing on top: the screenshot is the window, at the driver's size.
    const clear = await tool("get_window_state", args);
    const clearPng = save(clear, "1-uncovered-agent.png");
    record("uncovered", {
      notes: texts(clear).filter((text) => text.startsWith("GOAT ")),
      magenta: magentaPixels(clearPng),
    });
    expectThat(
      !texts(clear).some((text) => text.startsWith(WITHHELD)),
      "The window's screenshot was withheld",
    );

    // 2. The magenta cover on top: the screen under the window shows it, the agent's image must not.
    spawnOwned(fixtureExe, ["cover"]);
    await sleep(1500);
    const screenPng = NodePath.join(out, "2-covered-screen-under-window.png");
    screenUnder(window.window_id, screenPng);
    const screenMagenta = magentaPixels(screenPng);
    const covered = await tool("get_window_state", args);
    const coveredPng = save(covered, "2-covered-agent.png");
    const agentMagenta = magentaPixels(coveredPng);
    record("covered", {
      notes: texts(covered).filter((text) => text.startsWith("GOAT ")),
      screenMagenta,
      agentMagenta,
    });
    expectThat(
      screenMagenta > 1000,
      "The cover is not over the fixture window; the check proves nothing",
    );
    expectThat(agentMagenta === 0, "The agent's screenshot shows the covering window");
    const size = (png: string) => {
      const bytes = NodeFS.readFileSync(png);
      return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    };
    expectThat(
      JSON.stringify(size(coveredPng)) === JSON.stringify(size(clearPng)),
      "The replacement changed the screenshot's size",
    );

    // 3. A zoom over the covered middle is cut from the helper's own capture.
    const zoom = await tool("zoom", { ...args, x1: 100, y1: 60, x2: 300, y2: 180 });
    const zoomPng = save(zoom, "3-covered-zoom-agent.png");
    const zoomMagenta = magentaPixels(zoomPng);
    record("zoom covered", {
      notes: texts(zoom).filter((text) => text.startsWith("GOAT ")),
      zoomMagenta,
    });
    expectThat(zoomMagenta === 0, "The agent's zoom shows the covering window");

    // 4. screenshot_out_file cannot route an image around the helper.
    const file = NodePath.join(out, "should-not-exist.png");
    const toFile = await tool("get_window_state", { ...args, screenshot_out_file: file });
    record("out file", { exists: NodeFS.existsSync(file), images: images(toFile).length });
    expectThat(
      !NodeFS.existsSync(file) && images(toFile).length === 1,
      "screenshot_out_file was not dropped",
    );

    // 5. Ids pass through exactly: one .NET's JSON reader would turn into a date still pairs its
    // reply, and the screenshot is still the helper's own.
    const dated = await agent.askRaw(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "@ID@",
        method: "tools/call",
        params: { name: "get_window_state", arguments: args },
      }).replace('"@ID@"', '"\\/Date(0)\\/"'),
      "/Date(0)/",
    );
    const datedResult = dated.result as ToolResult;
    const datedPng = save(datedResult, "5-dated-id-agent.png");
    record("dated id", {
      images: images(datedResult).length,
      notes: texts(datedResult).filter((text) => text.startsWith("GOAT ")),
      magenta: magentaPixels(datedPng),
    });
    expectThat(
      images(datedResult).length === 1 && magentaPixels(datedPng) === 0,
      "A date-like id lost its pairing or its screenshot shows the covering window",
    );

    // 6. A line the relay cannot read is refused, not forwarded.
    for (const line of ["not json", "[]"]) {
      const refused = await agent.askRaw(line, null);
      record("refused " + line, refused);
      expectThat(refused.error !== undefined, "The relay forwarded " + line);
    }
  } finally {
    relay.stdin.end();
    await new Promise((resolve) => relay.once("exit", resolve));
    await hostLines.ask({ id: "2", method: "stop", params: {} });
    host.stdin.end();
    await new Promise((resolve) => host.once("exit", resolve));
  }
}

try {
  await main();
  record("passed", true);
} catch (error) {
  record("failed", error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  for (const child of opened) child.kill();
  await sleep(500);
  record(
    "left running",
    opened
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => child.pid),
  );
  NodeFS.writeFileSync(NodePath.join(out, "transcript.json"), JSON.stringify(transcript, null, 1));
}
