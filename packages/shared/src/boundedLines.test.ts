import * as NodeBuffer from "node:buffer";
import * as NodeStream from "node:stream";
import { expect, it } from "vite-plus/test";
import { BoundedLines } from "./boundedLines.ts";

it("refuses over-budget bytes before newline and preserves split UTF-8 and CRLF", () => {
  const input = new NodeStream.PassThrough();
  const reader = new BoundedLines(input, 4);
  const lines: string[] = [];
  let limited = false;
  reader.on("line", (line: string) => lines.push(line));
  reader.on("limit", () => {
    limited = true;
  });
  input.write(NodeBuffer.Buffer.from([0xe9]));
  input.write(NodeBuffer.Buffer.from([0x9b, 0xaa, 13, 10]));
  expect(lines).toEqual(["雪"]);
  input.write(NodeBuffer.Buffer.from("1234"));
  expect(limited).toBe(false);
  input.write(NodeBuffer.Buffer.from("5"));
  expect(limited).toBe(true);
  expect(lines).toEqual(["雪"]);
  expect(input.listenerCount("data")).toBe(0);
  input.end();
});

it("applies the byte budget per frame, including split CRLF at the exact limit", async () => {
  const input = new NodeStream.PassThrough();
  const reader = new BoundedLines(input, 3);
  const lines: string[] = [];
  reader.on("line", (line: string) => lines.push(line));
  reader.on("limit", () => {
    throw new Error("unexpected limit");
  });
  input.write(NodeBuffer.Buffer.from("123\r"));
  input.write(NodeBuffer.Buffer.from("\n雪\n\n12"));
  input.end();
  await new Promise<void>((resolve) => input.once("end", resolve));
  expect(lines).toEqual(["123", "雪", "", "12"]);
  expect(input.listenerCount("data")).toBe(0);
  expect(input.listenerCount("end")).toBe(0);
});

it("does not treat a nonterminal CR or Unicode separator as a frame boundary", () => {
  for (const parts of [
    ["123\r", "4"],
    ["a\u2028", "b"],
  ]) {
    const input = new NodeStream.PassThrough();
    const reader = new BoundedLines(input, 3);
    const lines: string[] = [];
    let limits = 0;
    reader.on("line", (line: string) => lines.push(line));
    reader.on("limit", () => {
      limits++;
    });
    for (const part of parts) input.write(NodeBuffer.Buffer.from(part));
    input.end();
    expect(limits).toBe(1);
    expect(lines).toEqual([]);
  }
});

it("closing from a line listener discards later frames and removes input listeners", () => {
  const input = new NodeStream.PassThrough();
  const reader = new BoundedLines(input, 3);
  const lines: string[] = [];
  reader.on("line", (line: string) => {
    lines.push(line);
    reader.close();
  });
  input.write(NodeBuffer.Buffer.from("one\ntwo\n"));
  reader.close();
  input.end();
  expect(lines).toEqual(["one"]);
  expect(input.listenerCount("data")).toBe(0);
  expect(input.listenerCount("end")).toBe(0);
});
