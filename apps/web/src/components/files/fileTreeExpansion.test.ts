import { expect, it, vi } from "vite-plus/test";
import {
  readExpandedDirectories,
  subscribeOncePerTask,
  writeExpandedDirectories,
} from "./fileTreeExpansion";

it("coalesces updates and does not notify after unsubscribe", async () => {
  let emit = () => {};
  const unsubscribeModel = vi.fn();
  const listener = vi.fn();
  const unsubscribe = subscribeOncePerTask(
    {
      subscribe: (next) => {
        emit = next;
        return unsubscribeModel;
      },
    },
    listener,
  );
  emit();
  emit();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  emit();
  unsubscribe();
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(unsubscribeModel).toHaveBeenCalledOnce();
});

it("keeps the 100 expanded folders nearest the root, so a remount does not list hundreds", () => {
  const deep = Array.from({ length: 150 }, (_, index) => `pkg/mod/d${index}/`);
  writeExpandedDirectories("env:/repo", [...deep, "pkg/mod/", "pkg/"]);
  const restored = readExpandedDirectories("env:/repo");
  expect(restored).toEqual(["pkg/", "pkg/mod/", ...deep.slice(0, 98)]);
});
