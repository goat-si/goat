#!/usr/bin/env python3
"""Paper export (get_jsx, includeNodeIds:false) -> React parts.

  scripts/paper-parts.py design/paper/part1 > apps/web/src/paper/parts.tsx   generate every part
  scripts/paper-parts.py --tree design/paper/part1/2R-1.jsx [maxDepth]       print the element tree with paths

Paper exports one element per line, indented by depth. The script parses that into a tree and picks
parts by child-index path (e.g. "0.1.2"), each checked by an anchor string that must occur inside the
part, so a board change fails loudly instead of slicing the wrong lines. Parts can replace text lines,
replace whole subtrees with an expression (slots), drop subtrees and add attributes to elements.
Change Paper first, re-export, then fix PARTS below when a board's structure changes (docs/PAPER.md).
"""
import os, re, sys

class Node:
    def __init__(self, start, indent, line):
        self.start = start; self.end = start; self.indent = indent; self.line = line
        self.children = []; self.text = None
    def tag(self):
        m = re.match(r"\s*<(\w+)", self.line)
        return m.group(1) if m else "#text"

def parse(path):
    lines = open(path).read().split("\n")
    root = Node(0, -1, ""); stack = [root]
    for i, raw in enumerate(lines):
        s = raw.strip()
        if not s or s in ("(", ")"):
            continue
        ind = len(raw) - len(raw.lstrip())
        if s.startswith("</"):
            while len(stack) > 1 and stack[-1].indent > ind:
                stack.pop()
            if len(stack) > 1 and stack[-1].indent == ind:
                stack[-1].end = i; stack.pop()
            continue
        while len(stack) > 1 and stack[-1].indent >= ind and stack[-1].end != -2:
            if stack[-1].indent >= ind:
                stack.pop()
            else:
                break
        n = Node(i, ind, raw)
        stack[-1].children.append(n)
        if s.startswith("<") and not s.endswith("/>") and not re.match(r"^<(\w+)[^>]*>.*</\1>$", s):
            n.end = -2  # open until its closing line
            stack.append(n)
        elif not s.startswith("<"):
            n.text = s
    return lines, root

def find(root, path):
    n = root
    for k in [int(x) for x in path.split(".")] if path else []:
        n = n.children[k]
    return n

def outline(path, maxd=6):
    lines, root = parse(path)
    def walk(n, p, d):
        if d > maxd: return
        for i, c in enumerate(n.children):
            q = f"{p}.{i}" if p else str(i)
            label = c.text if c.text else re.sub(r"style=\{\{.*?\}\}", "", c.line.strip())[:60]
            texts = " | ".join(t for t in subtree_texts(c)[:3])
            print(f"{'  '*d}{q} L{c.start+1}-{c.end+1} {label}  «{texts[:70]}»")
            walk(c, q, d + 1)
    walk(root, "", 0)

def subtree_texts(n):
    out = [n.text] if n.text else []
    for c in n.children: out += subtree_texts(c)
    return out

def block(lines, n):
    return lines[n.start:n.end + 1]

def find_rel(node, rel, name):
    try:
        return find(node, rel)
    except IndexError:
        sys.exit(f"paper-parts: relative path {rel!r} missing in part {name}")

def render(lines, node, *, texts=None, slots=None, drop=(), attrs=None, before=None, after=None, extra_props=None):
    """Return the part's JSX with substitutions. Paths are relative to node ("" = node itself)."""
    texts = texts or {}; slots = slots or {}; attrs = attrs or {}; before = before or {}; after = after or {}
    content = {i: lines[i] for i in range(node.start, node.end + 1)}
    for rel, a in attrs.items():
        n = find(node, rel)
        content[n.start] = re.sub(r"<(\w+)(\s|>|/)", lambda m: f"<{m.group(1)} {a}{m.group(2)}", content[n.start], count=1)
    ranges = {}
    for rel, expr in slots.items():
        n = find(node, rel); ranges[n.start] = (n.end, [" " * n.indent + expr])
    for rel in drop:
        n = find(node, rel); ranges[n.start] = (n.end, [])
    pre = {find(node, rel).start: expr for rel, expr in before.items()}
    post = {find(node, rel).end: expr for rel, expr in after.items()}
    out = []; i = node.start
    while i <= node.end:
        if i in pre: out.append(" " * (len(lines[i]) - len(lines[i].lstrip())) + pre[i])
        if i in ranges:
            end, repl = ranges[i]; out += repl
            if end in post: out.append(" " * (len(lines[i]) - len(lines[i].lstrip())) + post[end])
            i = end + 1; continue
        ln = content[i]
        st = ln.strip()
        if st in texts:
            ln = ln[:len(ln) - len(ln.lstrip())] + texts[st]
        out.append(ln)
        if i in post: out.append(" " * (len(lines[i]) - len(lines[i].lstrip())) + post[i])
        i += 1
    return "\n".join(out)


