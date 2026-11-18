import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";
import { TimelineMinimap } from "./TimelineMinimap";

it("keeps the message underneath a minimap preview clickable", async () => {
  const clicked = vi.fn();
  await using screen = await render(
    <div style={{ position: "relative", height: 400, width: 500 }}>
      <button style={{ position: "absolute", inset: 0, width: 500, height: 400 }} onClick={clicked}>
        Underlying message
      </button>
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={40}
        currentIndex={0}
        atEnd={false}
        items={[
          { id: "one", rowIndex: 0, userText: "First", assistantText: null },
          { id: "two", rowIndex: 1, userText: "Second", assistantText: null },
        ]}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={() => {}}
      />
    </div>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "Jump to message: User message" }));
  const button = screen.getByRole("button", { name: "Underlying message" }).element();
  const preview = screen.container.querySelector("[data-minimap-preview]");
  expect(preview).not.toBeNull();
  const bounds = preview!.getBoundingClientRect();
  const target = document.elementFromPoint(
    bounds.left + bounds.width / 2,
    bounds.top + bounds.height / 2,
  );
  expect(target).toBe(button);
  (target as HTMLElement).click();
  expect(clicked).toHaveBeenCalledOnce();
});

it("names the focused minimap turn from the text shown in its preview", async () => {
  const onSelect = vi.fn();
  const first = {
    id: "one",
    rowIndex: 0,
    userText: "Compare **both** with [README.md](goat-context://v1/file/readme).",
    assistantText: "Reviewed [math.ts](src/math.ts).",
  };
  await using screen = await render(
    <div style={{ position: "relative", height: 400, width: 500 }}>
      <TimelineMinimap
        hasPersistentGutter
        hitStripWidth={40}
        currentIndex={0}
        atEnd={false}
        items={[first, { id: "two", rowIndex: 1, userText: "Second", assistantText: null }]}
        stripMap={new Map()}
        onWheel={() => {}}
        onSelect={onSelect}
      />
    </div>,
  );
  const rail = screen.getByRole("button", { name: "Jump to message: User message" }).element();
  (rail as HTMLElement).focus();
  const focusedTurn = screen.getByRole("button", {
    name: "Jump to message: Compare both with README.md.",
  });
  await expect.element(focusedTurn).toHaveFocus();
  await expect.element(screen.getByText("Reviewed math.ts.")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: first.id }));
});

it("keeps a literal Reply label and literal prose in the focused jump name", async () => {
  await using screen = await render(
    <TimelineMinimap
      hasPersistentGutter
      hitStripWidth={40}
      currentIndex={0}
      atEnd={false}
      items={[
        {
          id: "one",
          rowIndex: 0,
          userText: "[---](goat-context://v1/response/earlier)\nKeep <literal> and ~local~.",
          assistantText: null,
        },
        { id: "two", rowIndex: 1, userText: "Second", assistantText: null },
      ]}
      stripMap={new Map()}
      onWheel={() => {}}
      onSelect={() => {}}
    />,
  );
  const rail = screen.getByRole("button", { name: "Jump to message: User message" }).element();
  (rail as HTMLElement).focus();
  await expect
    .element(
      screen.getByRole("button", { name: "Jump to message: --- Keep <literal> and ~local~." }),
    )
    .toHaveFocus();
});
