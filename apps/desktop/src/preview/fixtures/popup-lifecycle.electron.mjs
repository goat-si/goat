import { app, BrowserWindow, ipcMain } from "electron";
import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createPreviewPopupLifecycle } from "./PopupLifecycle.mjs";

// The test copies this fixture and the stripped policy into a temporary directory.
const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const preload = NodePath.join(directory, "preview-pick-preload.cjs");
const passkeyArgument = "--t3code-preview-passkey-bridge";
const preloadState = `({
  globals: Object.getOwnPropertyNames(globalThis).filter(name => /goat|t3code/i.test(name)),
  nodeGlobals: ['require', 'process', 'Buffer'].filter(name => name in globalThis),
  nativeCredentials: [CredentialsContainer.prototype.create, CredentialsContainer.prototype.get,
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable,
    PublicKeyCredential.isConditionalMediationAvailable]
    .every(method => Function.prototype.toString.call(method).includes('[native code]'))
})`;
app.setPath("userData", NodePath.join(directory, "userdata"));
app.setPath("sessionData", NodePath.join(directory, "session"));
app.on("window-all-closed", () => {});
const preloadExecutions = new Set();
const preloadErrors = [];
ipcMain.on("popup-fixture:preload-loaded", (event) => preloadExecutions.add(event.sender.id));
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, path, error) => preloadErrors.push({ path, error }));
});

