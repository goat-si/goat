# Part list for scripts/paper-to-parts.py (exec'd by it). Paths come from `--tree`; anchors guard them.
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
P("Composer", B, CHAT + ".1", "Message Reviewer", "input: ReactNode; plus: object; picker: ReactNode",
  slots={"0.0.0": "{input}", "0.2": "{picker}"}, attrs={"0.1": "{...plus}"})
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
