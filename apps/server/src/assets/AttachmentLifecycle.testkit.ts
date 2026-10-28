import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as AttachmentFileLeases from "./AttachmentFileLeases.ts";
import * as PendingAttachmentSweep from "./PendingAttachmentSweep.ts";

export const layerFiles = Layer.merge(DocumentText.layer, AttachmentFileLeases.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

export const layerFilesAt = (cwd: string, prefix: string) =>
  layerFiles.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(cwd, { prefix }).pipe(Layer.provide(NodeServices.layer)),
    ),
  );

export const layerUnused = Layer.mergeAll(
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(AttachmentFileLeases.AttachmentFileLeases)({}),
  Layer.mock(PendingAttachmentSweep.PendingAttachmentSweep)({}),
);
