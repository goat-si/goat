import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPromptInput } from "@opencode/client";
import type { EngineInput } from "../src/protocol.ts";
import { buildOpenCode2Prompt } from "../src/engines/opencode2/attachments.ts";

type Attachment = EngineInput["attachments"][number];
const attachment = (id: string, type: Attachment["type"], mimeType: string, path: string | null): Attachment =>
  ({ id, type, mimeType, path, name: `${id}.dat`, sizeBytes: 1 });

for (const phase of ["start", "steer"] as const) {
  test(`${phase} builds text and native files at the fake prompt boundary`, async () => {
    const checked: string[] = [];
    const inputs: EngineInput[] = [
      { inputId: "one", text: "hello", attachments: [
        attachment("existing", "image", "IMAGE/PNG", "/saved/has space.png"),
        attachment("missing", "image", "image/jpeg", "/saved/missing.jpg"),
        attachment("null", "image", "image/gif", null),
        attachment("relative", "image", "image/png", "relative.png"),
        attachment("empty", "image", "image/png", ""),
        attachment("file-image", "file", "image/png", "/saved/file.png"),
        attachment("unsupported", "image", "image/svg+xml", "/saved/vector.svg"),
      ] },
      { inputId: "two", text: "second", attachments: [] },
    ];
    const prompt = await buildOpenCode2Prompt(inputs, phase === "start" ? "preamble" : null, {
      exists: async (path) => { checked.push(path); return path === "/saved/has space.png"; },
    });
    // This fake is the v2 client boundary for either operation, not a real provider.
    const send = (payload: Pick<SessionPromptInput, "text" | "files">) => payload;
    assert.deepEqual(send(prompt), {
      text: `${phase === "start" ? "preamble\n\n" : ""}hello\nsecond\n\n` + [
        '[Attached image "existing.dat" is saved at: /saved/has space.png]',
        '[Attached image "missing.dat" is saved at: /saved/missing.jpg]',
        `[Attached image "null.dat" is unavailable: could not resolve a saved path for attachment 'null'.]`,
        `[Attached image "relative.dat" is unavailable: could not resolve a saved path for attachment 'relative'.]`,
        `[Attached image "empty.dat" is unavailable: could not resolve a saved path for attachment 'empty'.]`,
        '[Attached file "file-image.dat" is saved at: /saved/file.png]',
        '[Attached image "unsupported.dat" is saved at: /saved/vector.svg]',
      ].join("\n\n"),
      files: [{ uri: "file:///saved/has%20space.png", name: "existing.dat" }],
    });
    assert.deepEqual(checked, ["/saved/has space.png", "/saved/missing.jpg"]);
  });
}

test("external server keeps notices without checking or sending local files", async () => {
  const checked: string[] = [];
  const prompt = await buildOpenCode2Prompt([{ inputId: "i", text: "", attachments: [
    attachment("remote", "image", "image/webp", "/saved/image.webp"),
  ] }], undefined, { external: true, exists: async (path) => { checked.push(path); return true; } });
  assert.deepEqual(prompt, {
    text: '[Attached image "remote.dat" is saved at: /saved/image.webp]',
    files: [],
  });
  assert.deepEqual(checked, []);
});

test("failed existence checks omit files and preserve text; all four supported MIME types work", async () => {
  const mimes = ["image/gif", "image/jpeg", "image/png", "image/webp"];
  const inputs: EngineInput[] = [{ inputId: "i", text: "  inspect  ", attachments: [
    ...mimes.map((mime, index) => attachment(`image${index}`, "image", mime, `/saved/${index}`)),
    attachment("error", "image", "image/png", "/saved/error"),
    attachment("whitespace", "image", " image/png ", "/saved/whitespace"),
  ] }];
  const checked: string[] = [];
  const prompt = await buildOpenCode2Prompt(inputs, undefined, { exists: async (path) => {
    checked.push(path);
    if (path === "/saved/error") throw new Error("I/O failure");
    return true;
  } });
  assert.deepEqual(prompt.files, mimes.map((_, index) => ({ uri: `file:///saved/${index}`, name: `image${index}.dat` })));
  assert.deepEqual(checked, ["/saved/0", "/saved/1", "/saved/2", "/saved/3", "/saved/error"]);
  assert.match(prompt.text, /\[Attached image "error.dat" is saved at: \/saved\/error\]/);
  assert.ok(prompt.text.startsWith("inspect  \n\n"));
});

test("empty inputs produce an empty prompt", async () => {
  assert.deepEqual(await buildOpenCode2Prompt([], null), { text: "", files: [] });
});
