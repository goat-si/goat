import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { extractDocumentText } from "./documentTextWorker.ts";

function docx(xml: string) {
  const data = Buffer.from(xml);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(NodeZlib.crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(NodeZlib.crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

it.effect.each([
  {
    xml: "<w:document><w:body><w:p><w:r><w:t>Total cost is </w:t><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><w:t>42 EUR.</w:t></w:r></w:p></w:body></w:document>",
    expected: "Total cost is 42 EUR.",
    absent: ["1905000", "-635"],
  },
  {
    xml: "<w:document><w:body><w:p><mc:AlternateContent><mc:Choice><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>",
    expected: "Chart caption",
    absent: ["1905000"],
  },
  {
    xml: "<w:document><w:body><w:p><w:r><w:t>As shown </w:t><w:fldChar><w:fldData>RU5ETk9URQ==</w:fldData></w:fldChar><w:t>(Smith 2020) earlier.</w:t></w:r></w:p></w:body></w:document>",
    expected: "As shown (Smith 2020) earlier.",
    absent: ["RU5ETk9URQ=="],
  },
])("extracts visible DOCX text without drawing or field metadata", ({ xml, expected, absent }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-docx-drawing-" });
    const file = path.join(directory, "fixture.docx");
    yield* fs.writeFile(file, docx(xml));
    const text = yield* Effect.promise(() => extractDocumentText(file, ".docx"));
    expect(text).toContain(expected);
    for (const hidden of absent) expect(text).not.toContain(hidden);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