# ---------------------------------------------------------------- parts
# (name, board, path, anchor, props, options)
EXPORTS = sys.argv[-1] if len(sys.argv) > 1 else "design/paper/part1"
PARTS = []
def part(name, board, path, anchor, props="", **opts):
    PARTS.append((name, board, path, anchor, props, opts))

def generate(d):
    boards = {}
    out = ["// GENERATED by scripts/paper-parts.py from design/paper/part1/*.jsx.",
           "// Do not edit by hand; change the Paper board, re-export, and re-run (docs/PAPER.md).",
           "/* eslint-disable */",
           'import type { AriaAttributes, DOMAttributes, ReactNode } from "react";', "",
           "/** Props spread onto a board element: handlers, aria, data-*, title. */",
           "export type El = DOMAttributes<Element> & AriaAttributes & { title?: string; role?: string; tabIndex?: number; className?: string; [key: `data-${string}`]: string | number | boolean | undefined };", ""]
    for name, board, path, anchor, props, opts in PARTS:
        if board not in boards: boards[board] = parse(os.path.join(d, board + ".jsx"))
        lines, root = boards[board]
        try:
            node = find(root, path)
        except IndexError:
            sys.exit(f"paper-parts: path {path} not in {board} ({name}); the board changed, fix PARTS")
        body = "\n".join(block(lines, node))
        if anchor not in body:
            sys.exit(f"paper-parts: anchor {anchor!r} not found in {board} {path} ({name}); the board changed, fix PARTS in scripts/paper-parts.py")
        extra = opts.pop("extra_props", None)
        jsx = render(lines, node, **opts)
        if extra: props = (props + "; " if props else "") + extra
        ind = node.indent
        jsx = "\n".join(l[ind:] if l[:ind].strip() == "" else l for l in jsx.split("\n"))
        jsx = "\n".join("    " + l for l in jsx.split("\n"))
        plist = [p.strip() for p in props.split(";") if p.strip()]
        plist = [p.replace(": object", ": El") for p in plist]
        sig = f"{{ {', '.join(p.split(':')[0].strip() for p in plist)} }}: {{ {'; '.join(plist)} }}" if plist else ""
        out.append(f"/** {board} {path} */")
        out.append(f"export function {name}({sig}) {{\n  return (\n{jsx}\n  );\n}}\n")
    return "\n".join(out)


# ---------------------------------------------------------------- part list
# Paths come from `--tree`; anchors guard them.
P = lambda *a, **k: part(*a, **k)
B = "2R-1"
TB = "0.0.0"          # top bar
RAIL = "0.0.1.0"
SIDE = "0.0.1.1.0"
CHAT = "0.0.1.1.1.0.0"
PANEL = "0.0.1.1.1.0.1"

# Frame: everything outside the five regions comes from the board.
P("Frame", B, "0", "flexBasis", "top: ReactNode; rail: ReactNode; sidebar: ReactNode; main: ReactNode",
  slots={"0.0": "{top}", "0.1.0": "{rail}", "0.1.1.0": "{sidebar}", "0.1.1.1": "{main}"},
  attrs={"": 'data-frame=""', "0.1.1": 'data-card=""'})
