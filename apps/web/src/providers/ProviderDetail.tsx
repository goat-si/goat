// One provider, as plain sections (boards 1PBB-2 list+detail, 1Q0P-2 sign-in, 2LET-2 cloud opt-in, 2LEU-2 repair /
// install / another account). Every action is a provider command on the approved wire (docs/part2/provider-wire.md);
// what the wire cannot do yet is not offered.
import { useEffect, useState } from "react";
import type { ServerProviderEntry } from "./wire.ts";
import { useAction, useProviderCall, useProviderEntries } from "./context.tsx";
import { CLOUD, CLOUD_LATER, DRIVERS } from "./catalogMeta.ts";
import { headerLine, maskEmail, nextInstanceId, providerState, titleParts, iconOf } from "./view.ts";
import { Button, Chevron, DotMark, ErrorLine, FAINT, INK, LinkButton, Logo, MUTED, Plus, Row, Section, Toggle, text } from "./ui.tsx";

const INSTALLING = new Set(["downloading", "extracting", "verifying"]);

export interface DetailProps {
  entry: ServerProviderEntry;
  now: number;
  /** Turned off from here: stays in the list (ui-state); turned on or removed: leaves that list. */
  onKeptOff: (instanceId: string, kept: boolean) => void;
  /** Removed from the list: switched off and hidden here until it is added again (the wire has no delete). */
  onRemoved: (instanceId: string) => void;
  onSelect: (instanceId: string) => void;
}

const wireInstance = (e: ServerProviderEntry, patch: Partial<{ enabled: boolean; displayName: string | null }>) => {
  const displayName = patch.displayName === undefined ? e.displayName : patch.displayName ?? undefined;
  return {
    instanceId: e.instanceId, driver: e.driver, enabled: patch.enabled ?? e.enabled,
    ...(displayName ? { displayName } : {}), ...(e.acpAgentId ? { acpAgentId: e.acpAgentId } : {}),
  };
};

