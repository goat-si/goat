// New bot (2PU-1): live through create_bot (structure/30_wire.md). Layout from the board's generated parts.
import { useState } from "react";
import { BotFace, COLORS, SHAPES } from "@goat2/bot-face";
import type { BotFace as Face } from "@goat2/contracts-rs";
import * as P from "../paper/parts.tsx";
import { plannedProps } from "../planned/Planned.tsx";
import { useClient } from "../host/HostProvider.tsx";

const input = { all: "unset", display: "block", width: "100%", color: "#111113", fontFamily: '"Inter", system-ui, sans-serif', fontSize: 14, lineHeight: "20px" } as const;
const btn = (label: string, onClick: () => void): P.El => ({ role: "button", tabIndex: 0, "aria-label": label, onClick, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } });

export function NewBotDialog({ onClose, onCreated, initial }: { onClose: () => void; onCreated: (botId: string) => void; initial?: Partial<{ name: string; purpose: string; face: Face }> | undefined }) {
  const client = useClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [purpose, setPurpose] = useState(initial?.purpose ?? "");
  const [face, setFace] = useState<Face>(initial?.face ?? { shape: "squircle", color: "goat", goat: true });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shapes = Object.keys(SHAPES);
  const colors = Object.keys(COLORS) as Array<keyof typeof COLORS>;
  const shuffle = () => setFace((f) => ({ ...f, shape: shapes[Math.floor(Math.random() * shapes.length)]!, color: colors[Math.floor(Math.random() * colors.length)]! }));
  const create = async () => {
    if (busy) return;
    if (!name.trim()) { setError("Give the bot a name."); return; }
    setBusy(true); setError(null);
    const r = await client.command({ type: "create_bot", name: name.trim(), purpose: purpose.trim(), face, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } });
    setBusy(false);
    if (r.ok && r.value?.botId) onCreated(r.value.botId);
    else setError(r.error?.message ?? "The host did not create the bot.");
  };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50 }} data-new-bot="" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <P.NewBotBackdrop root={{ "data-backdrop": "", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } }}>
        <P.NewBotDialog
          preview={<BotFace face={face} size={120} mood="idle" />}
          shuffle={btn("Shuffle", shuffle)} upload={plannedProps("bot-settings")} close={btn("Close", onClose)}
          nameInput={<input autoFocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} style={input} />}
          purposeInput={<textarea aria-label="What it does" rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} style={{ ...input, resize: "none" }} />}
          toggleFace={<BotFace face={{ ...face, goat: true }} size={28} mood="idle" />}
          toggle={face.goat
            ? <P.NewBotToggleOn root={{ ...btn("GOAT horns and snout", () => setFace((f) => ({ ...f, goat: false }))), role: "switch", "aria-checked": true }} />
            : <div {...(btn("GOAT horns and snout", () => setFace((f) => ({ ...f, goat: true }))) as object)} role="switch" aria-checked="false"
                style={{ alignItems: "center", backgroundColor: "#DCDCE0", borderRadius: 9999, boxSizing: "border-box", display: "flex", flexShrink: 0, height: 20, justifyContent: "start", padding: 2, width: 36 }}>
                <div style={{ backgroundColor: "#FFFFFF", borderRadius: 9999, boxSizing: "border-box", flexShrink: 0, height: 16, width: 16 }} />
              </div>}
          shapes={<P.ShapeGrid>{shapes.map((s) => {
            const root = { ...btn(`Shape ${s}`, () => setFace((f) => ({ ...f, shape: s }))), "aria-pressed": face.shape === s, "data-shape": s };
            const preview = <BotFace face={{ shape: s, color: face.shape === s ? face.color : "slate", goat: face.goat }} size={30} mood="idle" />;
            return face.shape === s ? <P.ShapeOptionSelected key={s} face={preview} root={root} /> : <P.ShapeOption key={s} face={preview} root={root} />;
          })}</P.ShapeGrid>}
          colors={<P.ColorRow>{colors.map((c) => {
            const root = { ...btn(`Color ${COLORS[c].label}`, () => setFace((f) => ({ ...f, color: c }))), "aria-pressed": face.color === c, "data-color": c };
            const swatch = <div style={{ backgroundColor: COLORS[c].hex, borderRadius: 9999, boxSizing: "border-box", flexShrink: 0, height: 30, width: 30 }} />;
            return face.color === c ? <P.ColorOptionSelected key={c} swatch={swatch} root={root} /> : <P.ColorOption key={c} swatch={swatch} root={root} />;
          })}</P.ColorRow>}
          cancel={btn("Cancel", onClose)} create={{ ...btn("Create bot", () => void create()), "aria-busy": busy }}
          error={error ? <div role="alert" style={{ marginRight: "auto", alignSelf: "center", color: "#5D5D5D", fontFamily: '"Inter", system-ui, sans-serif', fontSize: 13 }}>{error}</div> : null}
        />
      </P.NewBotBackdrop>
    </div>
  );
}