P("TopBar", B, TB, "40px", "children: ReactNode", slots={"0": "{children}"}, drop=["1"], attrs={"": 'data-topbar=""'})
P("Main", B, "0.0.1.1.1", "Routine On PR", "chat: ReactNode; panel: ReactNode", slots={"0.0": "{chat}", "0.1": "{panel}"})
P("TopLeft", B, TB + ".0", "300px", "lights: ReactNode; nav: ReactNode; bell: ReactNode",
  slots={"0": "{lights}", "1": "{nav}", "3": "{bell}"}, attrs={"": 'data-topleft=""'})
P("TrafficLights", B, TB + ".0.0", "#FF5F57")
P("NavButtons", B, TB + ".0.1", "M9 21L9 3", "toggle: object; back: object; forward: object",
  drop=["0.1"], attrs={"0": "{...toggle}", "1": "{...back}", "2": "{...forward}"})
P("Bell", B, TB + ".0.3", "M7.5 19C8", "button: object; count: ReactNode", slots={"1.0": "{count}"}, attrs={"0": "{...button}"})
P("TopTitle", B, TB + ".1.0", "Reviewer", "face: ReactNode; name: ReactNode; button: object",
  slots={"0.0": "{face}"}, texts={"Reviewer": "{name}"}, attrs={"": "{...button}"})
P("TopActions", B, TB + ".1.1", "M12 3v18", "split: object; share: object; panel: object; stamp: ReactNode",
  attrs={"0": "{...split}", "1": "{...share}", "2": "{...panel}"}, before={"0": "{stamp}"})
P("TopRight", B, TB + ".1", "space-between", "children: ReactNode", slots={"0": "{children}"}, drop=["1"])

# Rail
P("Rail", B, RAIL, "width: '44px'", "main: ReactNode; extra: ReactNode; home: ReactNode; more: ReactNode; nav: ReactNode; bottom: ReactNode",
  slots={"0": "{main}{extra}", "1": "{home}", "2": "{more}", "4": "{nav}", "12": "{bottom}"},
  drop=["5", "6", "7", "8", "9", "10", "13"])
P("RailMainBot", B, RAIL + ".0", "#0D0D0D", "face: ReactNode; badge: ReactNode; button: object",
  slots={"0.0": "{face}", "1": "{badge}"}, attrs={"": "{...button}"})
P("RailBadge", B, RAIL + ".0.1", "8.5px", "count: ReactNode", texts={"2": "{count}"})
P("RailHome", B, RAIL + ".1", "M15 21v-8", "button: object", drop=["1"], attrs={"": "{...button}"})
P("RailMore", B, RAIL + ".2", 'cx="19"', "button: object", attrs={"": "{...button}"})
P("RailActivity", B, RAIL + ".4", "M22 12h-2.48", "button: object", attrs={"": "{...button}"})
P("RailInbox", B, RAIL + ".5", "22 12 16 12", "button: object", drop=["1"], attrs={"": "{...button}"})
P("RailUsage", B, RAIL + ".6", "M5 21v-6", "button: object", attrs={"": "{...button}"})
P("RailPulls", B, RAIL + ".7", "M13 6h3", "button: object", attrs={"": "{...button}"})
P("RailMemory", B, RAIL + ".8", "M12 18V5", "button: object", attrs={"": "{...button}"})
P("RailRoutines", B, RAIL + ".9", "M16 14v2.2", "button: object", attrs={"": "{...button}"})
P("RailMachines", B, RAIL + ".10", 'y="14" rx="2"', "button: object", attrs={"": "{...button}"})
P("RailSearch", B, RAIL + ".12", "m21 21-4.34", "button: object", attrs={"": "{...button}"})
P("RailSettings", B, RAIL + ".13", "M9.671 4.136", "button: object", attrs={"": "{...button}"})