export function ProviderDetail({ entry: e, now, onKeptOff, onRemoved, onSelect }: DetailProps) {
  const call = useProviderCall();
  const entries = useProviderEntries() ?? [];
  const act = useAction();
  const state = providerState(e);
  const t = titleParts(e);
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => { setMenu(false); setDetails(false); act.setError(null); }, [e.instanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setEnabled = (on: boolean) => act.run("toggle", async () => {
    await call("goat2.setProviderInstance", wireInstance(e, { enabled: on }));
    onKeptOff(e.instanceId, !on);
  });
  const remove = () => act.run("remove", async () => {
    setMenu(false);
    if (e.enabled) await call("goat2.setProviderInstance", wireInstance(e, { enabled: false }));
    onRemoved(e.instanceId);
  });
  const refresh = () => act.run("refresh", async () => { setMenu(false); await call("server.refreshProviders", { instanceId: e.instanceId }); });
  const addAccount = () => act.run("account", async () => {
    const instanceId = nextInstanceId(entries, e.driver);
    const n = entries.filter((x) => x.driver === e.driver).length + 1;
    await call("goat2.setProviderInstance", { instanceId, driver: e.driver, enabled: true, displayName: `Account ${n}` });
    onSelect(instanceId);
  });
  const install = () => act.run("install", () => call("providerInstall.start", { instanceId: e.instanceId }));
  const cancelInstall = () => act.run("install-cancel", () => call("providerInstall.cancel", { instanceId: e.instanceId, operationId: e.install?.operationId ?? "" }));

  return (
    <div data-provider-detail={e.instanceId} style={{ display: "flex", flexDirection: "column", maxWidth: 720, paddingBlock: 28, paddingInline: 32, width: "100%", boxSizing: "border-box" }}>
      <div style={{ alignItems: "center", display: "flex", gap: 12, paddingBottom: 6 }}>
        <Logo icon={iconOf(e)} tile={36} />
        <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <h1 style={{ margin: 0, ...text(18, INK, 600) }}>{t.name}{t.account ? <span style={{ color: FAINT }}> · {t.account}</span> : null}</h1>
          <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
            <DotMark dot={state.dot} />
            <span data-provider-state="" style={text(12, MUTED)}>{headerLine(e, now)}</span>
          </div>
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 8, position: "relative" }}>
          <span style={text(12, MUTED)}>{e.enabled ? "On" : "Off"}</span>
          <Toggle on={e.enabled} label={`${t.name} on`} disabled={act.busy === "toggle"} onChange={(on) => void setEnabled(on)} />
          <button type="button" aria-label="More" aria-expanded={menu} onClick={() => setMenu((m) => !m)}
            style={{ all: "unset", alignItems: "center", display: "flex", height: 28, justifyContent: "center", width: 28, cursor: "pointer" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" fill={MUTED} /><circle cx="12" cy="12" r="1.5" fill={MUTED} /><circle cx="19" cy="12" r="1.5" fill={MUTED} /></svg>
          </button>
          {menu ? (
            <div role="menu" style={{ position: "absolute", right: 0, top: 32, zIndex: 10, background: "#FFFFFF", borderRadius: 10, boxShadow: "0 8px 24px rgba(13,13,13,0.12), #ECECEC 0px 0px 0px 1px inset", padding: 4, minWidth: 180, display: "flex", flexDirection: "column" }}>
              <MenuItem onClick={() => void refresh()}>Check again</MenuItem>
              <MenuItem onClick={() => void remove()}>Remove from list</MenuItem>
            </div>
          ) : null}
        </div>
      </div>
      <ErrorLine error={act.error} />
      <Banner e={e} />
      {state.need === "repair" && !state.busy ? <RepairCard e={e} onReinstall={e.setup?.canInstall ? install : null} busy={act.busy === "install"} /> : null}
      {state.need === "install" && !state.busy && e.enabled ? <InstallCard e={e} onInstall={e.setup?.canInstall ? install : null} busy={act.busy === "install"} /> : null}
      {e.install && (INSTALLING.has(e.install.phase) || e.install.phase === "failed") ? <InstallProgress e={e} onCancel={cancelInstall} onRetry={install} /> : null}
      <AccountSection e={e} onAddAccount={e.driver === "acpRegistry" ? null : addAccount} />
      <ModelsSection e={e} />
      <Section title="Runs on">
        <Row label="This Mac">
          <span style={{ alignItems: "center", display: "flex", gap: 6 }}>
            <DotMark dot={state.dot === "green" ? "green" : e.probe.installed ? "green" : "grey"} />
            <span>{state.dot === "green" ? "Online" : e.probe.installed ? `Installed${e.probe.version ? ` · v${e.probe.version}` : ""}` : "Not installed"}</span>
          </span>
        </Row>
      </Section>
      {DRIVERS[e.driver]?.cloud ? <CloudSection cloud={DRIVERS[e.driver]!.cloud!} /> : null}
      <DetailsRow e={e} open={details} onToggle={() => setDetails((d) => !d)} />
    </div>
  );
}

function MenuItem({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      style={{ all: "unset", boxSizing: "border-box", padding: "6px 10px", borderRadius: 6, cursor: "pointer", ...text(13) }}>{children}</button>
  );
}

/** Board 1Q0P-2: one blue line saying why sign-in matters. */
function Banner({ e }: { e: ServerProviderEntry }) {
  const s = providerState(e);
  if (s.need !== "sign-in" || !e.enabled) return null;
  const why = e.probe.auth.action?.message ?? (e.probe.message && e.probe.message !== "Not signed in" ? e.probe.message : null)
    ?? `Sign in so GOAT can run ${titleParts(e).name}.`;
  return (
    <div style={{ alignItems: "center", backgroundColor: "#F4F7FE", borderRadius: 10, display: "flex", gap: 10, marginTop: 10, paddingBlock: 12, paddingInline: 14 }}>
      <DotMark dot="blue" />
      <span style={text(13)}>{why}</span>
    </div>
  );
}

/** Board 2LEU-2: the provider cannot start. */
function RepairCard({ e, onReinstall, busy }: { e: ServerProviderEntry; onReinstall: (() => void) | null; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const name = titleParts(e).name;
  return (
    <div role="group" aria-label="Needs repair" style={{ borderRadius: 10, boxShadow: "#F2C9C9 0px 0px 0px 1px inset", display: "flex", flexDirection: "column", gap: 10, marginTop: 10, padding: 14 }}>
      <div style={text(14, INK, 600)}>{name} can’t start{e.probe.message ? ": " + lower(e.probe.message) : "."}</div>
      <div style={text(13, MUTED)}>{onReinstall ? "Reinstalling keeps your settings and account. It takes about a minute." : `Reinstall ${name} on this Mac, then check again.`}</div>
      {onReinstall ? <div style={{ display: "flex", gap: 8 }}><Button primary onClick={onReinstall} disabled={busy}>Reinstall</Button></div> : null}
      {e.probe.message ? (
        <>
          <LinkButton onClick={() => setOpen((o) => !o)} expanded={open}><Chevron open={open} /><span style={text(12, MUTED, 500)}>Show what failed</span></LinkButton>
          {open ? <pre style={{ margin: 0, whiteSpace: "pre-wrap", ...text(12, MUTED), fontFamily: "ui-monospace, Menlo, monospace" }}>{e.probe.message}</pre> : null}
        </>
      ) : null}
    </div>
  );
}

const lower = (s: string) => { const t = s.replace(/\.$/, ""); return t.charAt(0).toLowerCase() + t.slice(1) + "."; };

function InstallCard({ e, onInstall, busy }: { e: ServerProviderEntry; onInstall: (() => void) | null; busy: boolean }) {
  const name = titleParts(e).name;
  return (
    <div role="group" aria-label="Not installed" style={{ borderRadius: 10, boxShadow: "#ECECEC 0px 0px 0px 1px inset", display: "flex", flexDirection: "column", gap: 10, marginTop: 10, padding: 14 }}>
      <div style={text(14, INK, 600)}>{name} isn’t installed on this Mac.</div>
      <div style={text(13, MUTED)}>{onInstall ? `GOAT installs ${name} for you. It takes about a minute.` : `Install ${name}, then check again.`}</div>
      {onInstall ? <div style={{ display: "flex", gap: 8 }}><Button primary onClick={onInstall} disabled={busy}>Install</Button></div> : null}
    </div>
  );
}

function InstallProgress({ e, onCancel, onRetry }: { e: ServerProviderEntry; onCancel: () => void; onRetry: () => void }) {
  const i = e.install!;
  const name = titleParts(e).name;
  const pct = i.totalBytes ? Math.min(100, Math.round((i.downloadedBytes / i.totalBytes) * 100)) : null;
  const verb = i.phase === "downloading" ? "Downloading" : i.phase === "extracting" ? "Unpacking" : i.phase === "verifying" ? "Checking" : "Install failed";
  const reinstall = e.probe.installed;
  return (
    <Section title={i.phase === "failed" ? "Install" : reinstall ? "Reinstalling" : "Installing"}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={text(13)}>{i.phase === "failed" ? (i.message ?? `Installing ${name} failed.`) : `${verb} ${name}${i.version ? " " + i.version : ""}\u2026${pct === null ? "" : ` ${pct}%`}`}</div>
        {i.phase !== "failed" ? (
          <div role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} style={{ backgroundColor: "#EDEDED", borderRadius: 99, height: 4 }}>
            <div style={{ backgroundColor: INK, borderRadius: 99, height: 4, width: `${pct ?? 0}%` }} />
          </div>
        ) : null}
        <div style={{ display: "flex" }}>{i.phase === "failed" ? <Button onClick={onRetry}>Retry</Button> : <Button onClick={onCancel}>Cancel</Button>}</div>
      </div>
    </Section>
  );
}

function AccountSection({ e, onAddAccount }: { e: ServerProviderEntry; onAddAccount: (() => void) | null }) {
  const call = useProviderCall();
  const act = useAction();
  const a = e.probe.auth;
  const flow = e.authFlow;
  const [other, setOther] = useState(false);
  const start = (methodId?: string) => act.run("start", async () => {
    const r = await call<{ authorizationUrl?: string | null }>("providerAuth.start", { instanceId: e.instanceId, ...(methodId ? { methodId } : {}) });
    if (r?.authorizationUrl) openUrl(r.authorizationUrl);
  });
  const acceptUrl = () => act.run("accept", async () => {
    const action = a.action!;
    await call("server.acceptAcpRegistryUrlAuth", { instanceId: e.instanceId, elicitationId: action.elicitationId });
    openUrl(action.url);
  });
  const waiting = flow && (flow.phase === "starting" || flow.phase === "waiting" || flow.phase === "verifying");
  const canAuth = e.setup?.canAuthenticate !== false;
  let body;
  if (waiting) {
    const methods = flow.methods ?? [];
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={text(15, INK, 600)}>{flow.phase === "verifying" ? "Checking your sign-in\u2026" : "Finish signing in in your browser."}</div>
        <div style={text(13, MUTED)}>{flow.message ?? "We opened the sign-in page. When you approve there, this updates by itself."}</div>
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          {flow.authorizationUrl ? <Button primary onClick={() => openUrl(flow.authorizationUrl!)}>Open browser again</Button> : null}
          {flow.authorizationUrl ? <Button onClick={() => void navigator.clipboard?.writeText(flow.authorizationUrl!)}>Copy sign-in link</Button> : null}
          <Button onClick={() => void act.run("cancel", () => call("providerAuth.cancel", { instanceId: e.instanceId, flowId: flow.flowId ?? "" }))}>Cancel</Button>
        </div>
        {flow.expiresAt ? <div style={text(12, FAINT)}>The link stops working at {clockTime(flow.expiresAt)}. If it does, start again here.</div> : null}
        {methods.length > 0 ? (
          <>
            <LinkButton onClick={() => setOther((o) => !o)} expanded={other}>
              <Chevron open={other} /><span style={text(13, MUTED, 500)}>Use another way to sign in</span>
              <span style={text(12, FAINT)}>{methods.map((m) => m.name).join(" · ")}</span>
            </LinkButton>
            {other ? <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{methods.map((m) => <Button key={m.id} onClick={() => void start(m.id)}>{m.name}</Button>)}</div> : null}
          </>
        ) : null}
      </div>
    );
  } else if (a.status === "authenticated") {
    const who = [a.email ? maskEmail(a.email) : null, a.label].filter(Boolean).join(" · ") || "Signed in";
    body = (
      <Row label="Signed in as" actions={<>
        {canAuth ? <Button onClick={() => void start()} disabled={act.busy !== null}>Change account</Button> : null}
        {a.canLogout ? <Button onClick={() => void act.run("logout", () => call("providerAuth.logout", { instanceId: e.instanceId }))} disabled={act.busy !== null}>Sign out</Button> : null}
      </>}>{who}</Row>
    );
  } else if (a.action) {
    body = <Row label="Account" actions={<Button primary onClick={() => void acceptUrl()} disabled={act.busy !== null}>Continue authentication</Button>}>Not signed in</Row>;
  } else if (a.status === "unauthenticated") {
    body = <Row label="Account" actions={canAuth ? <Button primary onClick={() => void start()} disabled={act.busy !== null}>Sign in</Button> : null}>{flow?.phase === "failed" ? (flow.message ?? "Sign-in failed.") : "Not signed in"}</Row>;
  } else {
    body = <Row label="Account">{e.driver === "omo" ? "Uses your Pi sign-in" : "Uses its own sign-in"}</Row>;
  }
  return (
    <Section title="Account">
      {body}
      <ErrorLine error={act.error} />
      {onAddAccount ? (
        <div style={{ alignItems: "center", display: "flex", gap: 8, paddingTop: 4 }}>
          <LinkButton onClick={onAddAccount}><Plus /><span style={text(13, INK, 500)}>Add another account</span></LinkButton>
          <span style={text(12, FAINT)}>Each account keeps its own sign-in and limits.</span>
        </div>
      ) : null}
    </Section>
  );
}

