import { describe, expect, it } from "vite-plus/test";
import { boundedRead, typedEffect } from "./typedEffect.ts";

describe("typed text effect", () => {
  const before = { value: "helo", start: 3, end: 3 };

  it("confirms text this input inserted that the field reads back as predicted", () => {
    expect(typedEffect(before, "l", { value: "hello", inserted: true })).toEqual({
      effect: "confirmed",
      evidence: ["value"],
    });
  });

  it("an earlier update that lands on the predicted value does not confirm a cancelled input", () => {
    expect(typedEffect(before, "l", { value: "hello", inserted: false })).toBeUndefined();
  });

  it("an unchanged, different or unread field, or empty text, is not confirmed", () => {
    expect(
      typedEffect({ value: "hello", start: 5, end: 5 }, "", { value: "hello", inserted: true }),
    ).toBeUndefined();
    expect(typedEffect(before, "l", { value: "HELLO", inserted: true })).toBeUndefined();
    expect(typedEffect(before, "l", undefined)).toBeUndefined();
    expect(typedEffect(undefined, "l", { value: "hello", inserted: true })).toBeUndefined();
  });

  it("a read the page never answers ends with no answer when its time is up", async () => {
    const stalled = new Promise<string>(() => undefined);
    await expect(boundedRead(stalled, Promise.resolve())).resolves.toBeUndefined();
    await expect(
      boundedRead(Promise.reject(new Error("closed")), new Promise(() => undefined)),
    ).resolves.toBeUndefined();
    await expect(boundedRead(Promise.resolve("ok"), new Promise(() => undefined))).resolves.toBe(
      "ok",
    );
  });
});