# Bot sidebar
P("Sidebar", B, SIDE, "width: '256px'", "children: ReactNode", slots={"0": "{children}"}, drop=["1", "2", "3", "4", "5", "6", "7"], attrs={"": 'data-sidebar=""'})
P("SidebarSearch", B, SIDE + ".0", "Search", "search: object; compose: object", attrs={"0": "{...search}", "1": "{...compose}"})
P("PinnedGrid", B, SIDE + ".1", "flexShrink: '0', gap: '4px'", "children: ReactNode; root: object", slots={"0": "{children}"}, drop=["1", "2"], attrs={"": "{...root}"})
P("PinnedTile", B, SIDE + ".1.0", "GOAT", "face: ReactNode; dot: ReactNode; name: ReactNode; root: object",
  slots={"0.0.0": "{face}", "0.1": "{dot}"}, texts={"GOAT": "{name}"}, attrs={"": "{...root}"})
P("TileDot", B, SIDE + ".1.0.0.1", "#0169CC")
P("SectionHeaderCount", B, SIDE + ".2", "Needs you", "label: ReactNode; count: ReactNode; root: object",
  texts={"Needs you": "{label}", "2": "{count}"}, attrs={"": "{...root}"})
P("SectionHeader", B, SIDE + ".5", "Bots", "label: ReactNode", texts={"Bots": "{label}"})
P("BotRowNeeds", B, SIDE + ".4", "Browser Hand", "face: ReactNode; dot: ReactNode; name: ReactNode; line: ReactNode; root: object",
  slots={"0.0.0": "{face}", "0.0.1": "{dot}"}, texts={"Browser Hand": "{name}", "Needs a Luma code": "{line}"}, attrs={"0": "{...root}"})
P("BotRowNeedsSelected", B, SIDE + ".3", "Reviewer", "face: ReactNode; dot: ReactNode; name: ReactNode; line: ReactNode; root: object",
  slots={"0.0.0": "{face}", "0.0.1": "{dot}"}, texts={"Reviewer": "{name}", "Your call on #7712": "{line}"}, attrs={"0": "{...root}"})
P("BotRow", B, SIDE + ".6", "Standup", "face: ReactNode; name: ReactNode; line: ReactNode; time: ReactNode; root: object",
  slots={"0.0.0": "{face}"}, texts={"Standup": "{name}", "Next 7:00 AM": "{line}", "Yesterday": "{time}"}, attrs={"0": "{...root}"})
P("RowDot", B, SIDE + ".4.0.0.1", "#F7F7F7 0px 0px 0px 2px")
P("RowDotSelected", B, SIDE + ".3.0.0.1", "#E8E8E8 0px 0px 0px 2px")

# Bot chat
P("ChatColumn", B, CHAT, "overflow: 'clip'", "transcript: ReactNode; composer: ReactNode", slots={"0": "{transcript}", "1": "{composer}"})
P("Transcript", B, CHAT + ".0", "Routine On PR", "children: ReactNode; root: object", slots={"0": "{children}"}, drop=["1", "2", "3"], attrs={"": "{...root}"})
P("RoutineLine", B, CHAT + ".0.0", "Routine On PR", "text: ReactNode", texts={"Routine On PR opened ran · 3:02 PM": "{text}"})
P("BotMessage", B, CHAT + ".0.1", "opencodex #7712", "text: ReactNode", slots={"0.0": "{text}"})
P("ChildRow", B, CHAT + ".0.2", "worked for", "text: ReactNode; root: object", texts={"Review #7712 · worked for 4m 12s": "{text}"}, attrs={"0": "{...root}"})
P("DecisionCard", B, CHAT + ".0.3", "Merge PR #7712", "title: ReactNode; body: ReactNode; buttons: ReactNode",
  slots={"1.0": "{body}", "2": "{buttons}"}, texts={"Merge PR #7712 into main?": "{title}"})
P("DecisionButtons", B, CHAT + ".0.3.2", "Fix first", "children: ReactNode", slots={"0": "{children}"}, drop=["1", "2"])
P("DecisionPrimary", B, CHAT + ".0.3.2.0", "Merge", "label: ReactNode; button: object", texts={"Merge": "{label}"}, attrs={"": "{...button}"})
P("DecisionSecondary", B, CHAT + ".0.3.2.1", "Fix first", "label: ReactNode; button: object", texts={"Fix first": "{label}"}, attrs={"": "{...button}"})
P("Composer", B, CHAT + ".1", "Message Reviewer", "input: ReactNode; plus: object; picker: ReactNode; send: object",
  slots={"0.0.0": "{input}", "0.2": "{picker}"}, attrs={"0.1": "{...plus}", "0.3": "{...send}"})