function ModelsSection({ e }: { e: ServerProviderEntry }) {
  const models = e.probe.models;
  if (models.length === 0) return <Section title="Models"><Row label="Available">{e.probe.installed ? "No models reported yet." : "Shown once it is installed."}</Row></Section>;
  const def = models.find((m) => m.isDefault) ?? models[0]!;
  const names = models.map((m) => m.name);
  const shown = names.slice(0, 3).join(", ");
  return (
    <Section title="Models">
      <Row label="Default">{def.name}</Row>
      <Row label="Available">{names.length > 3 ? `${shown} and ${names.length - 3} more` : shown}</Row>
    </Section>
  );
}

/** Board 2LET-2: the cloud counterpart, off; GOAT 2 runs cloud work in a later part. */
function CloudSection({ cloud }: { cloud: string }) {
  const c = CLOUD[cloud]!;
  return (
    <Section title="Also run in the cloud">
      <div style={{ alignItems: "start", borderRadius: 10, boxShadow: "#ECECEC 0px 0px 0px 1px inset", display: "flex", gap: 12, padding: 14 }}>
        <Logo icon={{ driver: cloud }} tile={32} />
        <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: 4 }}>
          <div style={text(14, INK, 600)}>{c.label}</div>
          <div style={text(13, MUTED)}>{c.blurbOptIn}</div>
          <div style={text(12, FAINT)}>Off · nothing is sent to the cloud until you turn this on. {CLOUD_LATER}</div>
        </div>
        <Toggle on={false} disabled label={`${c.label} on`} title={CLOUD_LATER} />
      </div>
    </Section>
  );
}

