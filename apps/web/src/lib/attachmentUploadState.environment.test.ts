import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { attachmentUploadForEnvironment } from "./attachmentUploadState";

it("offers a retry in a draft whose upload moved to another environment", () => {
  const owner = EnvironmentId.make("owner");
  const displaced = EnvironmentId.make("displaced");
  const state = { status: "ready" as const, environmentId: owner, attachmentId: "owner-id" };
  expect(attachmentUploadForEnvironment(state, owner)).toEqual(state);
  expect(attachmentUploadForEnvironment(state, displaced)).toMatchObject({
    status: "failed",
    environmentId: displaced,
  });
});
