import type { DesktopUpdateState } from "@goat/contracts";
import type { BackendStartupFailure } from "../backend/DesktopBackendStartup.ts";

export const ACTION_ORIGIN = "https://startup-recovery.invalid";
export const STARTUP_RECOVERY_ACTIONS = [
  "update",
  "reinstall",
  "releases",
  "copy",
  "quit",
] as const;
export type StartupRecoveryAction = (typeof STARTUP_RECOVERY_ACTIONS)[number];

type StartupRecoveryOffer =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Update"; readonly version: string }
  | { readonly _tag: "Downloading"; readonly version: string; readonly percent: number | null }
  | { readonly _tag: "Reinstall"; readonly version: string }
  | { readonly _tag: "Releases" };

export function resolveStartupRecoveryOffer(
  update: DesktopUpdateState,
  lastStartedVersion: string | null,
): StartupRecoveryOffer {
  if (update.status === "downloading" && update.availableVersion !== null) {
    return {
      _tag: "Downloading",
      version: update.availableVersion,
      percent: update.downloadPercent,
    };
  }
  const version =
    update.downloadedVersion ?? (update.status === "available" ? update.availableVersion : null);
  if (version !== null && version !== update.notAppliedVersion) {
    return { _tag: "Update", version };
  }
  if (update.enabled && (update.status === "idle" || update.status === "checking")) {
    return { _tag: "Checking" };
  }
  if (lastStartedVersion !== null && lastStartedVersion !== update.currentVersion) {
    return { _tag: "Reinstall", version: lastStartedVersion };
  }
  return { _tag: "Releases" };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const actionLink = (action: StartupRecoveryAction, label: string) =>
  `<a href="${ACTION_ORIGIN}/${action}">${escapeHtml(label)}</a>`;

function describeOffer(offer: StartupRecoveryOffer) {
  switch (offer._tag) {
    case "Checking":
      return { text: "Checking for a GOAT update…", action: "" };
    case "Downloading":
      return {
        text: `Downloading GOAT ${offer.version}${offer.percent === null ? "" : ` (${Math.floor(offer.percent / 10) * 10}%)`}…`,
        action: "",
      };
    case "Update":
      return {
        text: `GOAT ${offer.version} is available. Install it and restart to try again.`,
        action: actionLink("update", `Update to ${offer.version}`),
      };
    case "Reinstall":
      return {
        text: `GOAT ${offer.version} started successfully on this computer. You can download and reinstall it.`,
        action: actionLink("reinstall", `Download ${offer.version}`),
      };
    case "Releases":
      return {
        text: "Download another GOAT release to recover.",
        action: actionLink("releases", "Download GOAT"),
      };
  }
}

export function buildStartupRecoveryHtml(input: {
  readonly appVersion: string;
  readonly failure: BackendStartupFailure;
  readonly offer: StartupRecoveryOffer;
  readonly logDir: string;
  readonly updateMessage?: string | null;
}) {
  const offer = describeOffer(input.offer);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>GOAT could not start</title><style>
:root{color-scheme:light dark;font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;background:#fff;color:#1f2937}
@media(prefers-color-scheme:dark){:root{background:#171717;color:#f8fafc}}
body{margin:24px}h1{font-size:22px;line-height:1.3}p{margin:12px 0}nav{display:flex;flex-wrap:wrap;gap:16px;margin:20px 0}
a{color:inherit;text-underline-offset:4px}pre{max-height:180px;overflow:auto;padding:12px;border:1px solid #80808060;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}
footer{font-size:12px;opacity:.7;overflow-wrap:anywhere}
</style></head><body><h1>GOAT could not start</h1>
<p>${escapeHtml(input.failure.reason)}</p><p>${escapeHtml(offer.text)}</p>
${input.updateMessage ? `<p role="status">${escapeHtml(input.updateMessage)}</p>` : ""}
<nav>${offer.action}${actionLink("copy", "Copy details")}${actionLink("quit", "Quit GOAT")}</nav>
<pre>${escapeHtml(input.failure.output.trim() || "The server wrote no output.")}</pre>
<footer>GOAT ${escapeHtml(input.appVersion)} keeps trying in the background.<br>Logs: ${escapeHtml(input.logDir)}</footer>
</body></html>`;
}
