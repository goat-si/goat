import { expect, it } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import { pdfActionsSource } from "./filePreviewGallery";

it("keeps the unresolved resource for refreshing PDF shares", () => {
  const resource = {
    _tag: "draft-workspace-file" as const,
    cwd: "/repo",
    path: "/repo/report.pdf",
  };
  expect(
    pdfActionsSource({
      kind: "pdf",
      name: "report.pdf",
      environmentId: EnvironmentId.make("env"),
      resource,
    }),
  ).toEqual({
    name: "report.pdf",
    mimeType: "application/pdf",
    environmentId: "env",
    resource,
  });
  expect(pdfActionsSource({ kind: "pdf", uri: "file:///report.pdf" })).toEqual({
    name: "report.pdf",
    mimeType: "application/pdf",
    uri: "file:///report.pdf",
  });
});
