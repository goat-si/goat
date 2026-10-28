// @effect-diagnostics nodeBuiltinImport:off -- canonical file identity is a native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export type SweepFileOutcome = "deleted" | "kept" | "unknown";

export function attachmentIdForFile(file: string): string | undefined {
  const name = NodePath.basename(file);
  const [id, ...suffix] = name.split(".");
  if (id === undefined || parseAttachmentUuid(id) === null) return;
  const tail = suffix.join(".");
  if (tail === "part") return;
  const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
  return new RegExp(`^[a-z0-9]{1,10}(?:\\.txt(?:\\.part)?|\\.${uuid}\\.part)?$`, "i").test(tail)
    ? id
    : undefined;
}

export class AttachmentFileLeases extends Context.Service<
  AttachmentFileLeases,
  {
    readonly withAttachment: <A, E, R>(
      attachmentId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withInactiveFile: (
      file: string,
      remove: Effect.Effect<SweepFileOutcome>,
    ) => Effect.Effect<SweepFileOutcome>;
  }
>()("goat/assets/AttachmentFileLeases") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const directory = NodePath.resolve(config.attachmentsDir);
  const canonical = yield* Effect.promise(() => NodeFSP.realpath(directory));
  const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; references: number }>();
  const acquire = (uuid: string) => {
    const key = `${canonical}/${uuid}`;
    let entry = locks.get(key);
    if (entry === undefined) {
      entry = { semaphore: Semaphore.makeUnsafe(1), references: 0 };
      locks.set(key, entry);
    }
    entry.references++;
    return { key, entry };
  };
  const release = ({ key, entry }: ReturnType<typeof acquire>) => {
    entry.references--;
    if (entry.references === 0) locks.delete(key);
  };
  const withAttachment = Effect.fn("AttachmentFileLeases.withAttachment")(function* <A, E, R>(
    attachmentId: string,
    effect: Effect.Effect<A, E, R>,
  ) {
    const uuid = parseAttachmentUuid(attachmentId);
    if (uuid === null)
      return yield* Effect.die(new Error("Unrecognized attachment lease identity."));
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => acquire(uuid)),
      ({ entry }) => entry.semaphore.withPermit(effect),
      (held) => Effect.sync(() => release(held)),
    );
  });
  const withInactiveFile = Effect.fn("AttachmentFileLeases.withInactiveFile")(function* (
    file: string,
    remove: Effect.Effect<SweepFileOutcome>,
  ) {
    const id = attachmentIdForFile(file);
    if (
      NodePath.dirname(NodePath.resolve(file)) !== directory ||
      id === undefined ||
      parseThreadSegmentFromAttachmentId(id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    )
      return "unknown" as const;
    // Preview recordings write these pending files outside the lease protocol.
    const extension = parseAttachmentFileExtension(id);
    if (extension === "mp4" || extension === "webm") return "unknown" as const;
    const uuid = parseAttachmentUuid(id);
    if (uuid === null) return "unknown" as const;
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => acquire(uuid)),
      ({ entry }) =>
        entry.semaphore
          .withPermitsIfAvailable(1)(remove.pipe(Effect.uninterruptible))
          .pipe(Effect.map(Option.getOrElse(() => "kept" as const))),
      (held) => Effect.sync(() => release(held)),
    );
  });
  return AttachmentFileLeases.of({ withAttachment, withInactiveFile });
});

export const layer = Layer.effect(AttachmentFileLeases, make);
