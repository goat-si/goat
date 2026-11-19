import { expect, it, vi } from "vite-plus/test";
import { subscribeOncePerTask } from "./fileTreeExpansion";

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
