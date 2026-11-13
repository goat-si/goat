import "~/index.css";
import { FACE_MOTION_RANK, type GoatBotFaceState } from "@goat/client-runtime/goatBot";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { GoatBotAvatar } from "./GoatBotAvatar";

function movingEyes(place: string): number {
  const eyes = document.querySelector(`[data-face-place="${place}"] [data-face-eyes]`);
  return eyes?.getAnimations().filter((animation) => animation.playState === "running").length ?? 0;
}

function Faces(props: { readonly header: GoatBotFaceState; readonly list: GoatBotFaceState }) {
  return (
    <>
      <div data-face-place="header">
        <GoatBotAvatar
          state={props.header}
          motion={{ rank: FACE_MOTION_RANK.header, since: null }}
        />
      </div>
      <div data-face-place="list">
        <GoatBotAvatar state={props.list} motion={{ rank: FACE_MOTION_RANK.list, since: null }} />
      </div>
    </>
  );
}

it("moves only the chat header face when the header and the sidebar both show work, then hands over", async () => {
  // No routes: the faces read nothing from the router.
  await using screen = await render(<Faces header="working" list="working" />, { router: false });
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
  expect(movingEyes("list")).toBe(0);
  await screen.rerender(<Faces header="idle" list="working" />);
  await vi.waitFor(() => expect(movingEyes("list")).toBe(1));
  expect(movingEyes("header")).toBe(0);
});

it("stops the moving face when it unmounts", async () => {
  // No routes: the faces read nothing from the router.
  const screen = await render(<Faces header="reading" list="idle" />, { router: false });
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
  const eyes = document.querySelector("[data-face-place='header'] [data-face-eyes]");
  await screen[Symbol.asyncDispose]();
  expect(eyes?.getAnimations().length ?? 0).toBe(0);
});

it("stops while the tab is hidden and resumes when it shows again", async () => {
  let state: DocumentVisibilityState = "visible";
  using _visibility = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  // No routes: the faces read nothing from the router.
  await using _screen = await render(<Faces header="working" list="idle" />, { router: false });
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
  state = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(movingEyes("header")).toBe(0));
  state = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
});

it("holds still when the person turns on reduced motion", async () => {
  const query = new EventTarget() as EventTarget & { matches: boolean };
  query.matches = false;
  const original = window.matchMedia.bind(window);
  using _media = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((media: string) =>
      media.includes("prefers-reduced-motion")
        ? (query as unknown as MediaQueryList)
        : original(media),
    );
  // No routes: the faces read nothing from the router.
  await using _screen = await render(<Faces header="working" list="idle" />, { router: false });
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
  query.matches = true;
  query.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(movingEyes("header")).toBe(0));
});

it("keeps one running animation, never restarted, while the page re-renders around a moving face", async () => {
  // No routes: the faces read nothing from the router.
  await using screen = await render(<Faces header="working" list="idle" />, { router: false });
  await vi.waitFor(() => expect(movingEyes("header")).toBe(1));
  const eyes = document.querySelector("[data-face-place='header'] [data-face-eyes]");
  const first = eyes?.getAnimations()[0];
  for (let pass = 0; pass < 5; pass++)
    await screen.rerender(<Faces header="working" list="idle" />);
  expect(eyes?.getAnimations()).toEqual([first]);
  expect(first?.playState).toBe("running");
});
it("draws an emoji avatar in place of the face, keeps its state, and leaves the motion to a drawn face", async () => {
  // No routes: the faces read nothing from the router.
  await using screen = await render(
    <>
      <div data-face-place="header">
        <GoatBotAvatar
          state="working"
          emoji="🐙"
          motion={{ rank: FACE_MOTION_RANK.header, since: null }}
        />
      </div>
      <div data-face-place="list">
        <GoatBotAvatar state="working" motion={{ rank: FACE_MOTION_RANK.list, since: null }} />
      </div>
    </>,
    { router: false },
  );
  const header = screen.container.querySelector("[data-face-place='header'] [role='img']");
  expect(header?.getAttribute("aria-label")).toBe("Working");
  expect(header?.textContent).toBe("🐙");
  expect(header?.querySelector("[data-face]")).toBeNull();
  await vi.waitFor(() => expect(movingEyes("list")).toBe(1));
});

it("separates an accent from its status ring and outlines the waiting dot on the surface", async () => {
  const accent = { background: "#2F6FED", foreground: "#FFFFFF" } as const;
  // The avatars do not use a router. The popover surface they declare is drawn behind them.
  await using screen = await render(
    <div data-surface className="bg-popover p-2">
      <div data-avatar="accent">
        <GoatBotAvatar state="failed" emoji="R" accent={accent} surface="popover" />
      </div>
      <div data-avatar="neutral">
        <GoatBotAvatar state="failed" />
      </div>
      <div data-avatar="waiting">
        <GoatBotAvatar state="waiting" emoji="R" accent={accent} surface="popover" />
      </div>
    </div>,
    { router: false },
  );
  const surfaceElement = screen.container.querySelector<HTMLElement>("[data-surface]");
  const colored = screen.container.querySelector('[data-avatar="accent"] [role="img"]');
  const fill = colored?.querySelector<HTMLElement>("[data-goat-avatar-fill]");
  if (!surfaceElement || !(colored instanceof HTMLElement) || !fill)
    throw new Error("Expected the surface and the accent avatar");
  const surface = getComputedStyle(surfaceElement).backgroundColor;
  const ring = getComputedStyle(colored);
  expect(surface).not.toBe("rgba(0, 0, 0, 0)");
  // The ring: a 1 px border in the failed colour.
  expect(Number.parseFloat(ring.borderLeftWidth)).toBeCloseTo(1, 1);
  expect(ring.borderLeftColor).not.toBe(surface);
  // The gap: 1 px between the ring and the colour, showing the surface behind the avatar.
  const outer = colored.getBoundingClientRect();
  const inner = fill.getBoundingClientRect();
  expect(inner.left - outer.left - Number.parseFloat(ring.borderLeftWidth)).toBeCloseTo(1, 1);
  expect(outer.right - inner.right - Number.parseFloat(ring.borderRightWidth)).toBeCloseTo(1, 1);
  expect(ring.backgroundColor).toBe(surface);
  expect(getComputedStyle(fill).backgroundColor).toBe("rgb(47, 111, 237)");
  expect(
    screen.container.querySelector('[data-avatar="neutral"] [data-goat-avatar-fill]'),
  ).toBeNull();
  const dot = screen.container.querySelector<HTMLElement>(
    '[data-avatar="waiting"] [data-goat-waiting-dot]',
  );
  if (!dot) throw new Error("Expected the waiting dot");
  // The dot's ring is the surface behind the avatar.
  expect(Number.parseFloat(getComputedStyle(dot).borderTopWidth)).toBeGreaterThan(0);
  expect(getComputedStyle(dot).borderTopColor).toBe(surface);
});
