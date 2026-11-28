import { expect, it } from "vite-plus/test";
import { createThreadRetention } from "./threadRetention.ts";

it("evicts the least recently inactive snapshot and protects active threads", () => {
  const retention = createThreadRetention(2);
  const evicted: string[] = [];
  const activate = (key: string) => retention.activate(key, () => evicted.push(key));
  const a = activate("a");
  const b = activate("b");
  a();
  b();
  const aAgain = activate("a");
  const c = activate("c");
  c();
  const d = activate("d");
  d();
  expect(evicted).toEqual(["b"]);
  aAgain();
  expect(evicted).toEqual(["b", "c"]);
});
