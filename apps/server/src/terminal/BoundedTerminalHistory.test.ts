import { it } from "@effect/vitest";
import { terminalSequenceEnd, terminalSequenceStateAfter } from "@goat/contracts";
import { expect } from "vite-plus/test";
import * as TerminalManager from "./Manager.ts";

function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  const kept = points.slice(start).join("");
  if (maxLines <= 0 || maxBytes <= 0) return kept;
  // A cut inside a control sequence drops the rest of that sequence too.
  const state = terminalSequenceStateAfter(0, text, 0, text.length - kept.length);
  return kept.slice(terminalSequenceEnd(state, kept));
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\u001b]0;",
    "\u001bP",
    "\u0007",
    "\u001b\\",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let full = "before\ninitial\n";
      let expected = retainedHistory(full, maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          full = "";
          expect(history.value()).toBe("");
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        full += chunk;
        expected = retainedHistory(full, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("does not retain the tail of a control sequence whose introducer was trimmed", () => {
  for (const [text, maxBytes, retained] of [
    ["prefix\u001b[31mOK", 6, "OK"],
    ["prefix\u001b]0;HIDDEN\u0007OK", 10, "OK"],
    ["prefix\u001b]0;🙂HIDDEN\u0007OK", 9, "OK"],
    // libghostty leaves every string but OSC at the emoji's second byte, so HELLO was visible.
    ["prefix\u001bP🙂HELLO\u001b\\OK", 9, "HELLO\u001b\\OK"],
  ] as const) {
    expect(new TerminalManager.BoundedTerminalHistory(5_000, text, maxBytes).value()).toBe(
      retained,
    );
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it("restores bounded history across append compaction, clears and split Unicode", () => {
  const maxBytes = 64;
  const history = new TerminalManager.BoundedTerminalHistory(3, "", maxBytes);
  let cursor: ReturnType<typeof history.persistenceUpdate>["cursor"] | undefined;
  let persisted = "";
  let compactions = 0;
  const flush = () => {
    const update = history.persistenceUpdate(cursor);
    if (!update.append) compactions += 1;
    const encoded = Buffer.from(update.data).toString();
    persisted = update.append ? persisted + encoded : encoded;
    cursor = update.cursor;
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(maxBytes * 2);
    expect(retainedHistory(persisted, 3, maxBytes)).toBe(Buffer.from(history.value()).toString());
  };
  for (let index = 0; index < 100; index += 1) {
    history.append(`line ${index} 名\n`);
    flush();
  }
  expect(compactions).toBeGreaterThan(1);
  expect(compactions).toBeLessThan(50);
  history.clear();
  flush();
  expect(persisted).toBe("");
  history.append("\ud83d");
  flush();
  history.append("\ude80");
  flush();
  expect(persisted).toBe("🚀");
  // More output than the retained window between flushes must replace the file.
  history.append("z".repeat(maxBytes * 3));
  flush();
  expect(persisted).toBe("z".repeat(maxBytes));
});