function DetailsRow({ e, open, onToggle }: { e: ServerProviderEntry; open: boolean; onToggle: () => void }) {
  const call = useProviderCall();
  const act = useAction();
  const [name, setName] = useState(e.displayName ?? "");
  useEffect(() => setName(e.displayName ?? ""), [e.displayName, e.instanceId]);
  const summary = [e.probe.binaryPath ? `Program ${e.probe.binaryPath}` : null, `id ${e.instanceId}`].filter(Boolean).join(" · ");
  const save = () => act.run("name", () => call("goat2.setProviderInstance", wireInstance(e, { displayName: name.trim() || null })));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBlock: 16 }}>
      <LinkButton onClick={onToggle} expanded={open}>
        <Chevron open={open} /><span style={text(13, INK, 500)}>Details</span><span style={text(12, FAINT)}>{summary}</span>
      </LinkButton>
      {open ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 22 }}>
          <Row label="Program">{e.probe.binaryPath ?? "Not found"}</Row>
          <Row label="Version">{e.probe.version ?? "Unknown"}</Row>
          <Row label="Instance id">{e.instanceId}</Row>
          {e.driver !== "acpRegistry" ? (
            <Row label="Account label" actions={<Button onClick={() => void save()} disabled={act.busy !== null || name.trim() === (e.displayName ?? "")}>Save</Button>}>
              <input aria-label="Account label" value={name} placeholder="Work, Personal, ..." onChange={(ev) => setName(ev.target.value)}
                style={{ all: "unset", boxSizing: "border-box", width: "100%", height: 28, paddingInline: 8, borderRadius: 8, boxShadow: "#DFDFDF 0px 0px 0px 1px inset", ...text(13) }} />
            </Row>
          ) : null}
          <ErrorLine error={act.error} />
        </div>
      ) : null}
    </div>
  );
}

export function openUrl(url: string) {
  if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener,noreferrer");
}

function clockTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

