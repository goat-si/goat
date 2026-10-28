// @effect-diagnostics nodeBuiltinImport:off globalDate:off - browser files are written from Playwright callbacks, outside the Effect runtime.
/**
 * Files the browser keeps for agents: screenshots, downloads and fetched binary bodies. They live
 * as top-level files in the browser artifacts folder, which storage cleanup ages out, so they
 * outlive the tab that produced them.
 *
 * @module browserArtifacts
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ServerBrowserOperationError } from "./browserOperationError.ts";

/**
 * Key of a fetch result's in-memory body. A symbol key never reaches JSON or schema encoding, so
 * an unsaved body cannot leave the server, and an ordinary result's own body field is untouched.
 */
export const FETCHED_BODY = Symbol("fetchedBody");

const notSaved = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The fetch finished after its deadline, so its body was not saved.",
  );

const MAX_SITE_SLUG_LENGTH = 40;
const MAX_SUGGESTED_NAME_LENGTH = 80;

/** The page's host as a short file-name part; "site" when there is none. */
export const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "audio/mpeg": ".mp3",
  "video/mp4": ".mp4",
};

/** An extension for a fetched body: from its content type, else its URL, else .bin. */
export const extensionFor = (contentType: string, rawUrl: string) => {
  const known = EXTENSIONS[contentType.split(";")[0]?.trim().toLowerCase() ?? ""];
  if (known) return known;
  try {
    const fromPath = /\.([a-z0-9]{1,8})$/i.exec(new URL(rawUrl).pathname)?.[1];
    if (fromPath) return `.${fromPath.toLowerCase()}`;
  } catch {
    // An unparsable URL keeps the generic extension.
  }
  return ".bin";
};

/** browser-<kind>-<site>-<time>-<random>, ending in the extension or the page's own file name. */
export const artifactFileName = (
  kind: "download" | "fetch",
  sourceUrl: string,
  ending: { readonly extension: string } | { readonly suggestedName: string },
) => {
  const unique = NodeCrypto.randomBytes(4).toString("hex");
  const tail =
    "extension" in ending
      ? ending.extension
      : `-${
          ending.suggestedName
            .replace(/[^A-Za-z0-9._-]+/g, "_")
            .replace(/^[._]+/, "")
            .slice(0, MAX_SUGGESTED_NAME_LENGTH) || "download"
        }`;
  return `browser-${kind}-${artifactSiteSlug(sourceUrl)}-${Date.now().toString(36)}-${unique}${tail}`;
};

/** Owner-only folder; chmod repairs one an older build created with a wider mode. */
const ensureArtifactDir = async (dir: string) => {
  await NodeFSP.mkdir(dir, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(dir, 0o700);
};

/**
 * Saves through a partial file that only becomes visible under its name once complete and
 * owner-only; a failed save leaves nothing behind.
 */
export const publishArtifact = async (
  dir: string,
  name: string,
  save: (path: string) => Promise<void>,
  expired: () => boolean = () => false,
) => {
  if (expired()) throw notSaved();
  await ensureArtifactDir(dir);
  const path = NodePath.join(dir, name);
  const partial = `${path}.partial`;
  try {
    await save(partial);
    await NodeFSP.chmod(partial, 0o600);
    // A save that outlasted its caller never takes its final name.
    if (expired()) throw notSaved();
    await NodeFSP.rename(partial, path);
    // Nor keeps it, when the rename itself ran past the deadline.
    if (expired()) {
      await NodeFSP.rm(path, { force: true }).catch(() => undefined);
      throw notSaved();
    }
    return path;
  } catch (cause) {
    await NodeFSP.rm(partial, { force: true }).catch(() => undefined);
    throw cause;
  }
};

/**
 * Turns a fetch result's in-memory body into a saved file. Runs after every observation around
 * the operation has let the result through, so a withheld result writes nothing; once the
 * caller stopped waiting, nothing is kept and the save reports a timeout.
 */
export const publishFetchedBody = async <R>(dir: string, result: R, expired: () => boolean) => {
  if (typeof result !== "object" || result === null || !(FETCHED_BODY in result)) return result;
  const { [FETCHED_BODY]: body, ...rest } = result as R & { readonly [FETCHED_BODY]: unknown };
  if (!(body instanceof Uint8Array)) return rest;
  const url = "url" in rest && typeof rest.url === "string" ? rest.url : "";
  const contentType =
    "contentType" in rest && typeof rest.contentType === "string" ? rest.contentType : "";
  const savedPath = await publishArtifact(
    dir,
    artifactFileName("fetch", url, { extension: extensionFor(contentType, url) }),
    (path) => NodeFSP.writeFile(path, body, { mode: 0o600, flag: "wx" }),
    expired,
  );
  return { ...rest, savedPath, sizeBytes: body.byteLength };
};
