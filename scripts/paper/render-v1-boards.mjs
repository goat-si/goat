import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = process.env.BASE || "http://127.0.0.1:5199";
const OUT = "/tmp/p2m-render-out";
fs.mkdirSync(OUT, { recursive: true });
const scenes = {
  "1PBB-2": async (p) => { await p.goto(BASE + "/?fake=1PBB-2"); await p.locator("[data-settings-main]").getByRole("button", { name: "Select Codex", exact: true }).waitFor(); },
  "1Q0P-2": async (p) => { await p.goto(BASE + "/?fake=1Q0P-2"); await p.getByRole("button", { name: "Select Antigravity", exact: true }).click(); const m = p.locator("[data-settings-main]"); await m.getByRole("button", { name: "Sign in", exact: true }).click(); await m.getByText("Finish signing in in your browser.").waitFor(); },
  "1QAN-2": async (p) => { await p.goto(BASE + "/?fake=1QAN-2"); await p.locator("[data-settings-main]").getByRole("button", { name: "Add provider" }).first().click(); await p.getByRole("dialog").getByPlaceholder("Search agents…").waitFor(); },
  "1QM8-2": async (p) => { await p.goto(BASE + "/?fake=2R-1"); await p.getByRole("button", { name: "Reviewer model: gpt-6.1-sol" }).click(); await p.getByText("GPT-6.1 Terra", { exact: true }).waitFor(); },
  "1QYE-2": async (p) => { await p.goto(BASE + "/?fake=1QYE-2"); await p.getByRole("button", { name: "GOAT model: gpt-6.1-sol" }).click(); await p.getByText("GPT-6 Luna", { exact: true }).waitFor(); },
};
const serialize = () => {
  const P = ["display","position","flex-direction","flex-wrap","flex-grow","flex-shrink","flex-basis","align-items","align-self","justify-content","row-gap","column-gap","grid-template-columns","grid-template-rows","padding-top","padding-right","padding-bottom","padding-left","margin-top","margin-right","margin-bottom","margin-left","border-top-width","border-right-width","border-bottom-width","border-left-width","border-top-style","border-right-style","border-bottom-style","border-left-style","border-top-color","border-right-color","border-bottom-color","border-left-color","border-top-left-radius","border-top-right-radius","border-bottom-right-radius","border-bottom-left-radius","background-color","background-image","opacity","box-shadow","transform","overflow-x","overflow-y","z-index","filter","outline-width","outline-style","outline-color","outline-offset"];
  const T = ["color","font-size","font-weight","font-style","line-height","letter-spacing","text-align","text-transform","text-decoration-line","white-space","text-overflow","font-variant-numeric"];
  const SKIP = { "position":"static","flex-grow":"0","flex-shrink":"1","flex-basis":"auto","align-self":"auto","row-gap":"normal","column-gap":"normal","grid-template-columns":"none","grid-template-rows":"none","flex-wrap":"nowrap","flex-direction":"row","align-items":"normal","justify-content":"normal","background-color":"rgba(0, 0, 0, 0)","background-image":"none","opacity":"1","box-shadow":"none","transform":"none","overflow-x":"visible","overflow-y":"visible","z-index":"auto","filter":"none","backdrop-filter":"none","outline-style":"none","letter-spacing":"normal","text-transform":"none","text-decoration-line":"none","text-overflow":"clip","font-style":"normal","font-variant-numeric":"normal","white-space":"normal" };
  const fam = (f) => /mono|Menlo|SF Mono|ui-monospace|Courier/i.test(f) ? '"SF Mono", ui-monospace, monospace' : '"SF Pro", system-ui, sans-serif';
  const cv1 = document.createElement("canvas"); cv1.width = cv1.height = 1; const cx1 = cv1.getContext("2d", { willReadFrequently: true }); const cc = new Map();
  const toRgb = (c) => { if (cc.has(c)) return cc.get(c); cx1.clearRect(0,0,1,1); cx1.fillStyle = "#000"; cx1.fillStyle = c; cx1.fillRect(0,0,1,1); const d = cx1.getImageData(0,0,1,1).data; const hx = (n) => n.toString(16).padStart(2, "0"); const v = "#" + hx(d[0]) + hx(d[1]) + hx(d[2]) + (d[3] < 255 ? hx(d[3]) : ""); cc.set(c, v); return v; };
  const fixColors = (v) => v.replace(/(oklab|oklch|lab|lch|color|rgba?)\([^()]*\)/g, (m) => toRgb(m));
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const W = 1440, H = 900;
  const out = [];
  const posAnc = new WeakMap();
  function emit(el, ancPos, inGrid) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return "";
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) return "";
    if (r.width === 0 && r.height === 0 && !el.children.length) return "";
    if (el.tagName.toLowerCase() === "svg") {
      const c = el.cloneNode(true);
      const srcEls = [el, ...el.querySelectorAll("*")], dstEls = [c, ...c.querySelectorAll("*")];
      srcEls.forEach((se, k) => { const de = dstEls[k]; if (!de) return; const s2 = getComputedStyle(se); for (const pr of ["fill","stroke"]) { if (de.hasAttribute(pr)) { const a = de.getAttribute(pr); if (/^var\(/.test(a)) de.setAttribute(pr, fixColors(s2.getPropertyValue(pr))); continue; } const v = s2.getPropertyValue(pr); if (v && v !== "none") de.setAttribute(pr, fixColors(v)); } de.removeAttribute("class"); if (de.getAttribute("style")?.includes("var(")) de.removeAttribute("style"); });
      c.setAttribute("width", r.width); c.setAttribute("height", r.height);
      c.removeAttribute("class");
      let h = fixColors(c.outerHTML.replace(/currentColor/g, cs.color));
      const st = [`width:${r.width}px`,`height:${r.height}px`,"flex-shrink:0", `color:${cs.color}`];
      if (inGrid || cs.position === "absolute" || cs.position === "fixed") { const a = ancPos; st.push("position:absolute",`left:${r.left-a.x}px`,`top:${r.top-a.y}px`); }
      if (cs.opacity !== "1") st.push(`opacity:${cs.opacity}`);
      return h.replace(/^<svg/, `<svg style="${fixColors(st.join(";"))}"`);
    }
    if (el.tagName === "IMG") {
      let src = el.currentSrc || el.src;
      try { const cv = document.createElement("canvas"); cv.width = el.naturalWidth || r.width; cv.height = el.naturalHeight || r.height; cv.getContext("2d").drawImage(el, 0, 0); src = cv.toDataURL("image/png"); } catch {}
      const st = [`width:${r.width}px`,`height:${r.height}px`,"flex-shrink:0",`object-fit:${cs.objectFit}`,`border-radius:${cs.borderRadius}`];
      if (inGrid || cs.position === "absolute" || cs.position === "fixed") st.push("position:absolute",`left:${r.left-ancPos.x}px`,`top:${r.top-ancPos.y}px`);
      return `<img src="${src}" style="${st.join(";")}">`;
    }
    const mk = cs.webkitMaskImage || cs.maskImage || "";
    const mm = mk.match(/^url\("?(.*?)"?\)$/);
    if (mm && !el.children.length) {
      let src = mm[1];
      if (src.startsWith("data:image/svg+xml")) { try { let svg = src.includes(";base64,") ? atob(src.split(";base64,")[1]) : decodeURIComponent(src.split(",").slice(1).join(",")); svg = svg.replace(/currentColor/g, cs.backgroundColor).replace(/<svg/, `<svg fill="${cs.backgroundColor}"`); src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))); } catch {} }
      const st2 = [`width:${r.width}px`,`height:${r.height}px`,"flex-shrink:0"];
      if (inGrid || cs.position === "absolute" || cs.position === "fixed") st2.push("position:absolute",`left:${r.left-ancPos.x}px`,`top:${r.top-ancPos.y}px`);
      return `<img src="${src}" style="${st2.join(";")}">`;
    }
    const st = ["box-sizing:border-box"];
    for (const p of P) { const v = cs.getPropertyValue(p); if (!v || SKIP[p] === v) continue; if (/^(margin|padding)-/.test(p) && v === "0px") continue; if (/^border-.*-width$/.test(p) && v === "0px") continue; if (/^border-.*-(style|color)$/.test(p)) { const side = p.split("-")[1]; if (cs.getPropertyValue(`border-${side}-width`) === "0px") continue; } if (/radius/.test(p) && v === "0px") continue; if (/^outline-(color|offset|width)$/.test(p) && cs.outlineStyle === "none") continue; st.push(`${p}:${v}`); }
    let pos = cs.position, my = ancPos;
    if (inGrid && pos !== "absolute" && pos !== "fixed") { pos = "absolute"; st.push("position:absolute"); }
    if (pos === "absolute" || pos === "fixed") {
      const i = st.findIndex(s => s.startsWith("position:")); st[i] = "position:absolute"; for (let k = st.length - 1; k > i; k--) if (st[k] === "position:absolute") st.splice(k, 1);
      st.push(`left:${r.left-ancPos.x}px`, `top:${r.top-ancPos.y}px`);
      const ti = st.findIndex(s => s.startsWith("transform:")); if (ti >= 0 && /^matrix\(1, 0, 0, 1,/.test(cs.transform)) st.splice(ti, 1);
    } else if (pos === "sticky") { const i = st.findIndex(s => s.startsWith("position:")); st[i] = "position:relative"; }
    if (pos !== "static") my = { x: r.left + parseFloat(cs.borderLeftWidth), y: r.top + parseFloat(cs.borderTopWidth) };
    if (pos === "static") { /* nothing */ }
    const inline = cs.display.startsWith("inline") && cs.display !== "inline-flex" && cs.display !== "inline-block" && cs.display !== "inline-grid";
    if (!inline) st.push(`width:${r.width}px`, `height:${r.height}px`, "flex-shrink:0");
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    if (hasText || isField) { for (const p of T) { const v = cs.getPropertyValue(p); if (!v || SKIP[p] === v) continue; st.push(`${p}:${v}`); } st.push(`font-family:${fam(cs.fontFamily)}`); if (r.height < parseFloat(cs.lineHeight || cs.fontSize) * 1.6 && cs.whiteSpace === "normal") st.push("white-space:nowrap"); }
    if (pos !== "static" && !st.some(s => s.startsWith("position:"))) st.push("position:relative");
    if (my !== ancPos && !st.some(s => s.startsWith("position:"))) st.push("position:relative");
    const isGrid = cs.display === "grid" || cs.display === "inline-grid";
    let gridPos = my;
    if (isGrid) { const gi = st.findIndex(x => x.startsWith("display:")); st[gi] = "display:block"; for (const k of ["grid-template-columns","grid-template-rows","row-gap","column-gap","align-items","justify-content"]) { const z = st.findIndex(x => x.startsWith(k + ":")); if (z >= 0) st.splice(z, 1); } if (!st.some(x => x.startsWith("position:"))) st.push("position:relative"); gridPos = { x: r.left + parseFloat(cs.borderLeftWidth), y: r.top + parseFloat(cs.borderTopWidth) }; }
    let inner = "";
    if (isField) {
      const val = el.value; const ph = el.getAttribute("placeholder") || "";
      if (val) inner = esc(val); else if (ph) { const pc = fixColors(getComputedStyle(el, "::placeholder").color); inner = `<span style="color:${pc};font-size:${cs.fontSize};line-height:${cs.lineHeight};font-family:${fam(cs.fontFamily)};white-space:nowrap">${esc(ph)}</span>`; }
    } else {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, " "); if (t.trim()) inner += esc(t); }
        else if (n.nodeType === 1) inner += emit(n, isGrid ? gridPos : my, isGrid);
      }
    }
    if ((el.scrollTop || el.scrollLeft) && inner) inner = `<div style="margin-top:${-el.scrollTop}px;margin-left:${-el.scrollLeft}px;display:${cs.display === "flex" ? "flex" : "block"};flex-direction:${cs.flexDirection};flex-shrink:0;width:${el.scrollWidth}px">${inner}</div>`;
    const tag = inline ? "span" : "div";
    if (cs.display === "contents") return inner;
    return `<${tag} style="${fixColors(st.join(";"))}">${inner}</${tag}>`;
  }
  const root = { x: 0, y: 0 };
  let body = "";
  for (const c of document.body.children) { if (c.tagName === "SCRIPT") continue; let h = emit(c, root); if (h.startsWith('<div style="box-sizing:border-box;') && !/^<div style="[^"]*position:/.test(h)) h = h.replace('<div style="box-sizing:border-box;', '<div style="box-sizing:border-box;position:absolute;left:0px;top:0px;'); body += h; }
  const bg = getComputedStyle(document.body).backgroundColor;
  return `<div style="position:relative;width:${W}px;height:${H}px;overflow:hidden;box-sizing:border-box;background-color:${bg === "rgba(0, 0, 0, 0)" ? "#FFFFFF" : fixColors(bg)};font-family:&quot;SF Pro&quot;, system-ui, sans-serif">${body}</div>`;
};
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const [id, go] of Object.entries(scenes)) {
  const p = await ctx.newPage();
  try {
    await go(p); await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}/${id}.png` });
    const html = await p.evaluate(serialize);
    fs.writeFileSync(`${OUT}/${id}.html`, html);
    const text = await p.evaluate(() => document.body.innerText);
    console.log(id, "ok", html.length, "emails:", (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).join(","));
  } catch (e) { console.log(id, "FAIL", String(e).slice(0, 300)); }
  await p.close();
}
await b.close();
