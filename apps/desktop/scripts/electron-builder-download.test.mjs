import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

// Exercises the download retry in patches/app-builder-lib@26.16.1.patch through
// electron-builder's own Electron download, served by a local mirror.
const requireFromDesktop = NodeModule.createRequire(import.meta.url);
const requireFromBuilder = NodeModule.createRequire(requireFromDesktop.resolve("electron-builder"));
const { downloadElectronArtifactZip } = requireFromBuilder(
  "app-builder-lib/out/util/electronGet.js",
);

const VERSION = "44.9.3";
const ZIP_NAME = `electron-v${VERSION}-linux-x64.zip`;
// An empty zip archive: only the end-of-central-directory record.
const ZIP_BODY = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const SHASUMS = `${NodeCrypto.createHash("sha256").update(ZIP_BODY).digest("hex")} *${ZIP_NAME}\n`;

const serveZip = (response) => {
  response.writeHead(200, { "content-length": ZIP_BODY.length });
  response.end(ZIP_BODY);
};

// GitHub's CDN occasionally drops a connection after the 200 headers. got reports
// that as an ECONNRESET error that already carries the 200 response. Ending the
// socket cleanly, rather than with a TCP reset, keeps the headers from being
// discarded unread, so the client always sees the response first.
const dropAfterHeaders = (response) => {
  response.writeHead(200, { "content-length": ZIP_BODY.length * 4 });
  response.write(ZIP_BODY);
  response.socket?.end();
};

const notFound = (response) => {
  response.writeHead(404);
  response.end();
};

/** Downloads the Electron zip from a mirror that answers each zip request with the next responder. */
async function downloadFromMirror(zipResponders) {
  const zipRequests = [];
  const server = NodeHttp.createServer((request, response) => {
    if (request.url === "/SHASUMS256.txt") return response.end(SHASUMS);
    zipRequests.push(request.url);
    (zipResponders.shift() ?? serveZip)(response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const cacheDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-electron-download-"));
  try {
    const result = await downloadElectronArtifactZip({
      electronDownload: {
        mirrorOptions: {
          resolveAssetURL: async (details) =>
            `http://127.0.0.1:${port}/${details.isGeneric ? details.artifactName : ZIP_NAME}`,
        },
      },
      cacheDir,
      artifactName: "electron",
      platformName: "linux",
      arch: "x64",
      version: VERSION,
    }).then(
      (path) => ({ body: NodeFS.readFileSync(path) }),
      (error) => ({ error }),
    );
    return { ...result, zipRequests: zipRequests.length };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    NodeFS.rmSync(cacheDir, { recursive: true, force: true });
  }
}

describe("electron-builder Electron download", () => {
  it("retries a download whose connection drops after the response headers", async () => {
    const result = await downloadFromMirror([dropAfterHeaders]);

    assert.isUndefined(result.error);
    assert.deepEqual(result.body, ZIP_BODY);
    assert.equal(result.zipRequests, 2);
  });

  it("fails a missing release on the first answer", async () => {
    const result = await downloadFromMirror([notFound]);

    assert.equal(result.error?.name, "HTTPError");
    assert.equal(result.zipRequests, 1);
  });
});
