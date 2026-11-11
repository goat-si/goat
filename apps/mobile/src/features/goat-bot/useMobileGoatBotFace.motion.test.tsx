import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FACE_MOTION_RANK, type GoatBotFaceState } from "@goat/client-runtime/goatBot";
import { describe, expect, it, vi } from "vite-plus/test";

const env = vi.hoisted(() => ({ active: true, reduced: false, focused: true }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => env.active,
  useReduceMotionEnabled: () => env.reduced,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => env.focused }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/use-thread-detail", () => ({ useThreadVisibleTurnItems: () => [] }));
vi.mock("./useMobileGoatBotHomeMode", () => ({
  useMobileGoatBotHomeMode: () => ({ botRef: null }),
}));

import { useMobileGoatBotFaceMotion } from "./useMobileGoatBotFace";

interface FaceProps {
  readonly name: string;
  readonly state: GoatBotFaceState;
  readonly rank: number;
  readonly onScreen?: boolean;
}

async function renderFaces() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const moving = new Map<string, boolean>();
  function Face(props: FaceProps) {
    moving.set(
      props.name,
      useMobileGoatBotFaceMotion(props.state, props.rank, null, props.onScreen ?? true) !== null,
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const show = (faces: ReadonlyArray<FaceProps>) =>
    act(async () => {
      // Only faces still mounted report; an unmounted one must not keep its last answer.
      moving.clear();
      root.render(
        <StrictMode>
          {faces.map((face) => (
            <Face key={face.name} {...face} />
          ))}
        </StrictMode>,
      );
    });
  const movers = () => [...moving].filter(([, turn]) => turn).map(([name]) => name);
  return { show, movers, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

const header = { name: "header", rank: FACE_MOTION_RANK.header } as const;
const roster = { name: "roster", rank: FACE_MOTION_RANK.list } as const;
// The chat's progress line ranks above its header (GoatBotProgressFace).
const progress = { name: "progress", rank: FACE_MOTION_RANK.header + 1 } as const;

describe("useMobileGoatBotFaceMotion", () => {
  it("moves only the chat header when the header and the roster both show work, then hands over", async () => {
    await using faces = await renderFaces();
    await faces.show([
      { ...roster, state: "working" },
      { ...header, state: "working" },
    ]);
    expect(faces.movers()).toEqual(["header"]);
    await faces.show([
      { ...roster, state: "working" },
      { ...header, state: "finished" },
    ]);
    expect(faces.movers()).toEqual(["roster"]);
  });

  it("gives the progress line's face the motion over the header, and hands it back when the line leaves", async () => {
    await using faces = await renderFaces();
    await faces.show([
      { ...header, state: "working" },
      { ...progress, state: "working" },
    ]);
    expect(faces.movers()).toEqual(["progress"]);
    // Scrolled out of view: the line releases its claim.
    await faces.show([
      { ...header, state: "working" },
      { ...progress, state: "working", onScreen: false },
    ]);
    expect(faces.movers()).toEqual(["header"]);
    await faces.show([
      { ...header, state: "working" },
      { ...progress, state: "working" },
    ]);
    expect(faces.movers()).toEqual(["progress"]);
    // The work ends and the line unmounts while it holds the motion.
    await faces.show([{ ...header, state: "working" }]);
    expect(faces.movers()).toEqual(["header"]);
    try {
      env.reduced = true;
      await faces.show([
        { ...header, state: "working" },
        { ...progress, state: "working" },
      ]);
      expect(faces.movers()).toEqual([]);
    } finally {
      env.reduced = false;
    }
  });

  it("holds still under reduce motion, in the background, on an unfocused screen or off screen", async () => {
    await using faces = await renderFaces();
    const shown = [{ ...roster, state: "reading" as const }];
    try {
      env.reduced = true;
      await faces.show(shown);
      expect(faces.movers()).toEqual([]);
      env.reduced = false;
      env.active = false;
      await faces.show(shown);
      expect(faces.movers()).toEqual([]);
      env.active = true;
      env.focused = false;
      await faces.show(shown);
      expect(faces.movers()).toEqual([]);
      env.focused = true;
      await faces.show([{ ...roster, state: "reading", onScreen: false }]);
      expect(faces.movers()).toEqual([]);
      await faces.show(shown);
      expect(faces.movers()).toEqual(["roster"]);
    } finally {
      Object.assign(env, { active: true, reduced: false, focused: true });
    }
  });
});
