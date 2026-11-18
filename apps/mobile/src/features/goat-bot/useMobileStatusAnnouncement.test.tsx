import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const spoken = vi.hoisted(() => [] as string[]);
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: (text: string) => spoken.push(text) },
}));

import { useMobileStatusAnnouncement } from "./useMobileStatusAnnouncement";

function Status(props: { text: string | null; onMount?: boolean }) {
  useMobileStatusAnnouncement(
    props.text,
    props.onMount === undefined ? undefined : { onMount: props.onMount },
  );
  return null;
}
async function mount(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(element));
  return {
    render: (next: React.ReactElement) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

it("only a view that asks speaks a status already showing when it mounts", async () => {
  spoken.length = 0;
  // A list entry, such as Home's task search, scrolled away and back with the same line.
  const first = await mount(<Status text={null} />);
  await first.render(<Status text="No matching tasks" />);
  await first.unmount();
  const again = await mount(<Status text="No matching tasks" />);
  await again.unmount();
  expect(spoken).toEqual(["No matching tasks"]);
  // The task screen asks: a line already there when it opens is spoken once.
  const screen = await mount(<Status text="You can't see this task" onMount />);
  await screen.render(<Status text="You can't see this task" onMount />);
  await screen.unmount();
  expect(spoken).toEqual(["No matching tasks", "You can't see this task"]);
});
