import {
  BROWSER_IMPORT_FAILURE_COPY,
  BrowserImportFailureReason,
  type BrowserProfile,
  type EnvironmentId,
} from "@goat/contracts";
import { useEffect, useState } from "react";
import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

type Bridge = NonNullable<typeof previewBridge>;

const siteOrigin = (text: string): string | null => {
  try {
    const url = new URL(text.trim());
    const web = url.protocol === "http:" || url.protocol === "https:";
    return web && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
};

const failureCopy = (cause: unknown): string => {
  const text = String(cause);
  const reason =
    BrowserImportFailureReason.literals.find((value) => text.includes(`failed: ${value}.`)) ??
    "readFailed";
  return BROWSER_IMPORT_FAILURE_COPY[reason];
};

type Props = {
  readonly profile: BrowserProfile;
  readonly source: NonNullable<BrowserProfile["importSource"]>;
  readonly environmentId: EnvironmentId;
  readonly bridge: Bridge;
  readonly onClose: () => void;
};

export function BrowserRefreshDialog({ profile, source, environmentId, bridge, onClose }: Props) {
  const [suggestions, setSuggestions] = useState<ReadonlyArray<string>>([]);
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<Bridge["importBrowserCookies"]>> | null>(
    null,
  );

  // Read only cookie domains from the selected desktop partition when the dialog opens.
  // oxlint-disable-next-line goat/react-effect-budget -- load desktop profile suggestions on open
  useEffect(() => {
    let active = true;
    void bridge
      .listBrowserProfileOrigins(environmentId, profile.id)
      .then((origins) => {
        if (active) {
          setSuggestions(origins);
          setSelected(origins);
        }
      })
      .catch(() => {
        if (active) setMessage("Could not load sites from this profile. Enter a site below.");
      });
    return () => {
      active = false;
    };
  }, [bridge, environmentId, profile.id]);

  const addOrigin = () => {
    const site = siteOrigin(origin);
    if (site === null) {
      setMessage("Enter a valid HTTP or HTTPS site address.");
      return;
    }
    setSelected((current) => [...new Set([...current, site])]);
    setOrigin("");
    setMessage(null);
  };
  const refresh = () => {
    setBusy(true);
    setMessage(null);
    void bridge
      .importBrowserCookies({
        environmentId,
        ...source,
        targetProfileId: profile.id,
        origins: selected,
      })
      .then(setResult, (cause: unknown) => setMessage(failureCopy(cause)))
      .then(() => setBusy(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Refresh {profile.name}</DialogTitle>
          <DialogDescription>
            Choose sites to refresh in this desktop browser profile. Shared cookies can also change
            sign-ins on related sites.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {result ? (
            <div aria-live="polite">
              <p>
                Imported {result.imported} cookies; {result.skipped} skipped.
              </p>
              {result.origins?.map((item) => (
                <p key={item.origin}>
                  {item.origin}: {item.imported} imported, {item.skipped} skipped
                </p>
              ))}
              {result.sharedDomains?.map((domain) => (
                <p key={domain}>Also refreshed for other {domain} sites.</p>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {[...new Set([...suggestions, ...selected])].map((site) => (
                <label key={site} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.includes(site)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked ? [...current, site] : current.filter((value) => value !== site),
                      )
                    }
                  />
                  {site}
                </label>
              ))}
              <div className="flex gap-2">
                <Input
                  nativeInput
                  aria-label="Site address"
                  placeholder="https://example.com"
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value)}
                />
                <Button variant="outline" onClick={addOrigin}>
                  Add site
                </Button>
              </div>
            </div>
          )}
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
          {!result ? (
            <Button disabled={busy || selected.length === 0} onClick={refresh}>
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
