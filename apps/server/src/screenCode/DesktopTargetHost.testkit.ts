// Reads shaped as cua-driver-rs-v0.38.0-goat.2 returns them (core window_state_view.rs apply,
// macOS get_window_state.rs): tokens are <snapshot_id>:N, elements_complete is always false.
const goat2Element = (snapshot: string, index: number, role: string, label: string) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `${snapshot}:${index}`,
  label,
});
const goat2Full = (snapshot: string) => ({
  window_id: 7,
  pid: 42,
  element_count: 2,
  returned_element_count: 2,
  elements_complete: false,
  snapshot_id: snapshot,
  tree_markdown: '- [0] AXWindow "Document"\n  - [1] AXButton "Apply" [actions=[press]]',
  elements: [
    goat2Element(snapshot, 0, "AXWindow", "Document"),
    goat2Element(snapshot, 1, "AXButton", "Apply"),
  ],
});
/** goat.2 keeps only the requested tree representation; markdown is its default. */
const goat2Read = (read: ReturnType<typeof goat2Full>, args: Record<string, unknown>) => {
  const format = typeof args.tree_format === "string" ? args.tree_format : "markdown";
  const { elements, tree_markdown, ...rest } = read;
  return {
    ...rest,
    tree_format: format,
    ...(format === "markdown" ? {} : { elements }),
    ...(format === "elements" ? {} : { tree_markdown }),
  };
};
export const goat2Diff = {
  window_id: 7,
  pid: 42,
  elements_complete: false,
  snapshot_id: "s0000000b",
  since: "s0000000a",
  since_status: "diff",
  tree_diff:
    'since s0000000a: 1 added, 0 changed, 0 removed. Use element_tokens s0000000b:N for + and ~ rows and unchanged rows; - ids are from s0000000a.\n+ [2] AXButton "Save" [actions=[press]]',
  diff_counts: { added: 1, changed: 0, removed: 0 },
  elements: [goat2Element("s0000000b", 2, "AXButton", "Save")],
  tree_format: "both",
};
export const goat2NoChange = {
  window_id: 7,
  pid: 42,
  elements_complete: false,
  snapshot_id: "s0000000d",
  since: "s0000000b",
  since_status: "no_change",
  tree_diff:
    "no change since s0000000b. Rows and indices are as before; use snapshot_id s0000000d in element_tokens (s0000000d:N).",
  diff_counts: { added: 0, changed: 0, removed: 0 },
  elements: [],
  tree_format: "both",
};
export const goat2WindowState = (
  args: Record<string, unknown>,
  screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" },
) =>
  args.include_accessibility_tree === false
    ? {
        window_id: 7,
        pid: 42,
        elements_complete: false,
        tree_markdown: "",
        tree_format: "markdown",
        screenshot_width: 100,
        screenshot_height: 80,
        screenshot_mime_type: "image/png",
        window_bounds: { x: 10, y: 20, width: 50, height: 40 },
        screenshot_scale: 2,
        image: {
          mimeType: "image/png",
          bytes: Buffer.from("png").toString("base64"),
          width: 100,
          height: 80,
        },
        ...screenshot,
      }
    : args.since === "s0000000a"
      ? goat2Diff
      : args.since === "s0000000b"
        ? goat2NoChange
        : args.since !== undefined
          ? {
              ...goat2Read(goat2Full("s0000000c"), args),
              since: args.since,
              since_status: "unknown_snapshot",
            }
          : goat2Read(goat2Full("s0000000a"), args);