P("ModelChip", B, CHAT + ".1.0.2", "gpt-6.1-sol", "glyph: ReactNode; model: ReactNode; button: object",
  slots={"0": "{glyph}"}, texts={"gpt-6.1-sol": "{model}"}, attrs={"": "{...button}"})

# Right panel (Overview)
P("Panel", B, PANEL, "borderLeftColor", "children: ReactNode", slots={"0": "{children}"}, drop=["1", "2", "3", "4"])
P("PanelHeader", B, PANEL + ".0", "Reviews PRs when they open", "face: ReactNode; name: ReactNode; purpose: ReactNode; edit: object",
  slots={"0.0": "{face}", "2": '<span {...edit} style={{ display: "flex" }}>{editIcon}</span>'},
  texts={"Reviewer": "{name}", "Reviews PRs when they open": "{purpose}"}, extra_props="editIcon: ReactNode")
P("PanelEditIcon", B, PANEL + ".0.2", "svg")
P("PanelTabs", B, PANEL + ".1", "Library", "home: object; library: object", attrs={"0": "{...home}", "1": "{...library}"})
P("PanelSection", B, PANEL + ".2", "Machines", "label: ReactNode; extra: ReactNode; children: ReactNode",
  texts={"Machines": "{label}"}, slots={"1": "{children}"}, drop=["2"], after={"0.0": "{extra}"})
P("PanelSectionCount", B, PANEL + ".3", "Tasks", "label: ReactNode; count: ReactNode; children: ReactNode",
  texts={"Tasks": "{label}", "3": "{count}"}, slots={"1": "{children}"}, drop=["2", "3"])
P("TaskRow", B, PANEL + ".3.2", "Review #7712", "icon: ReactNode; title: ReactNode; meta: ReactNode; root: object",
  slots={"0": "{icon}"}, texts={"Review #7712": "{title}", "Wicked · 4m 12s": "{meta}"}, attrs={"": "{...root}"})
P("TaskDoneIcon", B, PANEL + ".3.2.0", "svg")
P("TaskRunningIcon", B, PANEL + ".3.1.0", "svg")
P("RoutinesSection", B, PANEL + ".4", "Routines", "extra: ReactNode", drop=["1", "2"], after={"0.0": "{extra}"})

# FF-1: sidebar folded — narrower top-left group without the bell.
P("TopLeftCollapsed", "FF-1", "0.0.0.0", "176px", "lights: ReactNode; nav: ReactNode", slots={"0": "{lights}", "1": "{nav}"}, attrs={"": 'data-topleft=""'})
P("NavButtonsCollapsed", "FF-1", "0.0.0.0.1", "svg", "toggle: object; back: object; forward: object", attrs={"0": "{...toggle}", "1": "{...back}", "2": "{...forward}"})

# 12P-1: send-first — a message the host has not taken yet (outbox), with its status line.
P("SentMessage", "12P-1", CHAT + ".0.4", "Sent · GOAT starts when", "text: ReactNode; face: ReactNode; status: ReactNode; actions: ReactNode",
  texts={"#7712 빈 목록이면 이전 목록 유지하게 고쳐줘": "{text}", "Sent · GOAT starts when Wicked connects": "{status}"},
  slots={"0.1.0": "{face}"}, after={"0.1.1": "{actions}"})
# U8-1: machine asleep (machines are Planned; the card renders only in the U8-1 verification scene).
P("AsleepCard", "U8-1", PANEL + ".2", "asleep", "wake: object; other: object", attrs={"1.0": "{...wake}", "1.1": "{...other}"})


