import {
  BearerConnectionTarget,
  type ConnectionTarget,
  resolveEnvironmentLoopbackUrl,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import type { ExpandedImageItem } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";

const remote = { environmentId: EnvironmentId.make("environment-1"), label: "Build box" };

// Two thumbnails, each linking to a full-size image; the first is the one opened.
function thumbnailGallery() {
  const root = document.createElement("div");
  root.className = "chat-markdown";
  root.innerHTML =
    '<a href="https://cdn.test/a.png"><img></a><a href="http://localhost:5173/b.png"><img></a>';
  const [first, second] = root.querySelectorAll("img");
  const item = (src: string): ExpandedImageItem => ({
    src,
    name: "thumb",
    actionsSource: { kind: "image", name: "thumb", src },
  });
  markdownImageItems.set(first!, item("https://cdn.test/a-thumb.png"));
  markdownImageItems.set(second!, item("https://cdn.test/b-thumb.png"));
  return { first: first!, selected: item("https://cdn.test/a.png") };
}

const routeThrough = (target: ConnectionTarget, httpBaseUrl: string) => (url: string) =>
  resolveEnvironmentLoopbackUrl({
    url,
    connection: { target, httpBaseUrl },
    isDesktopRenderer: false,
  });

it("pages to a linked localhost image at the environment's address", () => {
  const { first, selected } = thumbnailGallery();
  const preview = markdownImageGallery(
    first,
    selected,
    routeThrough(
      new BearerConnectionTarget({ ...remote, connectionId: "saved:box" }),
      "http://100.65.180.100:3773",
    ),
  );
  expect(preview.images.map((image) => image.src)).toEqual([
    "https://cdn.test/a.png",
    "http://100.65.180.100:5173/b.png",
  ]);
});

it("keeps the thumbnail for a linked localhost image this device cannot reach", () => {
  const { first, selected } = thumbnailGallery();
  const preview = markdownImageGallery(
    first,
    selected,
    routeThrough(
      new SshConnectionTarget({ ...remote, connectionId: "ssh:box" }),
      "http://127.0.0.1:41234",
    ),
  );
  expect(preview.images.map((image) => image.src)).toEqual([
    "https://cdn.test/a.png",
    "https://cdn.test/b-thumb.png",
  ]);
});
