import type { CSSProperties, ReactNode } from "react";
import { BotFace } from "./BotFace.tsx";
import type { BotMood } from "./facePose.ts";
import { COLORS, DEFAULT_FACE, SHAPES } from "./shapes.ts";

const muted = "#5E5E64", faint = "#8A8A90";
const row: CSSProperties = { borderTop: "1px solid #ECECEE", display: "flex", gap: 40, padding: "32px 56px" };
const caption: CSSProperties = { fontSize: 12, lineHeight: "16px", color: faint };
function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section style={row}><div style={{ width: 300, flexShrink: 0, fontSize: 13, lineHeight: "20px", color: muted }}><strong style={{ color: "#111113", display: "block", marginBottom: 6 }}>{title}</strong>{description}</div>{children}</section>;
}
function Item({ children, label, width = 76 }: { children: ReactNode; label: string; width?: number }) {
  return <div style={{ width, flexShrink: 0, display: "flex", alignItems: "center", flexDirection: "column", gap: 8 }}>{children}<span style={caption}>{label}</span></div>;
}
const shapeNames = Object.keys(SHAPES);
const colorNames = Object.keys(COLORS) as (keyof typeof COLORS)[];
const states: { label: string; mood: BotMood; shape: string; color: string }[] = [
  { label: "Idle", mood: "idle", shape: "squircle", color: "zinc" },
  { label: "Working", mood: "work", shape: "round", color: "goat" },
  { label: "Needs you", mood: "needs_you", shape: "pebble", color: "ember" },
  { label: "Done", mood: "done", shape: "cloud", color: "moss" },
  { label: "Failed", mood: "error", shape: "hex", color: "slate" },
];
export function FaceGallery() {
  return <main style={{ width: 1440, background: "white", color: "#111113", fontFamily: 'Inter, system-ui, sans-serif', boxSizing: "border-box" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 56, padding: "56px 56px 40px" }}>
      <div style={{ width: 420, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}><span style={{ ...caption, letterSpacing: ".04em" }}>GOAT · BOT FACES</span><div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-.03em", lineHeight: "44px", color: "#0B0B0C" }}>Every bot is a GOAT.</div><div style={{ color: muted, fontSize: 15, lineHeight: "22px" }}>The horns and the snout come from the logo and grow out of one body. People pick the body shape and the color, and can turn the GOAT parts off for a plain face.</div></div>
      <div style={{ display: "flex", alignItems: "center", gap: 40 }}><BotFace face={DEFAULT_FACE} size={240} mood="idle" /><div style={{ display: "flex", flexDirection: "column", gap: 18 }}>{[["Horns", "The logo’s two crescents, same color as the body"], ["Eyes", "Two white pills, like every bot app"], ["Snout", "The logo’s chevron"], ["Body", "12 shapes × 11 colors, GOAT on or off"]].map(([a,b]) => <div key={a} style={{ fontSize: 12, lineHeight: "16px", color: muted }}><strong style={{ display: "block", fontSize: 13, lineHeight: "18px", color: "#111113" }}>{a}</strong>{b}</div>)}</div></div>
      <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}><div style={{ width: 128, height: 128, borderRadius: 10, background: "#18181B", display: "grid", placeItems: "center" }}><BotFace face={DEFAULT_FACE} size={92} mood="idle" onDark /></div><span style={caption}>Default bot on the app tile</span></div>
    </header>
    <Section title="Shapes" description="The body is the only thing that changes shape. The horns sit at the top of every body at the same size."><div style={{ display: "flex", gap: 8 }}>{shapeNames.map(shape => <Item key={shape} label={shape}><BotFace face={{ ...DEFAULT_FACE, shape }} size={56} mood="idle" /></Item>)}</div></Section>
    <Section title="Colors" description="Zinc is the default and matches the logo. Red is not offered: it means “needs you”."><div style={{ display: "flex", gap: 8 }}>{colorNames.map((color,i) => <Item key={color} label={COLORS[color].label}><BotFace face={{ shape: shapeNames[i]!, color, goat: true }} size={56} mood="idle" /></Item>)}</div></Section>
    <Section title="GOAT on / off" description="On by default. Turn it off per bot and the horns and snout go away, leaving a plain shape with two eyes. Shape, color and states work the same."><div style={{ display: "flex", gap: 28 }}>{[["squircle","zinc"],["round","ember"],["cloud","moss"],["hex","goat"],["bean","dusk"]].map(([shape,color]) => <Item key={shape} label="on · off" width={152}><div style={{ border: "1px solid #ECECEE", borderRadius: 12, padding: "12px 14px", display: "flex", gap: 10 }}><BotFace face={{ shape: shape!, color: color!, goat: true }} size={56} mood="idle" /><BotFace face={{ shape: shape!, color: color!, goat: false }} size={56} mood="idle" /></div></Item>)}</div></Section>
    <Section title="States" description="Shared with every bot (see MOTION.md). The face moves when working, a blue dot means needs you, happy eyes mean done, and closed eyes mean failed."><div style={{ display: "flex", gap: 24 }}>{states.map(({label,mood,shape,color}) => <Item key={mood} label={label} width={96}><div style={{ position: "relative" }}><BotFace face={{ shape, color, goat: true }} size={72} mood={mood} />{mood === "needs_you" && <span style={{ position: "absolute", right: 0, top: 4, border: "2px solid white", background: "#0169CC", width: 10, height: 10, borderRadius: "50%" }} />}</div></Item>)}</div></Section>
    <Section title="Sizes" description="Reads from 64px down to 16px. On dark surfaces the Zinc default flips to light, like the inverted logo; other colors stay."><div style={{ display: "flex", gap: 16 }}>{[false,true].map(dark => <div key={String(dark)} style={{ width: 406, height: 128, boxSizing: "border-box", border: "1px solid #ECECEE", borderRadius: 12, background: dark ? "#141414" : "white", display: "flex", alignItems: "end", justifyContent: "center", gap: 18, paddingBottom: 20 }}>{[64,44,32,24,16].map(size => <Item key={size} width={size} label={String(size)}><BotFace face={DEFAULT_FACE} size={size} mood="idle" onDark={dark} /></Item>)}<BotFace face={{ shape: "round", color: "goat", goat: true }} size={32} mood="idle" onDark={dark} /><BotFace face={{ shape: "cloud", color: "ember", goat: true }} size={24} mood="idle" onDark={dark} /></div>)}</div></Section>
  </main>;
}