# 2PU-1: new bot dialog (live: create_bot).
NB = "0.0.0"
P("NewBotBackdrop", "2PU-1", "0.0", "#F2F2F3", "children: ReactNode; root: object", slots={"0": "{children}"}, attrs={"": "{...root}"})
P("NewBotDialog", "2PU-1", NB, "New bot", "preview: ReactNode; shuffle: object; upload: object; close: object; nameInput: ReactNode; purposeInput: ReactNode; toggleFace: ReactNode; toggle: ReactNode; shapes: ReactNode; colors: ReactNode; cancel: object; create: object; error: ReactNode",
  slots={"1.0.0.0": "{preview}", "1.1.0.1.0": "{nameInput}", "1.1.1.1.0": "{purposeInput}", "2.0.0": "{toggleFace}", "2.1": "{toggle}", "3.1": "{shapes}", "4.1": "{colors}"},
  attrs={"0.1": "{...close}", "1.0.1.0": "{...shuffle}", "1.0.1.1": "{...upload}", "5.0": "{...cancel}", "5.1": "{...create}", "": 'role="dialog" aria-modal="true" aria-label="New bot"'},
  before={"5.0": "{error}"})
P("NewBotToggleOn", "2PU-1", NB + ".2.1", "justifyContent: 'end'", "root: object", attrs={"": "{...root}"})
P("ShapeGrid", "2PU-1", NB + ".3.1", "flexWrap", "children: ReactNode", slots={"0": "{children}"}, drop=[str(i) for i in range(1, 12)])
P("ShapeOption", "2PU-1", NB + ".3.1.0", "#F7F7F8", "face: ReactNode; root: object", slots={"0": "{face}"}, attrs={"": "{...root}"})
P("ShapeOptionSelected", "2PU-1", NB + ".3.1.1", "1.5px inset", "face: ReactNode; root: object", slots={"0": "{face}"}, attrs={"": "{...root}"})
P("ColorRow", "2PU-1", NB + ".4.1", "gap: '14px'", "children: ReactNode", slots={"0": "{children}"}, drop=[str(i) for i in range(1, 11)])
P("ColorOption", "2PU-1", NB + ".4.1.0", "30px", "swatch: ReactNode; root: object", slots={"0": "{swatch}"}, attrs={"": "{...root}"})
P("ColorOptionSelected", "2PU-1", NB + ".4.1.8", "3.5px", "swatch: ReactNode; root: object", slots={"0": "{swatch}"}, attrs={"": "{...root}"})

# 25D-0: worker thread opened in the right panel (replaces the Overview).
TP = "0.0.1.1.1.0.1"
P("ThreadPanel", "25D-0", TP, "Go to thread", "back: object; open: object; close: object; title: ReactNode; meta: ReactNode; body: ReactNode; openTag: ReactNode",
  attrs={"0.0": "{...back}", "1.0": 'data-panel-title=""', "0.1.0": "{...open}", "0.1.1": "{...close}"}, drop=["0.1.0.1", "4", "5"],
  slots={"3": "{body}"}, before={"0.1.0": "{openTag}"},
  texts={"Review #7712": "{title}", "Done · 4m 12s · gpt-6.1-sol · Wicked": "{meta}"})
P("PanelUserBubble", "25D-0", TP + ".3", "Review opencodex", "text: ReactNode", texts={"Review opencodex #7712 when it opens. Run the tests.": "{text}"})
P("PanelAnswer", "25D-0", TP + ".5", "81", "text: ReactNode", slots={"0.0": "{text}"})


# Thread mode (T0 1N65-1, T1 1NEM-1, T4 1OXX-1): boards redrawn from GOAT v1 code (origin/dev 916b5ccc).
T1 = "1NEM-1"
TL = "0.0.1.0.0.0"      # timeline column
TC = "0.0.1.0.1"        # composer
TSB = "0.0.4.1"         # sidebar column
TLIST = TSB + ".2.0"
P("ThreadFrame", T1, "0", "position: 'relative'", "rail: ReactNode; main: ReactNode; header: ReactNode; lights: ReactNode; sidebar: ReactNode; toggle: object; menu: object; bottom: object; panel: object; stamp: ReactNode",
  slots={"0.0.0": "{rail}", "0.1.0": "{main}", "0.2.0": "{header}", "0.3": "{lights}", "0.4.1": "{sidebar}"},
  attrs={"": 'data-frame="" data-thread-frame=""', "0.0": 'data-rail-col=""', "0.2": 'data-topbar=""', "0.5": 'data-overlay=""', "0.4.0": 'data-workspace-bg=""', "0.4": 'data-sidebar-col=""', "0.6": "{...toggle}", "0.7.0": "{...menu}", "0.7.1": "{...bottom}", "0.7.2": "{...panel}"},
  before={"0.7.0": "{stamp}"})