const run = async () => {
  try {
    await app.whenReady();
    let origin;
    const requests = new NodeEvents.EventEmitter();
    // An ephemeral HTTP fixture, never a GOAT server or live browser profile.
    const server = NodeHttp.createServer((request, response) => {
      const body = [];
      request.on("data", (part) => body.push(part));
      request.on("end", () => {
        const result = {
          method: request.method,
          body: Buffer.concat(body).toString(),
          cookie: request.headers.cookie,
        };
        requests.emit(request.url, result);
        response.setHeader("Content-Type", "text/html");
        if (request.url === "/owner") {
          response.setHeader("Set-Cookie", "popupSession=retained; SameSite=Lax");
          response.end('<!doctype html><h1 id="owner">Opener retained</h1>');
        } else if (request.url === "/provider") {
          response.end(`<!doctype html><script>
          window.addEventListener('message', event => {
            if (event.data === 'consent-ok' && event.origin === location.origin) {
              window.opener.postMessage('chain-ok', ${JSON.stringify(origin)});
              window.close();
            }
          });
          window.open('/consent', '_blank', 'width=300,height=300');
        </script>`);
        } else if (request.url === "/consent") {
          response.end(`<!doctype html><script>
          window.opener.postMessage('consent-ok', location.origin); window.close();
        </script>`);
        } else if (request.url === "/post") {
          response.end(`<!doctype html><script>
          window.opener.postMessage(${JSON.stringify(result)}, ${JSON.stringify(origin)});
          window.close();
        </script>`);
        } else {
          response.end("<!doctype html><body>Popup fixture</body>");
        }
      });
    });
    server.listen(0, "::");
    await NodeEvents.once(server, "listening");
    const port = server.address().port;
    origin = `http://127.0.0.1:${port}`;
    const host = new BrowserWindow({
      show: false,
      webPreferences: {
        webviewTag: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // Match DesktopWindow's guest overrides, including contextIsolation=false.
    host.webContents.on("will-attach-webview", (_event, preferences) => {
      preferences.sandbox = true;
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInSubFrames = false;
      preferences.contextIsolation = false;
      preferences.disableHtmlFullscreenWindowResize = true;
      preferences.additionalArguments = [passkeyArgument];
    });
    const guestReady = new Promise((resolve) => {
      host.webContents.once("did-attach-webview", (_event, guest) => {
        const lifecycle = createPreviewPopupLifecycle(guest, () => {});
        guest.setWindowOpenHandler(lifecycle.open);
        guest.once("did-finish-load", () => resolve(guest));
      });
    });
    await host.loadURL(
      "data:text/html," +
        encodeURIComponent(`<webview allowpopups partition="popup-fixture"
        preload="${NodeURL.pathToFileURL(preload).href}"
        webpreferences="contextIsolation=false,sandbox=true,nodeIntegration=false"
        src="${origin}/owner"></webview>`),
    );
    const guest = await guestReady;
    NodeAssert.equal(guest.getLastWebPreferences().contextIsolation, false);
    NodeAssert.deepEqual(await guest.executeJavaScript(preloadState), {
      globals: ["__goatPopupFixturePreload"],
      nodeGlobals: [],
      nativeCredentials: false,
    });
    NodeAssert.equal(preloadExecutions.has(guest.id), true);
    const assertPopupPreferences = async (contents, path) => {
      const preferences = contents.getLastWebPreferences();
      const effective = {
        contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox,
        nodeIntegration: preferences.nodeIntegration,
        nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames,
        nodeIntegrationInWorker: preferences.nodeIntegrationInWorker,
        webviewTag: preferences.webviewTag,
      };
      NodeAssert.deepEqual(effective, {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
      });
      NodeAssert.deepEqual(await contents.executeJavaScript(preloadState), {
        globals: [],
        nodeGlobals: [],
        nativeCredentials: true,
      });
      // Electron 44's SaveLastPreferences omits preload/additionalArguments.
      // Inspect execution as well, including preloads hidden by isolation.
      NodeAssert.equal(preloadExecutions.has(contents.id), false);
      NodeAssert.deepEqual(preloadErrors, []);
      console.log(
        "POPUP_PREFERENCES " + JSON.stringify({ path, ...effective, preloadExecuted: false }),
      );
    };
    const ownerId = guest.id;
    const popupPreferences = [];
    const trackPopups = (opener) => {
      opener.on("did-create-window", (window) => {
        NodeAssert.equal(window.webContents.session, opener.session);
        popupPreferences.push(window.webContents.getLastWebPreferences());
        trackPopups(window.webContents);
      });
    };
    trackPopups(guest);
    // Inspect the initial about:blank document before navigating to a provider.
    const blankWindow = NodeEvents.once(guest, "did-create-window");
    NodeAssert.equal(
      await guest.executeJavaScript(
        "Boolean(window.savedBlank = window.open('', '_blank', 'width=300'))",
        true,
      ),
      true,
    );
    const [blankPopup] = await blankWindow;
    NodeAssert.equal(
      await blankPopup.webContents.executeJavaScript("window.opener !== null"),
      true,
    );
    await assertPopupPreferences(blankPopup.webContents, "opener-retaining-about:blank");
    await blankPopup.loadURL(`${origin}/blank-callback`);
    await assertPopupPreferences(blankPopup.webContents, "opener-retaining-after-navigation");
    blankPopup.destroy();
    let navigations = 0;
    guest.on("did-navigate", () => navigations++);
    const providerOrigin = `http://localhost:${port}`;
    const chain = await guest.executeJavaScript(
      `new Promise((resolve, reject) => {
      window.addEventListener('message', event => {
        if (event.data === 'chain-ok' && event.origin === ${JSON.stringify(providerOrigin)}) {
          resolve({ message: event.data, owner: document.querySelector('#owner').textContent });
        }
      });
      const child = window.open('', '_blank', 'width=420,height=600');
      if (!child) return reject(new Error('Blank child denied'));
      window.savedChild = child;
      child.location.href = ${JSON.stringify(`${providerOrigin}/provider`)};
    })`,
      true,
    );
    NodeAssert.deepEqual(chain, { message: "chain-ok", owner: "Opener retained" });
    NodeAssert.equal(await guest.executeJavaScript("savedChild.closed"), true);
    const post = await guest.executeJavaScript(
      `new Promise(resolve => {
      window.addEventListener('message', event => {
        if (event.origin === location.origin) resolve(event.data);
      }, { once: true });
      const form = document.createElement('form');
      form.method='POST'; form.target='_blank'; form.rel='opener';
      form.action=${JSON.stringify(`${origin}/post`)};
      const input=document.createElement('input'); input.name='proof'; input.value='retained';
      form.append(input); document.body.append(form); form.submit();
    })`,
      true,
    );
    NodeAssert.equal(post.method, "POST");
    NodeAssert.equal(post.body, "proof=retained");
    NodeAssert.match(post.cookie, /popupSession=retained/);
    const createdWindow = (opener) =>
      new Promise((resolve) => {
        opener.once("did-create-window", (window) => {
          window.webContents.once("did-finish-load", () => resolve(window));
        });
      });
    const postRequest = NodeEvents.once(requests, "/post-noopener");
    const postWindow = createdWindow(guest);
    await guest.executeJavaScript(
      `(() => {
        const form = document.createElement('form');
        form.method = 'POST'; form.target = '_blank';
        form.action = ${JSON.stringify(`${origin}/post-noopener`)};
        const input = document.createElement('input');
        input.name = 'proof'; input.value = 'without-opener';
        form.append(input); document.body.append(form); form.submit();
      })()`,
      true,
    );
    const [withoutOpener] = await postRequest;
    NodeAssert.equal(withoutOpener.method, "POST");
    NodeAssert.equal(withoutOpener.body, "proof=without-opener");
    NodeAssert.match(withoutOpener.cookie, /popupSession=retained/);
    const postPopup = await postWindow;
    NodeAssert.equal(postPopup.webContents.session, guest.session);
    NodeAssert.equal(await postPopup.webContents.executeJavaScript("window.opener === null"), true);
    await assertPopupPreferences(postPopup.webContents, "browser-created-noopener-post");

    const nestedRequest = NodeEvents.once(requests, "/nested-noopener");
    const nestedWindow = createdWindow(postPopup.webContents);
    await postPopup.webContents.executeJavaScript(
      `(() => {
        const link = document.createElement('a');
        link.target = '_blank'; link.rel = 'noopener';
        link.href = ${JSON.stringify(`${origin}/nested-noopener`)};
        document.body.append(link); link.click();
      })()`,
      true,
    );
    const [nested] = await nestedRequest;
    NodeAssert.match(nested.cookie, /popupSession=retained/);
    const nestedPopup = await nestedWindow;
    await assertPopupPreferences(nestedPopup.webContents, "browser-created-nested-noopener");
    NodeAssert.equal(nestedPopup.webContents.session, postPopup.webContents.session);
    NodeAssert.equal(
      await nestedPopup.webContents.executeJavaScript("window.opener === null"),
      true,
    );
    nestedPopup.destroy();
    postPopup.destroy();
    const denied = await guest.executeJavaScript(
      `['file:///etc/passwd','vscode://test','data:text/html,x']
      .map(url => window.open(url, '_blank', 'width=300') === null)`,
      true,
    );
    NodeAssert.deepEqual(denied, [true, true, true]);
    const opened = [];
    guest.on("did-create-window", (window) => opened.push(window));
    const bounds = await guest.executeJavaScript(
      `Array.from({length:5}, () => Boolean(window.open('about:blank', '_blank', 'width=300')))`,
      true,
    );
    NodeAssert.deepEqual(bounds, [true, true, true, true, false]);
    NodeAssert.equal(opened.length, 4);
    for (const preferences of popupPreferences) {
      NodeAssert.equal(preferences.sandbox, true);
      NodeAssert.equal(preferences.contextIsolation, true);
      NodeAssert.equal(preferences.nodeIntegration, false);
      NodeAssert.equal(preferences.webviewTag, false);
    }
    NodeAssert.deepEqual([...preloadExecutions], [ownerId]);
    NodeAssert.deepEqual(preloadErrors, []);
    NodeAssert.equal(guest.id, ownerId);
    NodeAssert.equal(navigations, 0);
    const destroyed = NodeEvents.once(guest, "destroyed");
    await host.webContents.executeJavaScript("document.querySelector('webview').remove()");
    await destroyed;
    NodeAssert.ok(opened.every((window) => window.isDestroyed()));
    host.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    console.log("POPUP_LIFECYCLE_PASS");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
};
// Finish ESM evaluation before waiting for Electron readiness.
void run();
