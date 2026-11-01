import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Text: ({ style, children }: { style?: unknown; children?: ReactNode }) => (
    <span data-style={JSON.stringify(style)}>{children}</span>
  ),
}));

import { GoatBotDayStamp } from "./GoatBotDayStamp";

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

it("keeps the lead and time on one line with separate weights", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const nowMs = new Date(2026, 9, 19, 12).getTime();
  const at = new Date(2026, 9, 19, 9, 40).toISOString();
  await act(async () =>
    root.render(<GoatBotDayStamp at={at} nowMs={nowMs} formatTime={() => "9:40 AM"} />),
  );

  const line = container.firstElementChild;
  expect(line?.textContent).toBe("Today 9:40 AM");
  expect(line?.children).toHaveLength(2);
  expect(line?.children[0]?.textContent).toBe("Today");
  expect(line?.children[0]?.getAttribute("data-style")).toBe('{"fontWeight":"600"}');
  expect(line?.children[1]?.textContent).toBe("9:40 AM");
  expect(line?.children[1]?.getAttribute("data-style")).toBe('{"fontWeight":"400"}');
});
