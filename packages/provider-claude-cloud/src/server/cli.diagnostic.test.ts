import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { LOGIN, makeCliHarness } from "./testing.ts";

it.effect("reads a cursor-spaced, wrapped diagnostic as Claude shows it on screen", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeCliHarness();
      const fiber = yield* h.service
        .start(LOGIN, "/fixture/project", "task")
        .pipe(Effect.forkChild);
      yield* h.fake.ready;
      // Native capture: Claude spaces words with cursor-column jumps and wraps at 120 columns.
      h.fake.emit(
        "\u001b7\u001b[r\u001b8\u001b[?25hError:\u001b[8GThis\u001b[13Grepository\u001b[24Gis\u001b[27Gtoo\u001b[31Glarge\u001b[37Gto\u001b[40Gupload:\u001b[48Geven\u001b[53Gwithout\u001b[61Gits\u001b[65Ghistory\u001b[73Git\u001b[76Gis\u001b[79G100.6MB,\u001b[88Gand\u001b[92Gan\u001b[95Gupload\u001b[102Gcan\u001b[106Gbe\u001b[109Gat\u001b[112Gmost\r\r\n" +
          "100MB.\u001b[8GGitHub\u001b[15Gisn't\u001b[21Gconnected\u001b[31Gto\u001b[34Gyour\u001b[39GClaude\u001b[46Gaccount,\u001b[55Gso\u001b[58Gthis\u001b[63Grepository\u001b[74Gcan't\u001b[80Gbe\u001b[83Gcloned\u001b[90Gin\u001b[93Gthe\u001b[97Gcloud.\u001b[104GConnect\u001b[112Git\u001b[115Gon\u001b[118Gthe\r\r\n" +
          "web\u001b[5Gat\u001b[8Ghttps://claude.ai/connect-github\r\r\n\u001b[?25h\u001b[?2004l\u001b]0;\u0007\u001b[?25h",
      );
      h.fake.finish(1);
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(error.detail).toBe(
        "This repository is too large to upload: even without its history it is 100.6MB, and an upload can be at most 100MB. GitHub isn't connected to your Claude account, so this repository can't be cloned in the cloud. Connect it on the web at [link redacted]",
      );
      expect(h.fake.writes).toEqual([]);
    }),
  ),
);
