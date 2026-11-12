"use strict";
// pen dashboard: a static page served by the local pen daemon. The one-time token arrives in the URL
// fragment and is traded for a bearer kept in sessionStorage; every API call sends it.
(() => {
  const KEY = "pen.dashboard.bearer";
  const SERVER_KEY = "pen.dashboard.server";
  const POLL_MS = 3000;
  // A request that outlives these ends the tab: state polls are quick, actions may push to every
  // member (the server allows them 90 s).
  const STATE_TIMEOUT_MS = 10000;
  const ACTION_TIMEOUT_MS = 95000;
  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat(Infinity)) {
      if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    }
    return el;
  }
  // bi renders a Korean label with its English twin.
  const bi = (ko, en) => [
    h("span", { class: "ko" }, ko),
    h("span", { class: "sep" }, " · "),
    h("span", { class: "en" }, en),
  ];
  const muted = (...k) => h("span", { class: "muted" }, ...k);
  function mono(a, ...k) {
    if (a && typeof a === "object" && !(a instanceof Node) && !Array.isArray(a)) {
      return h("span", { ...a, class: "mono" + (a.class ? " " + a.class : "") }, ...k);
    }
    return h("span", { class: "mono" }, a, ...k);
  }

  let bearer = sessionStorage.getItem(KEY);
  // server is this session's server id: only the dashboard that issued the bearer can name it.
  let server = sessionStorage.getItem(SERVER_KEY);
  let state = null;
  let offset = 0; // client clock minus daemon clock
  let lastKey = "";
  let lastRender = 0;
  let timer = 0;
  let polling = false;
  let pollAgain = false;
  let retried503 = false;
  const fullFP = new Set();

  class ApiError extends Error {
    constructor(kind, message, status) {
      super(message || kind);
      this.kind = kind;
      this.status = status || 0;
    }
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { Authorization: "Bearer " + bearer },
      cache: "no-store",
      credentials: "omit",
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const ctl = new AbortController();
    const timeout = setTimeout(
      () => ctl.abort(),
      method === "GET" ? STATE_TIMEOUT_MS : ACTION_TIMEOUT_MS,
    );
    opts.signal = ctl.signal;
    let r;
    let data = null;
    try {
      r = await fetch(path, opts);
      // The dashboard never comes back on this port, and another program may take it: an answer
      // without this session's server id is not the dashboard's, so nothing of it is read.
      if (!server || r.headers.get("X-Pen-Server") !== server)
        throw new Error("not this dashboard");
      try {
        data = await r.json();
      } catch (e) {
        if (ctl.signal.aborted) throw e;
      }
    } catch {
      stopForGood();
      throw new ApiError("gone", "the dashboard stopped");
    } finally {
      clearTimeout(timeout);
    }
    if (r.status === 401) {
      dropSession();
      throw new ApiError("session", data && data.error);
    }
    if (!r.ok) throw new ApiError("failed", (data && data.error) || "HTTP " + r.status, r.status);
    return data;
  }

  function dropSession() {
    bearer = null;
    server = null;
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(SERVER_KEY);
  }

  const pad = (n) => String(n).padStart(2, "0");
  function stamp(ms) {
    const t = new Date(ms);
    return (
      t.getFullYear() +
      "-" +
      pad(t.getMonth() + 1) +
      "-" +
      pad(t.getDate()) +
      " " +
      pad(t.getHours()) +
      ":" +
      pad(t.getMinutes())
    );
  }
  function clock(ms) {
    const t = new Date(ms);
    return pad(t.getHours()) + ":" + pad(t.getMinutes());
  }
  function ago(ms) {
    const s = Math.max(0, (Date.now() - offset - ms) / 1000);
    if (s < 60) return Math.round(s) + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  const groups = (fp) => fp.split(" ");
  const shortFP = (fp) => groups(fp).slice(0, 2).join(" ");
  const hostOf = (u) => u.replace(/^[a-z]+:\/\//, "");
  function bytes(n) {
    let i = 0;
    for (; n >= 999.5 && i < 5; i++) n /= 1000;
    return i ? n.toFixed(n < 9.995 ? 2 : n < 99.95 ? 1 : 0) + " " + "kMGTP"[i - 1] + "B" : n + " B";
  }
  const inOut = (t) => bytes(t.in) + " / " + bytes(t.out);
  const hexOf = (s) => s.replace(/\s+/g, "").toUpperCase();

  function flash(btn, ko, en) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = ko + " · " + en;
    setTimeout(() => {
      btn.textContent = btn.dataset.label;
    }, 1600);
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      flash(btn, "복사됨", "Copied");
    } catch {
      flash(btn, "복사 실패", "Copy failed");
    }
  }
  const copyBtn = (text) =>
    h(
      "button",
      { class: "btn small", type: "button", onclick: (e) => copy(text, e.currentTarget) },
      "복사 · Copy",
    );
  const cmdBox = (text) =>
    h("div", { class: "cmd-row" }, h("pre", { class: "cmd" }, text), copyBtn(text));

  // showError puts a daemon error (English) under a Korean heading in box.
  function showError(box, ko, en, err) {
    box.replaceChildren(h("strong", null, ko + " · " + en), h("div", { class: "en" }, err.message));
    box.hidden = false;
  }
  function hideError(box) {
    box.hidden = true;
    box.replaceChildren();
  }

  const GATES = {
    none: [
      "세션 없음 · No session",
      "이 탭에는 대시보드 세션이 없습니다. 이 기기의 터미널에서 pen dashboard를 실행하세요. · This tab has no dashboard session. Run pen dashboard in a terminal on this machine.",
      "pen dashboard",
    ],
    used: [
      "링크가 이미 사용되었거나 만료됨 · This link was already used or has expired",
      "링크는 한 번만, 10분 안에 쓸 수 있습니다. pen dashboard를 다시 실행해 새 링크를 여세요. · A link works once, within 10 minutes. Run pen dashboard again for a new one.",
      "pen dashboard",
    ],
    gone: [
      "대시보드가 멈췄습니다 · The dashboard stopped",
      "이 탭을 닫고 pen dashboard를 다시 실행하세요 (주소가 바뀝니다). pen이 꺼져 있다면 먼저 pen up을 실행하세요. · Close this tab and run pen dashboard again (the address changes). If pen is not running, run pen up first.",
      "pen dashboard",
    ],
    out: [
      "로그아웃됨 · Logged out",
      "이 탭의 세션을 끝냈습니다. 다시 열려면 pen dashboard를 실행하세요. · This tab's session has ended. Run pen dashboard to open the page again.",
      "pen dashboard",
    ],
  };
  function gate(kind) {
    clearTimeout(timer);
    const [title, body, cmd] = GATES[kind];
    $("gate-title").textContent = title;
    $("gate-text").textContent = body;
    $("gate-cmd").textContent = cmd;
    $("gate").hidden = false;
    $("app").hidden = true;
    $("top").hidden = true;
    for (const d of document.querySelectorAll("dialog[open]")) d.close();
  }
  // stopForGood drops the session and gates the tab; only a new pen dashboard link opens it again.
  function stopForGood() {
    dropSession();
    gate("gone");
  }

  async function poll() {
    if (polling) {
      pollAgain = true;
      return;
    }
    clearTimeout(timer);
    if (!bearer || document.hidden) return;
    polling = true;
    try {
      const s = await api("GET", "/api/state");
      retried503 = false;
      render(s);
    } catch (e) {
      if (e.kind === "session") {
        polling = false;
        gate("none");
        return;
      }
      if (!(e.status === 503 && !retried503)) {
        polling = false;
        stopForGood();
        return;
      }
      retried503 = true;
    }
    polling = false;
    if (pollAgain) {
      pollAgain = false;
      return poll();
    }
    if (!document.hidden && bearer) timer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else poll();
  });

  function render(s, force) {
    const key = JSON.stringify({ ...s, now: 0 });
    const sel = getSelection();
    const selecting = sel && !sel.isCollapsed && $("app").contains(sel.anchorNode);
    state = s;
    offset = Date.now() - s.now;
    if (!force && (selecting || (key === lastKey && Date.now() - lastRender < 30000))) return;
    lastKey = key;
    lastRender = Date.now();
    renderHeader(s);
    renderMembers(s);
    renderRelays(s);
    renderPending(s);
    renderLogin(s);
    renderEvents(s);
    $("top").hidden = false;
    $("app").hidden = false;
    $("gate").hidden = true;
  }

  function badge(cls, ...k) {
    return h("span", { class: "badge " + cls }, ...k);
  }
  function renderHeader(s) {
    const mesh = s.self.meshId;
    $("hd-mesh").replaceChildren(
      muted(bi("메시", "Mesh")),
      " ",
      mono({ title: mesh }, mesh.slice(0, 8)),
      " ",
      copyBtn(mesh),
    );
    if (s.account) {
      const who = s.account.email || "sub " + s.account.sub;
      $("hd-account").replaceChildren(
        muted(bi("계정", "Account")),
        " ",
        h("span", { title: s.account.loginUrl }, "Google " + who),
      );
    } else {
      $("hd-account").replaceChildren(
        muted(bi("계정", "Account")),
        " ",
        badge("neutral", bi("연결 안 됨", "not bound")),
        " ",
        h("span", { class: "muted" }, "→ "),
        mono("pen login"),
      );
    }
    const lockBtn = h(
      "button",
      { class: "btn small", type: "button", onclick: () => toggleLock(!s.locked) },
      s.locked ? "끄기 · Turn off" : "켜기 · Turn on",
    );
    $("hd-lock").replaceChildren(
      muted(bi("잠금", "Lock")),
      " ",
      s.locked ? badge("warn", bi("켜짐", "on")) : badge("neutral", bi("꺼짐", "off")),
      " ",
      lockBtn,
    );
    const n = s.pending.length;
    $("hd-pending").replaceChildren(
      n
        ? h(
            "a",
            { href: "#pending-panel", class: "badge accent" },
            "승인 대기 " + n + " · " + n + " pending",
          )
        : "",
    );
    const self = s.members.find((m) => m.self);
    $("hd-self").replaceChildren(
      muted(bi("이 기기", "This machine")),
      " ",
      h("strong", null, self ? self.name : s.self.name),
      " ",
      uplinkBadge(s.uplink),
    );
  }
  function uplinkBadge(u) {
    if (u === "up") return badge("ok", bi("연결됨", "connected"));
    if (u === "connecting") return badge("warn", bi("다시 연결 중", "retrying"));
    if (u === "replaced") return badge("danger", bi("교체됨", "replaced"));
    return badge("neutral", u);
  }

  async function toggleLock(on) {
    const ok = await confirmDlg(
      on ? "잠금 켜기 · Turn lock on" : "잠금 끄기 · Turn lock off",
      on
        ? "켜면 Google 로그인으로 들어오는 새 기기는 여기서 승인을 기다립니다."
        : "끄면 메시의 Google 계정으로 로그인한 기기가 바로 가입합니다.",
      on
        ? "With lock on, machines that sign in with Google wait for approval here."
        : "With lock off, machines that sign in with the mesh's Google account join at once.",
      on ? "켜기 · Turn on" : "끄기 · Turn off",
    );
    if (!ok) return;
    try {
      await api("POST", "/api/lock", { on });
      hideError($("members-err"));
    } catch (e) {
      if (e.kind === "session") return gate("none");
      showError($("members-err"), "잠금 변경 실패", "Could not change the lock", e);
    }
    poll();
  }

  function renderMembers(s) {
    $("member-count").textContent = String(s.members.length);
    const rows = s.members.map((m) => memberRow(s, m));
    $("members").tBodies[0].replaceChildren(...rows);
    const offline = s.members.some((m) => !m.self && !m.online && m.lastSeen);
    const foot = [
      "릴레이 열은 이 데몬이 본 세션(메시 동기화, 받은 세션)만 보여 줍니다. 이 기기 CLI의 pen pipe, pen forward 세션은 나오지 않습니다(24시간 열은 셉니다). · The relay column shows only sessions this daemon sees (mesh sync and sessions it accepts); pen pipe and pen forward from this machine's CLI are not shown there (the 24 h column counts them).",
    ];
    if (s.full) {
      foot.unshift(
        "메시가 가득 찼습니다: 새 기기, 이름, 잠금, 계정 연결이 거부됩니다(제거는 계속 됩니다). 새 메시로 옮기세요. · The mesh is full: new machines, names, locks and bindings are refused (revokes still work). Move to a new mesh.",
      );
    }
    if (s.saveError) {
      foot.unshift(
        "이 기기의 상태 폴더에 쓸 수 없어 다른 멤버가 보낸 기록을 보관하지 못합니다. 디스크 공간이나 폴더 권한을 확인하세요. · This machine cannot write its state folder, so records other members send are not kept: " +
          s.saveError,
      );
    }
    if (s.revoked24h) foot.push("제거된 멤버 · Removed members, 24 h: " + inOut(s.revoked24h));
    if (offline) {
      foot.unshift(
        "오프라인 멤버: 릴레이는 아무것도 보관하지 않습니다. 기기가 돌아오면 다시 동기화합니다. · Offline members: the relay holds nothing; a member rejoins and syncs when it comes back.",
      );
    }
    $("members-foot").replaceChildren(...foot.map((t) => h("span", { class: "foot-line" }, t)));
    if (s.members.length <= 1) {
      $("members-empty").replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("strong", null, bi("아직 이 기기뿐입니다", "Only this machine so far")),
          h(
            "p",
            null,
            "오른쪽 ‘기기 추가’에서 초대를 만들거나 Google 로그인 명령을 복사해 새 기기에서 실행하세요. · Create an invite or copy the Google sign-in command under Add a machine, then run it on the new machine.",
          ),
        ),
      );
    } else {
      $("members-empty").replaceChildren();
    }
  }

  function memberRow(s, m) {
    const open = fullFP.has(m.nodeId);
    const fpCell = h(
      "td",
      { class: "fp" },
      open
        ? mono(
            { class: "fp-full", title: m.fingerprint },
            h("span", null, groups(m.fingerprint).slice(0, 5).join(" ")),
            h("span", null, groups(m.fingerprint).slice(5).join(" ")),
          )
        : mono(shortFP(m.fingerprint)),
      " ",
      h(
        "button",
        {
          class: "btn link",
          type: "button",
          "aria-expanded": open ? "true" : "false",
          onclick: () => {
            if (open) fullFP.delete(m.nodeId);
            else fullFP.add(m.nodeId);
            render(state, true);
          },
        },
        open ? "접기 · less" : "전체 · full",
      ),
    );
    let status;
    if (m.self) status = [uplinkBadge(s.uplink)];
    else if (m.online)
      status = [
        badge("ok", bi("온라인", "online")),
        m.lastSeen
          ? h("div", { class: "muted sub", title: stamp(m.lastSeen) }, ago(m.lastSeen))
          : "",
      ];
    else if (m.lastSeen)
      status = [
        badge("neutral", bi("오프라인", "offline")),
        h(
          "div",
          { class: "muted sub", title: stamp(m.lastSeen) },
          "마지막 · last " + ago(m.lastSeen),
        ),
      ];
    else status = [badge("neutral", bi("아직 안 보임", "not seen yet"))];
    let via;
    if (!m.admittedBy) via = bi("창립", "founder");
    else {
      const by = m.admittedByName || m.admittedBy.slice(0, 8);
      via = [
        m.via === "google"
          ? ["Google", h("div", { class: "muted sub" }, m.email || "")]
          : bi("초대", "invite"),
        h("div", { class: "muted sub" }, bi("승인", "by"), " " + by),
      ];
    }
    const joined =
      m.since > 1e11
        ? h("span", { title: stamp(m.since) }, stamp(m.since).slice(0, 10))
        : muted("—");
    const relay = m.self
      ? muted("—")
      : m.relay
        ? mono({ title: m.relay }, hostOf(m.relay))
        : muted("—");
    const action = m.self
      ? ""
      : h(
          "button",
          { class: "btn small", type: "button", onclick: () => openRevoke(m) },
          "제거 · Revoke",
        );
    return h(
      "tr",
      { class: m.self ? "self" : "" },
      h(
        "td",
        null,
        h("strong", null, m.name),
        h("div", { class: "muted sub mono" }, m.nodeId.slice(0, 8)),
      ),
      fpCell,
      h("td", null, status),
      h("td", null, via),
      h("td", null, joined),
      h("td", null, relay),
      h("td", null, m.traffic24h ? mono(inOut(m.traffic24h)) : muted("—")),
      h("td", { class: "actions" }, action),
    );
  }

  let revoking = null;
  function openRevoke(m) {
    revoking = m;
    $("rv-h").textContent = "멤버 제거 · Revoke " + m.name;
    $("rv-text").replaceChildren(
      m.name +
        "의 접근이 바로 끊깁니다. 지금 닿는 멤버에게는 바로, 나머지는 다음 동기화 때 알립니다.",
      h("br"),
      h(
        "span",
        { class: "en" },
        m.name +
          " loses access at once; members reachable now are told now, the rest at their next sync.",
      ),
    );
    $("rv-label").textContent = "확인을 위해 " + m.name + " 입력 · Type " + m.name + " to confirm";
    $("rv-name").value = "";
    $("rv-compromised").checked = false;
    $("rv-go").disabled = true;
    $("rv-go").hidden = false;
    $("rv-cancel").textContent = "취소 · Cancel";
    hideError($("rv-err"));
    $("rv-ok").hidden = true;
    $("dlg-revoke").showModal();
    $("rv-name").focus();
  }
  $("rv-name").addEventListener("input", () => {
    $("rv-go").disabled = !revoking || $("rv-name").value !== revoking.name;
  });
  $("rv-go").addEventListener("click", async () => {
    const m = revoking;
    const btn = $("rv-go");
    btn.disabled = true;
    btn.textContent = "멤버에게 알리는 중… · Telling members…";
    hideError($("rv-err"));
    try {
      const r = await api("POST", "/api/revoke", {
        nodeId: m.nodeId,
        compromised: $("rv-compromised").checked,
        confirmName: $("rv-name").value,
      });
      const box = $("rv-ok");
      box.replaceChildren(h("strong", null, "제거됨 · Revoked " + m.name), results(r.results));
      if (r.next)
        box.append(
          h(
            "p",
            { class: "warn-box" },
            h("strong", null, "다음 단계 · Next steps"),
            h("br"),
            h("span", { class: "en" }, r.next),
          ),
        );
      box.hidden = false;
      btn.hidden = true;
      $("rv-cancel").textContent = "닫기 · Close";
      poll();
    } catch (e) {
      if (e.kind === "session") return gate("none");
      showError($("rv-err"), "제거 실패", "Revoke failed", e);
      btn.disabled = $("rv-name").value !== m.name;
    }
    btn.textContent = "제거 · Revoke";
  });

  function results(rs) {
    if (!rs || !rs.length)
      return h("p", { class: "muted" }, "알릴 다른 멤버 없음 · No other members to tell");
    const label = {
      taken: ["받음", "taken"],
      offline: ["오프라인", "offline"],
      refused: ["거절", "refused"],
    };
    return h(
      "ul",
      { class: "results" },
      rs.map((r) => {
        const l = label[r.result];
        return h(
          "li",
          null,
          h("strong", null, r.name),
          " ",
          l ? bi(l[0], l[1]) : h("span", { class: "en" }, r.result),
        );
      }),
    );
  }

  function renderRelays(s) {
    const rows = s.relays.map((r) => {
      let note = "";
      if (r.uplink === "connecting")
        note = h(
          "div",
          { class: "sub warn-text" },
          "다시 연결 중 — URL을 확인하세요 · Retrying — check the URL",
        );
      else if (r.uplink === "replaced")
        note = h(
          "div",
          { class: "sub warn-text" },
          "다른 pen이 이 노드의 연결을 가져갔습니다. 이 기기에서 pen up을 실행하세요. · Another pen took this node's uplink; run pen up on this machine.",
        );
      const rtt = r.rttMs
        ? h(
            "span",
            { class: "rtt", title: stamp(r.rttAt) },
            r.rttMs + " ms",
            muted(" · " + ago(r.rttAt)),
          )
        : muted("—");
      const rm = h(
        "button",
        {
          class: "btn small ghost",
          type: "button",
          disabled: s.relays.length < 2,
          title:
            s.relays.length < 2
              ? "릴레이가 하나는 있어야 합니다 · A node needs at least one relay"
              : null,
          onclick: () => removeRelay(r.url),
        },
        "제거 · Remove",
      );
      const t = s.relays24h.find((x) => x.url === r.url);
      const traffic = t ? h("div", { class: "sub muted" }, "24h " + inOut(t)) : "";
      return h(
        "li",
        { class: "row stack" },
        h("div", { class: "row-main" }, mono({ class: "url", title: r.url }, r.url), note, traffic),
        h("div", { class: "row-side" }, uplinkBadge(r.uplink), " ", rtt, " ", rm),
      );
    });
    const other = s.relays24h.find((x) => x.url === "");
    if (other)
      rows.push(
        h("li", { class: "row" }, muted(bi("다른 릴레이", "Other relays"), " 24h " + inOut(other))),
      );
    $("relays").replaceChildren(...rows);
  }
  async function setRelays(list) {
    try {
      await api("POST", "/api/relays", { relays: list });
      hideError($("relays-err"));
      return true;
    } catch (e) {
      if (e.kind === "session") gate("none");
      else showError($("relays-err"), "릴레이 변경 실패", "Could not change the relays", e);
      return false;
    } finally {
      poll();
    }
  }
  async function removeRelay(url) {
    const ok = await confirmDlg(
      "릴레이 제거 · Remove relay",
      url +
        "를 목록에서 뺍니다. 다른 멤버는 계속 이 릴레이로 이 기기를 찾을 수 있으니, 모든 기기에서 같이 바꾸세요.",
      "Removes " +
        url +
        " from this node's list. Other members may still look for this node there, so change it on every machine.",
      "제거 · Remove",
    );
    if (ok) setRelays(state.relays.map((r) => r.url).filter((u) => u !== url));
  }
  $("relay-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const u = $("relay-url").value.trim();
    if (!u || !state) return;
    if (await setRelays([...state.relays.map((r) => r.url), u])) $("relay-url").value = "";
  });

  function renderPending(s) {
    const box = $("pending");
    $("pending-panel").classList.toggle("attention", s.locked && s.pending.length > 0);
    if (!s.pending.length) {
      let text;
      if (!s.account)
        text =
          "이 메시는 Google 계정에 연결되어 있지 않아 기기는 초대로만 들어옵니다. · This mesh is not bound to a Google account, so machines join by invite only.";
      else if (s.locked)
        text =
          "대기 중인 요청이 없습니다. Google 로그인으로 들어오는 새 기기는 여기서 기다립니다. · No pending requests. Machines that sign in with Google wait here.";
      else
        text =
          "잠금이 꺼져 있어 메시 계정으로 로그인한 기기는 바로 가입합니다. 승인을 거치게 하려면 잠금을 켜세요. · Lock is off: machines that sign in with the mesh's account join at once. Turn the lock on to approve each one.";
      box.replaceChildren(h("p", { class: "muted" }, text));
      return;
    }
    box.replaceChildren(
      h(
        "ul",
        { class: "rows" },
        s.pending.map((p) =>
          h(
            "li",
            { class: "row stack" },
            h(
              "div",
              { class: "row-main" },
              h("strong", null, p.name),
              " ",
              muted(p.email),
              h(
                "div",
                { class: "sub" },
                muted(bi("요청 ID", "request id")),
                " ",
                mono(p.id),
                muted(" · " + ago(p.at)),
              ),
            ),
            h(
              "div",
              { class: "row-side" },
              h(
                "button",
                { class: "btn small primary", type: "button", onclick: () => openApprove(p) },
                "승인… · Approve…",
              ),
              " ",
              h(
                "button",
                { class: "btn small ghost", type: "button", onclick: () => deny(p) },
                "거부 · Deny",
              ),
            ),
          ),
        ),
      ),
      h(
        "p",
        { class: "muted sub" },
        "승인하려면 새 기기의 터미널에서 전체 지문을 읽어 붙여 넣어야 합니다. · To approve, read the full fingerprint on the new machine's terminal and paste it.",
      ),
    );
  }
  async function deny(p) {
    const ok = await confirmDlg(
      "요청 거부 · Deny request",
      p.name + " (" + p.email + ")의 요청을 버리고 24시간 동안 이 기기를 거부합니다.",
      "Drops the request from " +
        p.name +
        " (" +
        p.email +
        ") and refuses that machine for 24 hours.",
      "거부 · Deny",
    );
    if (!ok) return;
    try {
      await api("POST", "/api/deny", { fingerprint: p.id });
      hideError($("pending-err"));
    } catch (e) {
      if (e.kind === "session") return gate("none");
      showError($("pending-err"), "거부 실패", "Deny failed", e);
    }
    poll();
  }

  let approving = null;
  function openApprove(p) {
    approving = p;
    $("ap-question").textContent = state.approveQuestion;
    $("ap-facts").replaceChildren(
      h("dt", null, bi("이름", "Name")),
      h("dd", null, p.name),
      h("dt", null, bi("계정", "Account")),
      h("dd", null, p.email),
      h("dt", null, bi("요청 ID", "Request id")),
      h("dd", null, mono(p.id)),
      h("dt", null, bi("요청 시각", "Requested")),
      h("dd", null, stamp(p.at)),
    );
    $("ap-fp").value = "";
    $("ap-check").replaceChildren(muted("0 / 40"));
    $("ap-go").disabled = true;
    $("ap-go").hidden = false;
    $("ap-cancel").textContent = "취소 · Cancel";
    hideError($("ap-err"));
    $("ap-ok").hidden = true;
    $("dlg-approve").showModal();
    $("ap-fp").focus();
  }
  $("ap-fp").addEventListener("input", () => {
    const hex = hexOf($("ap-fp").value);
    const valid = /^[0-9A-F]*$/.test(hex);
    const idHex = approving ? hexOf(approving.id) : "";
    const parts = [muted(hex.length + " / 40")];
    if (!valid)
      parts.push(" ", h("span", { class: "danger-text" }, bi("0-9, A-F만", "0-9 and A-F only")));
    else if (hex.length >= 8 && !hex.startsWith(idHex))
      parts.push(
        " ",
        h(
          "span",
          { class: "danger-text" },
          bi("이 요청의 기기가 아님", "not this request's machine"),
        ),
      );
    else if (hex.length === 40)
      parts.push(" ", h("span", { class: "ok-text" }, bi("길이 맞음", "complete")));
    $("ap-check").replaceChildren(...parts);
    $("ap-go").disabled = !(valid && hex.length === 40 && hex.startsWith(idHex));
  });
  $("ap-go").addEventListener("click", async () => {
    const btn = $("ap-go");
    btn.disabled = true;
    btn.textContent = "멤버에게 알리는 중… · Telling members…";
    hideError($("ap-err"));
    try {
      const r = await api("POST", "/api/approve", { fingerprint: $("ap-fp").value });
      $("ap-ok").replaceChildren(
        h("strong", null, "승인됨 · Approved " + r.member.name),
        results(r.results),
      );
      $("ap-ok").hidden = false;
      btn.hidden = true;
      $("ap-cancel").textContent = "닫기 · Close";
      poll();
    } catch (e) {
      if (e.kind === "session") return gate("none");
      showError($("ap-err"), "승인 실패", "Approval failed", e);
      btn.disabled = false;
    }
    btn.textContent = "승인 · Approve";
  });

  $("invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("invite-btn");
    btn.disabled = true;
    hideError($("invite-err"));
    try {
      const r = await api("POST", "/api/invite", { ttlMs: Number($("invite-ttl").value) });
      $("invite-out").replaceChildren(
        h(
          "p",
          { class: "sub" },
          "한 번만 사용, " +
            clock(r.expiresAt) +
            "에 만료 · Single use, expires at " +
            clock(r.expiresAt) +
            ". 새 기기에서 실행 · Run on the new machine:",
        ),
        cmdBox(r.command),
        h("p", { class: "sub" }, "Windows PowerShell:"),
        cmdBox(r.windowsCommand),
      );
    } catch (e2) {
      if (e2.kind === "session") return gate("none");
      showError($("invite-err"), "초대 실패", "Could not create an invite", e2);
    }
    btn.disabled = false;
  });
  function renderLogin(s) {
    const out = $("login-out");
    if (!s.account) {
      out.replaceChildren(
        h(
          "p",
          { class: "muted" },
          "이 메시는 Google 계정에 연결되어 있지 않습니다. 먼저 이 기기에서 pen login을 실행해 연결하세요. · This mesh is not bound to a Google account. Run pen login on this machine to bind it first.",
        ),
        cmdBox("pen login"),
      );
      return;
    }
    const stuck = (s.unforgotten || []).map((u) =>
      h(
        "p",
        { class: "warn-text" },
        "로그인 서비스가 제거된 기기 " +
          (u.name || u.nodeId) +
          "을(를) 아직 새 기기에 보여 줍니다. 이 기기는 계정에 등록되지 않아 지울 수 없습니다: 여기서 pen login을 실행하거나 " +
          u.loginUrl +
          "/reset 에서 계정의 기기 목록을 초기화하세요. · The login service still offers the removed machine " +
          (u.name || u.nodeId) +
          " to new machines, and this machine is not registered with the account, so it cannot remove it: run pen login here, or reset the account's machine list at " +
          u.loginUrl +
          "/reset.",
      ),
    );
    out.replaceChildren(
      ...stuck,
      h(
        "p",
        { class: "sub" },
        s.locked
          ? "잠금이 켜져 있어 새 기기는 로그인 후 여기서 승인을 기다립니다. · Lock is on: the new machine waits for approval here after it signs in."
          : "잠금이 꺼져 있어 " +
              (s.account.email || "메시 계정") +
              "으로 로그인하면 바로 가입합니다. · Lock is off: it joins at once when it signs in as " +
              (s.account.email || "the mesh's account") +
              ".",
      ),
      cmdBox(s.loginCommand),
      h("p", { class: "sub" }, "Windows PowerShell:"),
      cmdBox(s.loginCommandWindows),
    );
  }

  const KINDS = {
    found: ["생성", "found"],
    admit: ["가입", "admit"],
    revoke: ["제거", "revoke"],
    leave: ["탈퇴", "leave"],
    name: ["이름 변경", "rename"],
  };
  function renderEvents(s) {
    const rows = s.events.map((e) => {
      let kind = KINDS[e.kind] || [e.kind, e.kind];
      if (e.kind === "lock") kind = e.on ? ["잠금 켬", "lock on"] : ["잠금 끔", "lock off"];
      if (e.kind === "account")
        kind = e.on ? ["계정 연결", "account bound"] : ["계정 해제", "account unbound"];
      let note = "";
      if (e.kind === "admit")
        note = e.via === "google" ? "Google " + (e.email || "") : bi("초대", "invite");
      if (e.compromised) note = h("strong", null, bi("유출됨", "compromised"));
      return h(
        "tr",
        null,
        h(
          "td",
          { class: "time", title: e.at > 1e11 ? stamp(e.at) : "" },
          e.at > 1e11 ? stamp(e.at) : "—",
        ),
        h("td", null, h("span", { class: "kind kind-" + e.kind }, bi(kind[0], kind[1]))),
        h("td", null, (e.who || []).join(", ")),
        h("td", null, e.by),
        h("td", null, note),
      );
    });
    $("events").tBodies[0].replaceChildren(...rows);
  }

  function confirmDlg(title, ko, en, yes) {
    const d = $("dlg-confirm");
    $("cf-h").textContent = title;
    $("cf-ko").textContent = ko;
    $("cf-en").textContent = en;
    $("cf-yes").textContent = yes;
    d.returnValue = "";
    d.showModal();
    return new Promise((resolve) =>
      d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true }),
    );
  }

  $("logout").addEventListener("click", async () => {
    try {
      await api("POST", "/api/logout");
    } catch {}
    dropSession();
    gate("out");
  });

  async function start() {
    const m = /^#t=([A-Za-z0-9_-]+)$/.exec(location.hash);
    if (m) {
      history.replaceState(null, "", location.pathname);
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), STATE_TIMEOUT_MS);
      try {
        const r = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: m[1] }),
          cache: "no-store",
          credentials: "omit",
          signal: ctl.signal,
        });
        if (r.ok) {
          const out = await r.json();
          if (!out.bearer || !out.server) throw new Error("not a pen dashboard");
          bearer = out.bearer;
          server = out.server;
          sessionStorage.setItem(KEY, bearer);
          sessionStorage.setItem(SERVER_KEY, server);
        } else if (!bearer) {
          return gate("used");
        }
      } catch {
        dropSession();
        return gate("gone");
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!bearer || !server) return gate("none");
    poll();
  }
  start();
})();
