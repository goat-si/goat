/**
 * Whether an agent call would move the person's hardware pointer. Foreground pointer delivery
 * warps the real pointer to its target, and a desktop move_cursor moves it outright; background
 * clicks (the virtual cursor), element tokens and keyboard input leave it where the person put it.
 * The host setting `cuaMovePointer` refuses the first kind with `pointer_locked`.
 *
 * @module ComputerUsePointerPolicy
 */

const POINTER_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "move_cursor",
]);
const BATCH_TOOLS = new Set(["run_steps"]);

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const isForeground = (args: Readonly<Record<string, unknown>> | undefined) =>
  typeof args?.delivery_mode === "string" && args.delivery_mode.toLowerCase() === "foreground";

export const movesPersonPointer = (
  call: { readonly name: string; readonly args?: unknown },
  depth = 0,
): boolean => {
  // A nesting this deep is not a real batch; refuse it rather than miss a pointer move in it.
  if (depth > 8) return true;
  const args = record(call.args);
  if (BATCH_TOOLS.has(call.name)) {
    const steps = Array.isArray(args?.steps) ? args.steps : [];
    return steps.some((step) => {
      const entry = record(step);
      const name = typeof entry?.tool === "string" ? entry.tool : "";
      return movesPersonPointer({ name, args: entry?.args }, depth + 1);
    });
  }
  if (!POINTER_TOOLS.has(call.name)) return false;
  if (call.name === "move_cursor" && args?.scope === "desktop") return true;
  return isForeground(args);
};
