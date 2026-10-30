import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const editorRoot = NodePath.join(mobileRoot, "src/features/notes/live-editor");
const outputRoot = NodePath.join(mobileRoot, ".generated", "note-editor");

/** Builds the note editor into one offline HTML asset that loads only when a note opens. */
export async function generateNoteEditor() {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2020",
      minify: true,
      lib: {
        entry: NodePath.join(editorRoot, "note-editor.browser.ts"),
        name: "GoatNoteEditor",
        formats: ["iife"],
      },
    },
  });
  const bundles = Array.isArray(result) ? result : [result];
  const outputs = bundles.flatMap((bundle) => ("output" in bundle ? bundle.output : []));
  const chunk = outputs.find((output) => output.type === "chunk");
  const css = outputs
    .flatMap((output) =>
      output.type === "asset" && output.fileName.endsWith(".css") ? [output.source] : [],
    )
    .map((source) => (typeof source === "string" ? source : Buffer.from(source).toString("utf8")))
    .join("");
  if (!chunk) throw new Error("The note editor build did not emit a script.");
  if (!css) throw new Error("The note editor build did not emit its styles.");
  const html = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">',
    // Note text is never script; images are the only network access.
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: http: data:\">",
    "<style>" + css + "</style>",
    '</head><body><div id="editor"></div>',
    "<script>" + chunk.code.replace(/<\/script/gi, "<\\/script") + "</script>",
    "</body></html>",
  ].join("");
  await NodeFSP.mkdir(outputRoot, { recursive: true });
  for (const [file, contents] of [
    ["note-editor.html", html],
    ["package.json", '{"name":"@goat/mobile-note-editor"}\n'],
  ] as const) {
    const destination = NodePath.join(outputRoot, file);
    const previous = await NodeFSP.readFile(destination, "utf8").catch(() => null);
    if (previous !== contents) await NodeFSP.writeFile(destination, contents);
  }
  return { bytes: Buffer.byteLength(html) };
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href)
  console.log(JSON.stringify(await generateNoteEditor()));
