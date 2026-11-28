#!/usr/bin/env python3
"""Lift GOAT v1 files into apps/web/src/v1/ byte-for-byte and inventory their imports (devlog 070, Revision A/A2).

  scripts/v1-lift.py            copy the lift lists in scripts/v1-lift.d/*.txt (refuses to overwrite a changed lifted file), write the inventory,
                                the alias map and the mirrored bridge re-export files
  scripts/v1-lift.py --check    fail if a lifted file differs from v1, or an import is unresolved / unclassified

Source: ~/Developer/goat at V1_REF (read with git show). Layout: apps/web/src/v1/<v1 repo path>.
Every import of a lifted file is classified LIFT (target lifted), BRIDGE (seam module apps/web/src/v1/seam/<v1 path>,
reached through a one-line re-export at the mirrored path or an alias) or EXTERNAL (npm package, v1 lock version).
"""
import hashlib, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V1 = os.path.expanduser("~/Developer/goat")
V1_REF = "916b5ccc1b2"
OUT = os.path.join(ROOT, "apps/web/src/v1")
SEAM = os.path.join(OUT, "seam")
INVENTORY = os.path.join(ROOT, "devlog/_plan/261128_goat2-ui-paper/071_v1_inventory.md")
WEB = os.path.join(ROOT, "apps/web")
BASE_UI = os.path.join(WEB, "node_modules/@base-ui/react")

def base_ui_portal_part(spec):
    """'@base-ui/react/<part>' whose parts render a Portal: lifted files reach it through seam/base-ui/<part>.ts,
    which mounts portals into the [data-v1][data-v1-portal] root (devlog 070 Revision A2.2)."""
    m = re.fullmatch(r"@base-ui/react/([a-z-]+)", spec)
    if not m: return None
    parts = os.path.join(BASE_UI, m.group(1), "index.parts.d.mts")
    return m.group(1) if os.path.exists(parts) and re.search(r"\bPortal\b", open(parts).read()) else None

CSS_URL_RE = re.compile(r"""url\(\s*["']?(\.{1,2}/[^"')]+)["']?\s*\)""")

LIFT_D = os.path.join(ROOT, "scripts/v1-lift.d")

def read_lists():
    """Lift lists live in scripts/v1-lift.d/*.txt, one file per owning lane (timeline.txt = lane F,
    providers.txt = goat2_providers_ui). One v1 path per line; "dir:<path>" lifts a whole directory,
    "pkg:@goat/<pkg>/<subpath>" lifts a package export; "#" starts a comment."""
    files, dirs, pkgs = [], [], set()
    for name in sorted(os.listdir(LIFT_D)):
        if not name.endswith(".txt"): continue
        for line in open(os.path.join(LIFT_D, name)):
            line = line.split("#", 1)[0].strip()
            if not line: continue
            if line.startswith("dir:"): dirs.append(line[4:].strip())
            elif line.startswith("pkg:"): pkgs.add(line[4:].strip())
            else: files.append(line)
    return files, dirs, pkgs

LIFT, LIFT_DIRS, LIFT_PKG = read_lists()

def mirror(p):
    """v1 apps/web/src/<X> -> <X>; v1 packages/... -> packages/... (layout shared with goat2_providers_ui)."""
    return p[len("apps/web/src/"):] if p.startswith("apps/web/src/") else p

def git(*a):
    return subprocess.run(["git", "-C", V1, *a], capture_output=True, text=True, check=True).stdout
