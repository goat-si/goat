import * as ServerConfig from "../config.ts";
import { NodeHttpPlatform } from "@effect/platform-node";
import { GUEST_MESSAGE_MAX_LENGTH, guestSessionCookieName, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DocumentText from "../provider/DocumentText.ts";
import * as GuestShareService from "./GuestShareService.ts";
import { joinedGuest, makeLayerTest, shareThreadFor } from "./GuestShareService.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { layer, readSubmission } from "./http.ts";

const decodeFailure = Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }));
const failureReason = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(decodeFailure),
    Effect.map(({ reason }) => reason),
  );

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission(Effect.void).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("refuses overlapping guest uploads before staging the second multipart body", () =>
  Effect.gen(function* () {
    const extracting = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let extractions = 0;
    let staged = 0;
    const layerTest = makeLayerTest(
      GuestShareService.layer.pipe(
        Layer.provide(
          Layer.succeed(DocumentText.DocumentText, {
            ensure: () =>
              Effect.gen(function* () {
                if (++extractions !== 1) return undefined;
                yield* Deferred.succeed(extracting, undefined);
                yield* Deferred.await(release);
                return undefined;
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const { session, shareId } = yield* joinedGuest;
      const other = yield* shareThreadFor(ThreadId.make("thread:other-guest-upload"));
      const otherGuest = yield* other.guestShares.redeem({
        credential: other.credential,
        name: "Other guest",
      });
      const fs = yield* FileSystem.FileSystem;
      const handler = yield* HttpRouter.toHttpEffect(layer);
      const submit = (
        text: string,
        mode: "file" | "multipart" | "json",
        guest = { token: session, shareId },
      ) =>
        Effect.suspend(() => {
          const form = new FormData();
          const { shareId, token } = guest;
          form.append("shareId", shareId);
          form.append("text", text);
          if (mode === "file") {
            form.append("file", new File(["Notes"], "notes.rtf", { type: "application/rtf" }));
          }
          const request = new Request(`http://localhost/api/guest/messages?share=${shareId}`, {
            method: "POST",
            body: mode === "json" ? JSON.stringify({ shareId, text }) : form,
            headers: {
              cookie: `${guestSessionCookieName(shareId)}=${token}`,
              ...(mode === "json" ? { "content-type": "application/json" } : {}),
            },
          });
          return handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
            Effect.map(HttpServerResponse.toWeb),
          );
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeTempDirectoryScoped: (options) =>
              Effect.sync(() => {
                staged += 1;
              }).pipe(Effect.andThen(fs.makeTempDirectoryScoped(options))),
          }),
        );

      const first = yield* submit("First", "file").pipe(Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(extracting),
        Fiber.join(first).pipe(
          Effect.flatMap((response) =>
            Effect.die(new Error(`Upload returned ${response.status} before extraction`)),
          ),
        ),
      );
      const second = yield* submit("Second", "file");
      assert.equal(second.status, 409);
      assert.equal(yield* failureReason(second), "files_busy");
      assert.equal(
        (yield* submit("Text from an open guest page", "multipart", otherGuest)).status,
        204,
      );
      assert.equal(staged, 1);

      for (const text of ["One", "Two", "Three"]) {
        assert.equal((yield* submit(text, "json")).status, 204);
      }
      yield* Deferred.succeed(release, undefined);
      const firstResponse = yield* Fiber.join(first);
      assert.equal(firstResponse.status, 409);
      assert.equal(yield* failureReason(firstResponse), "busy");
      const attachmentsDir = (yield* ServerConfig.ServerConfig).attachmentsDir;
      assert.deepEqual(yield* fs.readDirectory(attachmentsDir), []);

      const retry = yield* submit("Retry", "file");
      assert.equal(retry.status, 409);
      assert.equal(yield* failureReason(retry), "busy");
      assert.equal(staged, 2);
      assert.equal(extractions, 1);
    }).pipe(Effect.provide(Layer.merge(layerTest, NodeHttpPlatform.layer)));
  }).pipe(Effect.scoped),
);

it.effect("keeps a multi-line form message within the length limit as the guest typed it", () =>
  Effect.gen(function* () {
    // At the limit with LF, over it once each line break is counted as CRLF.
    const lines = Array.from({ length: 50 }, () => "x".repeat(79));
    const text = lines.join("\n").padEnd(GUEST_MESSAGE_MAX_LENGTH, "x");
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", text);
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission(Effect.void).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.strictEqual(submission?.fields.text, text);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
