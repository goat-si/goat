import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { composerAttachmentUploadKey } from "./composerAttachmentUploadQueue";

it("keeps attachment identities distinct when environment IDs contain colons", () => {
  expect(composerAttachmentUploadKey(EnvironmentId.make("remote:one"), "file")).not.toBe(
    composerAttachmentUploadKey(EnvironmentId.make("remote"), "one:file"),
  );
});