P("ThreadTrafficLights", T1, "0.0.3", "#FF5F57")
P("ThreadMain", T1, "0.0.1.0", "justifyContent: 'space-between'", "timeline: ReactNode; composer: ReactNode", slots={"0.0": "{timeline}", "1": "{composer}"})
P("Timeline", T1, TL, "maxWidth: '672px'", "children: ReactNode; root: object", slots={"1": "{children}"}, drop=[str(i) for i in range(2, 10)], attrs={"": "{...root}"})
P("TlUser", T1, TL + ".1", "The sidebar flickers", "text: ReactNode", texts={"The sidebar flickers when I switch threads quickly. Can you find out why and fix it?": "{text}"})
P("TlFold", T1, TL + ".2", "Worked for", "label: ReactNode; root: object; open: boolean", texts={"Worked for 4m 12s": "{label}"}, attrs={"0.0.0": "{...root}"})
P("TlRowExplored", T1, TL + ".3", "Explored", "text: ReactNode", texts={"Explored 3 files, 2 searches": "{text}"})
P("TlRowEdited", T1, TL + ".4", "Edited Sidebar.tsx", "text: ReactNode; add: ReactNode; del: ReactNode", texts={"Edited Sidebar.tsx": "{text}", "+118": "{add}", "-22": "{del}"})
P("TlRowRan", T1, TL + ".5", "Ran bun run typecheck", "text: ReactNode", texts={"Ran bun run typecheck": "{text}"})
P("TlRowFailed", T1, TL + ".6", "Failed bun test", "text: ReactNode", texts={"Failed bun test sidebar.test.ts": "{text}"})
P("TlAnswer", T1, TL + ".7", "The flicker came from", "text: ReactNode", slots={"0.0.0.0": "{text}"})
P("TlWorking", T1, TL + ".8", "Working for", "label: ReactNode", texts={"Working for 22s": "{label}"})
P("TlRowRunning", T1, TL + ".9", "Running bun test", "text: ReactNode", texts={"Running bun test sidebar.test.ts": "{text}"})
P("ThreadComposer", T1, TC, "Ask anything", "input: ReactNode; plus: object; access: object; spinner: ReactNode; model: object; modelLabel: ReactNode; effort: object; send: ReactNode; banner: ReactNode",
  slots={"0.0.0.0.0": "{input}", "0.0.0.1.1.2": "{spinner}", "0.0.0.1.2": "{send}"}, texts={"GPT-5.5": "{modelLabel}"},
  attrs={"0.0.0.1.0": "{...plus}", "0.0.0.1.1.0": "{...access}", "0.0.0.1.1.3": "{...model}", "0.0.0.1.1.4": "{...effort}"}, before={"0.0.0": "{banner}"})
P("ComposerStop", T1, TC + ".0.0.0.1.2", "svg", "button: object", attrs={"0": "{...button}"})
P("ComposerSpinner", T1, TC + ".0.0.0.1.1.2", "svg")
P("ThreadHeader", T1, "0.0.2.0", "api-server", "icon: ReactNode; project: ReactNode; title: ReactNode", slots={"0.0.0.0.0": "{icon}"}, texts={"api-server": "{project}", "Refactor billing webhooks": "{title}"})
P("ThreadSidebarCol", T1, TSB, "Priority (2)", "top: ReactNode; search: ReactNode; list: ReactNode", slots={"0": "{top}", "1": "{search}", "2": "{list}"})
P("ThreadSidebarTop", T1, TSB + ".0", "GOAT", "toggle: object; back: object; forward: object; bell: object; count: ReactNode",
  attrs={"0.0.0": "{...toggle}", "0.0.1.0": "{...back}", "0.0.1.1": "{...forward}", "1": "{...bell}"}, texts={"2": "{count}"})
