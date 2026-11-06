import {
  GOAT_BOT_FACE_STROKE_WIDTH,
  GOAT_BOT_SLEEP_MARK_PATH,
  goatBotFaceArt,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import {
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_VIEWBOX,
} from "@goat/shared/goatMark";
import { useState } from "react";

import { cn } from "~/lib/utils";

/** The goat mark's horns over a pair of eyes that show what the bot is doing. */
export function GoatBotFace({
  state,
  className,
}: {
  readonly state: GoatBotFaceState;
  readonly className?: string;
}) {
  // Fade only on a change, never when the face first appears.
  const [firstState] = useState(state);
  const [changed, setChanged] = useState(false);
  if (!changed && state !== firstState) setChanged(true);
  const art = goatBotFaceArt(state);
  return (
    <svg
      key={state}
      aria-hidden
      viewBox={GOAT_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      data-face={state}
      className={cn(
        changed &&
          "transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none",
        className,
      )}
    >
      <path
        d={GOAT_MARK_HORNS_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={GOAT_MARK_HORNS_SOFTEN_WIDTH}
        strokeLinejoin="round"
      />
      {art.stroked ? (
        <path
          d={art.eyes}
          stroke="currentColor"
          strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
          strokeLinecap="round"
        />
      ) : (
        <path d={art.eyes} fill="currentColor" />
      )}
      {art.sleepMark ? (
        <path
          d={GOAT_BOT_SLEEP_MARK_PATH}
          stroke="currentColor"
          strokeWidth={GOAT_BOT_FACE_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}