_batch = None
_blobs = {}
def show(p):
    """Blob bytes of v1 <V1_REF>:<p> through one long-lived `git cat-file --batch` (same bytes as `git show`);
    a missing path raises CalledProcessError like `git show` did."""
    global _batch
    if p in _blobs: return _blobs[p]
    if _batch is None:
        _batch = subprocess.Popen(["git", "-C", V1, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    _batch.stdin.write(f"{V1_REF}:{p}\n".encode()); _batch.stdin.flush()
    header = _batch.stdout.readline().decode().split()
    if len(header) < 3 or header[1] == "missing":
        raise subprocess.CalledProcessError(128, ["git", "show", f"{V1_REF}:{p}"])
    data = _batch.stdout.read(int(header[2])); _batch.stdout.read(1)
    _blobs[p] = data
    return data

FILES = set(git("ls-tree", "-r", "--name-only", V1_REF).split())
def pkg_exports(pkg):
    meta = json.loads(show(f"packages/{pkg}/package.json"))
    return meta.get("exports", {})
_exp = {}
def resolve_pkg(spec):
    name, _, sub = spec[len("@goat/"):].partition("/")
    if name not in _exp:
        try: _exp[name] = pkg_exports(name)
        except subprocess.CalledProcessError: _exp[name] = None
    exp = _exp[name]
    if exp is None: return None
    key = "./" + sub if sub else "."
    ent = exp.get(key)
    if isinstance(ent, dict): ent = ent.get("import") or ent.get("types") or ent.get("default")
    if not isinstance(ent, str): return None
    return os.path.normpath(f"packages/{name}/{ent}")

def resolve_local(base, spec):
    cand = "apps/web/src/" + spec[2:] if spec.startswith("~/") else os.path.normpath(os.path.join(os.path.dirname(base), spec))
    for ext in ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]:
        if cand + ext in FILES: return cand + ext
    return None

IMPORT_RE = re.compile(r"""(?:^|\n)\s*(?:import|export)\s[^;=]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|@import\s+["']([^"']+)["']""", re.S)

# Pure modules lifted transitively when a lifted file imports them (logic only, no stores/runtime).
AUTO_LIFT = [r"^packages/shared/src/[^/]+\.ts$", r"^packages/client-runtime/src/work-log/[^/]+\.ts$",
             r"^packages/client-runtime/src/(clock|goatToolSummary|markdownImages|mediaSource|userMessage|worktreeSetup)\.ts$",
             r"^apps/web/src/components/chat/(timeline|turnThreadTargets)[A-Za-z]*\.ts$",
             r"^apps/web/src/(filePathDisplay|timestampFormat|session-logic|sessionTimelineVisibility|sessionRevert|types)\.ts$",
             r"^apps/web/src/lib/(observeResize|tickTextContent|visibleAnimation|windowControlsOverlay)\.ts$",
             # bot-work and source-control logic the model picker reaches (modelTraits -> threadExecution -> state/models)
             r"^packages/client-runtime/src/goatBot/[^/]+\.ts$",
             r"^packages/source-control-[a-z-]+/src/(shared/)?[^/]+\.ts$"]
AUTO_DENY = [r"/state/", r"Store\.ts$", r"environment", r"^packages/contracts/", r"\.(test|testkit|browser\.test)\.tsx?$"]
def auto_lift(p):
    return any(re.search(a, p) for a in AUTO_LIFT) and not any(re.search(d, p) for d in AUTO_DENY)

def lift_set():
    s = set(LIFT)
    # "dir:" lifts carry runtime files only: v1 tests import v1's runner (vite-plus/test) and are not GOAT 2 tests.
    for d in LIFT_DIRS: s |= {f for f in FILES if f.startswith(d + "/") and not re.search(r"\.(test|browser\.test)\.tsx?$", f)}
    for spec in LIFT_PKG:
        p = resolve_pkg(spec)
        if p: s.add(p)
    return s

def lock_version(pkg):
    lock = show("pnpm-lock.yaml").decode()
    m = re.search(r"\n  apps/web:\n(.*?)\n  [a-z]", lock, re.S)
    block = m.group(1) if m else ""
    m2 = re.search(r"\n      '?" + re.escape(pkg) + r"'?:\n        specifier: ([^\n]+)\n        version: ([^\n(]+)", block)
    return m2.group(2).strip() if m2 else "?"

def expand(lifted):
    changed = True
    while changed:
        changed = False
        for f in sorted(lifted):
            if not f.endswith((".ts", ".tsx")): continue
            text = show(f).decode(errors="replace")
            for m in IMPORT_RE.finditer(text):
                spec = m.group(1) or m.group(2) or m.group(3)
                tgt = None
                if spec.startswith("~/") or spec.startswith("."): tgt = resolve_local(f, spec)
                elif spec.startswith("@goat/"): tgt = resolve_pkg(spec)
                if tgt and tgt not in lifted and auto_lift(tgt):
                    lifted.add(tgt); changed = True
    return lifted

def main(check):
    lifted = expand(lift_set())
    rows, aliases, bridges, problems = [], {}, {}, []
    externals = {}
    for f in sorted(lifted):
        src = show(f)
        dest = os.path.join(OUT, mirror(f))
        if check:
            if not os.path.exists(dest) or open(dest, "rb").read() != src:
                problems.append(f"lifted file differs from v1: {f}")
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            stale_bridge = os.path.exists(dest) and open(dest, "rb").read().startswith(b"// Bridge: v1 ")
            if os.path.exists(dest) and not stale_bridge and open(dest, "rb").read() != src and "--force" not in sys.argv:
                sys.exit(f"v1-lift: {f} was changed locally; lifted files stay byte-identical (use --force to re-copy)")
            open(dest, "wb").write(src)
        text = src.decode(errors="replace")
        for m in IMPORT_RE.finditer(text):
            spec = m.group(1) or m.group(2) or m.group(3)
            if spec.startswith("~/") or spec.startswith("."):
                tgt = resolve_local(f, spec) if not spec.endswith(".css") else os.path.normpath(os.path.join(os.path.dirname(f), spec))
                if tgt is None: problems.append(f"unresolved {spec} in {f}"); continue
                kind = "LIFT" if tgt in lifted else "BRIDGE"
                if kind == "BRIDGE": bridges.setdefault(tgt, set()).add(f)
                rows.append((f, spec, kind, tgt))
            elif spec.startswith("@goat/"):
                tgt = resolve_pkg(spec)
                if tgt is None: problems.append(f"unresolved package export {spec} in {f}"); continue
                kind = "LIFT" if tgt in lifted else "BRIDGE"
                aliases[spec] = ("apps/web/src/v1/" + mirror(tgt)) if kind == "LIFT" else ("apps/web/src/v1/seam/" + mirror(tgt))
                if kind == "BRIDGE": bridges.setdefault(tgt, set()).add(f)
                rows.append((f, spec, kind, tgt))
            elif spec in ("tailwindcss",) or spec.startswith("tailwindcss/"):
                rows.append((f, spec, "EXTERNAL", "tailwindcss"))
            else:
                pkg = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
                externals[pkg] = externals.get(pkg) or lock_version(pkg)
                part = base_ui_portal_part(spec)
                if part:
                    seam_part = os.path.join(SEAM, "base-ui", part + ".ts")
                    if not os.path.exists(seam_part): problems.append(f"bridge not implemented: seam/base-ui/{part}.ts (portal part {spec} used by {f})")
                    aliases[spec] = f"apps/web/src/v1/seam/base-ui/{part}.ts"
                    rows.append((f, spec, "BRIDGE", f"seam/base-ui/{part}.ts"))
                else:
                    rows.append((f, spec, "EXTERNAL", pkg))
        if f.endswith(".css"):
            for m in CSS_URL_RE.finditer(text):
                tgt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1)))
                if tgt not in lifted: problems.append(f"unlifted CSS asset {m.group(1)} in {f}")
                else: rows.append((f, m.group(1), "LIFT", tgt))
    # mirrored re-export files for relative/~ bridges
    for tgt in sorted(bridges):
        seam_file = os.path.join(SEAM, mirror(tgt))
        if not os.path.exists(seam_file) and not tgt.startswith("packages/"):
            problems.append(f"bridge not implemented: seam/{mirror(tgt)} (used by {', '.join(sorted(bridges[tgt]))})")
        if tgt.startswith("packages/"):
            if not os.path.exists(seam_file): problems.append(f"bridge not implemented: seam/{mirror(tgt)}")
            # Lifted package files reach sibling bridges by relative path (./state/runtime.ts), which the alias map
            # does not cover, so package bridges get the same mirrored re-export as app bridges.
        mirror_path = os.path.join(OUT, mirror(tgt))
        rel = os.path.relpath(seam_file, os.path.dirname(mirror_path))
        rel = rel if rel.startswith(".") else "./" + rel
        if tgt.endswith(".css"):
            body = f'/* Bridge: v1 {tgt} is replaced by the GOAT 2 seam (docs/PROVENANCE.md bridge table). */\n@import "{rel}";\n'
        else:
            body = f'// Bridge: v1 {tgt} is replaced by the GOAT 2 seam (docs/PROVENANCE.md bridge table).\nexport * from "{rel}";\n'
            # export * does not forward a default export (v1 ChatMarkdown is imported as a default)
            if os.path.exists(seam_file) and re.search(r"^export default ", open(seam_file).read(), re.M):
                body += f'export {{ default }} from "{rel}";\n'
        if not check:
            os.makedirs(os.path.dirname(mirror_path), exist_ok=True)
            open(mirror_path, "w").write(body)
    aliases["~"] = "apps/web/src/v1"
    if not check:
        open(os.path.join(OUT, "aliases.json"), "w").write(json.dumps(dict(sorted(aliases.items())), indent=2) + "\n")
        for name, body in tsconfigs(aliases).items(): open(os.path.join(WEB, name), "w").write(body)
    else:
        for name, body in tsconfigs(aliases).items():
            path = os.path.join(WEB, name)
            if not os.path.exists(path) or open(path).read() != body: problems.append(f"apps/web/{name} is stale: rerun scripts/v1-lift.py")
    if not check:
        os.makedirs(os.path.dirname(INVENTORY), exist_ok=True)
        with open(INVENTORY, "w") as w:
            w.write(f"# 071 — v1 lift inventory (generated by scripts/v1-lift.py from goat {V1_REF})\n\n")
            w.write(f"Lifted files: {len(lifted)}. Bridges: {len(bridges)}. Externals: {len(externals)}.\n\n")
            w.write("## Bridges (seam modules)\n\n| v1 path | used by |\n|---|---|\n")
            for t in sorted(bridges): w.write(f"| {t} | {', '.join(sorted(os.path.basename(x) for x in bridges[t]))} |\n")
            w.write("\n## Externals (v1 lock version)\n\n| package | version |\n|---|---|\n")
            for p, v in sorted(externals.items()): w.write(f"| {p} | {v} |\n")
            w.write("\n## Imports\n\n| file | import | kind | target |\n|---|---|---|---|\n")
            for r in rows: w.write("| " + " | ".join(r) + " |\n")
    for p in problems: print(p)
    print(f"v1-lift: {len(lifted)} lifted, {len(bridges)} bridges, {len(externals)} externals, {len(problems)} problems")
    if check and problems: sys.exit(1)

def tsconfigs(aliases):
    """apps/web/tsconfig.v1.paths.json: the alias map (aliases.json + the hand-written seam/npm-aliases.json) as TypeScript
    paths, the same map vite-plugin-v1.ts resolves with. Extended by tsconfig.v1.json (v1 compiler options, typechecks the
    v1 entry points GOAT 2 uses) and tsconfig.v1-all.json (the whole tree). Generated so there is no second copy."""
    rel = lambda p: "./" + os.path.relpath(os.path.join(ROOT, p), WEB)
    merged = dict(aliases)
    npm = os.path.join(SEAM, "npm-aliases.json")
    if os.path.exists(npm): merged.update({k: v for k, v in json.load(open(npm)).items() if k != "//"})
    paths = {"~/*": [rel(merged["~"]) + "/*"]}
    for k, v in sorted(merged.items()):
        if k != "~": paths[k] = [rel(v)]
    header = "GENERATED by scripts/v1-lift.py from src/v1/aliases.json and src/v1/seam/npm-aliases.json; do not edit."
    return {"tsconfig.v1.paths.json": json.dumps({"//": header, "compilerOptions": {"paths": paths}}, indent=2) + "\n"}

if __name__ == "__main__":
    main("--check" in sys.argv)