P("ThreadSidebarSearch", T1, TSB + ".1", "Search", "search: object; compose: object", attrs={"0.0": "{...search}", "0.1": "{...compose}"})
P("ThreadList", T1, TLIST, "Priority (2)", "children: ReactNode", slots={"0": "{children}"}, drop=[str(i) for i in range(1, 11)])
P("TlsSection", T1, TLIST + ".0", "Priority (2)", "label: ReactNode", texts={"Priority (2)": "{label}"})
P("TlsSectionThreads", T1, TLIST + ".3", "Threads", "label: ReactNode", texts={"Threads": "{label}"})
P("TlsRow", T1, TLIST + ".6", "Update onboarding copy", "icon: ReactNode; title: ReactNode; status: ReactNode; project: ReactNode; right: ReactNode; root: object",
  slots={"0.0.0.0": "{icon}", "0.0.0.2": "{status}", "0.0.1.1": "{right}"}, texts={"Update onboarding copy": "{title}", "web-dashboard": "{project}"}, attrs={"0": "{...root}"})
P("TlsRowSelected", T1, TLIST + ".4", "Refactor billing webhooks", "icon: ReactNode; title: ReactNode; status: ReactNode; project: ReactNode; right: ReactNode; root: object",
  slots={"0.0.0.0": "{icon}", "0.0.0.2": "{status}", "0.0.1.1": "{right}"}, texts={"Refactor billing webhooks": "{title}", "api-server": "{project}"}, attrs={"0": "{...root}"})
P("TlsIcon", T1, TLIST + ".6.0.0.0.0", "")
P("TlsApproval", T1, TLIST + ".1.0.0.0.2", "Approval", "label: ReactNode", texts={"Approval": "{label}"})
P("TlsInput", T1, TLIST + ".2.0.0.0.2", "Input", "label: ReactNode", texts={"Input": "{label}"})
P("TlsDot", T1, TLIST + ".4.0.0.0.2", "")
P("TlsFailed", T1, TLIST + ".5.0.0.0.2", "svg")
P("TlsPr", T1, TLIST + ".4.0.0.1.1", "#128", "num: ReactNode", texts={"#128": "{num}"})
P("TlsMachine", T1, TLIST + ".1.0.0.1.1", "MBP", "name: ReactNode", texts={"MBP": "{name}"})
P("TlsWorkingHeader", T1, TLIST + ".8", "Working", "count: ReactNode; root: object", texts={"2": "{count}"}, attrs={"": "{...root}"})
P("TlsWorkingRow", T1, TLIST + ".9", "Investigate memory", "title: ReactNode; time: ReactNode; root: object", texts={"Investigate memory leak in worker": "{title}", "2m": "{time}"}, attrs={"0": "{...root}"})
P("TlsSpacer", T1, TLIST + ".7", "")
P("UpdatingLine", "1N65-1", "0.0.2.1.1", "Updating", "text: ReactNode", texts={"Updating · 3 of 5 machines": "{text}"})

QB = "0.0.1.0.1.0.0.0"
P("QueueBanner", "1OXX-1", QB, "Queued", "count: ReactNode; rows: ReactNode; header: object", texts={"1": "{count}"}, slots={"0.2": "{rows}"}, attrs={"0.1": "{...header}"})
P("QueueRow", "1OXX-1", QB + ".0.2", "Also add a regression", "text: ReactNode; grip: object; edit: object; steer: object; remove: object; steerLabel: ReactNode",
  texts={"Also add a regression test for the sidebar key change": "{text}", "Steer": "{steerLabel}"},
  attrs={"0.0": "{...grip}", "0.2.0": "{...edit}", "0.2.1": "{...steer}", "0.2.2": "{...remove}"})

if __name__ == "__main__":
    if sys.argv[1] == "--tree":
        outline(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
    else:
        print(generate(sys.argv[1]))
