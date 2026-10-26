export function isTerminalAgentCursor(point: unknown): boolean {
  return (
    typeof point === "object" &&
    point !== null &&
    "type" in point &&
    point.type === "cursor-state" &&
    "cursor" in point &&
    typeof point.cursor === "object" &&
    point.cursor !== null &&
    "phase" in point.cursor &&
    (point.cursor.phase === "hidden" || point.cursor.phase === "yielded")
  );
}

export function recordingKeyInput(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("key" in input) ||
    typeof input.key !== "string"
  )
    return undefined;
  return {
    key: input.key,
    metaKey: "metaKey" in input && input.metaKey === true,
    ctrlKey: "ctrlKey" in input && input.ctrlKey === true,
    altKey: "altKey" in input && input.altKey === true,
    shiftKey: "shiftKey" in input && input.shiftKey === true,
  };
}
