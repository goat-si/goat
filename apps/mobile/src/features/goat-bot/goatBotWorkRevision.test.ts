import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";

import { goatBotWorkRevision } from "./goatBotWorkRevision";

// Only the fields the revision reads; the rest of a projected item does not matter here.
const projected = (sourceItemId: string, item: object) =>
  ({ sourceItemId, item }) as unknown as OrchestrationV2ProjectedTurnItem;
const chip = (id: string, taskVersion: number) =>
  projected(id, { type: "notification", ledgerTask: { taskId: "task-1", taskVersion } });
const answer = (id: string, text: string, streaming: boolean) =>
  projected(id, { type: "assistant_message", text, streaming, channel: { kind: "reply" } });

describe("goatBotWorkRevision", () => {
  it("changes when a task chip moves on, even one no card shows", () => {
    expect(goatBotWorkRevision([chip("a", 1)])).not.toBe(goatBotWorkRevision([chip("a", 2)]));
  });

  it("ignores a streaming answer's growing text and changes once it finishes", () => {
    const base = [chip("a", 1)];
    const streaming = goatBotWorkRevision([...base, answer("r", "Look", true)]);
    expect(goatBotWorkRevision([...base, answer("r", "Looking at it", true)])).toBe(streaming);
    expect(goatBotWorkRevision([...base, answer("r", "Looking at it.", false)])).not.toBe(
      streaming,
    );
  });

  it("counts the person's channel messages and nothing outside the channel", () => {
    const sent = projected("u", { type: "user_message", channel: { kind: "input" } });
    const local = projected("x", { type: "assistant_message", streaming: false });
    expect(goatBotWorkRevision([sent])).toBe("u");
    expect(goatBotWorkRevision([local])).toBe("");
  });
});
