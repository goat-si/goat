import type { EnvironmentLoopbackUrl } from "@goat/client-runtime/connection";
import { mediaKindFromPath } from "@goat/shared/mediaPreview";
import { mediaUrlReference } from "@goat/client-runtime/media-reference";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
  routeUrl?: ((url: string) => EnvironmentLoopbackUrl) | null,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("img") ?? []) {
    const registered = markdownImageItems.get(image);
    if (!registered) continue;
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && mediaKindFromPath(href) !== "image") continue;
    // A link the environment's device cannot reach keeps the image it wraps, never this device's localhost.
    const routed =
      resolveExternalWebLinkHost(href) === null
        ? null
        : routeUrl
          ? routeUrl(href)
          : ({ _tag: "Open", url: resolveProtocolRelativeMediaUrl(href) } as const);
    const linkedSource = routed?._tag === "Open" ? routed.url : null;
    const reference = mediaUrlReference(href);
    const item = linkedSource
      ? {
          ...registered,
          src: linkedSource,
          originalUrl: href,
          actionsSource: {
            kind: "image" as const,
            name: registered.name,
            src: linkedSource,
            ...(reference ? { reference } : {}),
          },
        }
      : registered;
    if (
      image === element ||
      (!markdownImageItems.has(element) && index < 0 && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}
