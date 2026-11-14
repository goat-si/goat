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

it("a list entry remounted with a status already showing does not speak it again", async () => {
  spoken.length = 0;
  const first = await mount(<Status text={null} />);
  await first.render(<Status text="No matching tasks" />);
  await first.unmount();
  // Scrolled away and back: the entry mounts again with the same line.
  const again = await mount(<Status text="No matching tasks" />);
  await again.unmount();
  expect(spoken).toEqual(["No matching tasks"]);
});

it("a screen that asks speaks a status already showing when it opens, once", async () => {
  spoken.length = 0;
  const screen = await mount(<Status text="You can't see this task" onMount />);
  await screen.render(<Status text="You can't see this task" onMount />);
  await screen.unmount();
  expect(spoken).toEqual(["You can't see this task"]);
});
