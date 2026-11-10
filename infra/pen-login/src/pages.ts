// Server-rendered pages: Korean and English on one page, one primary action each, no scripts.

const STYLE = `
:root{color-scheme:light dark;--fg:#1b1d21;--muted:#5b616b;--line:#d9dce1;--bg:#f7f7f5;--card:#fff;--accent:#1b1d21;--accent-fg:#fff;--warn-bg:#fff4e5;--warn-line:#f0c48a;--bad:#a1281e}
@media (prefers-color-scheme:dark){:root{--fg:#ecedef;--muted:#a3a8b1;--line:#363a41;--bg:#141518;--card:#1c1e22;--accent:#ecedef;--accent-fg:#141518;--warn-bg:#2d2416;--warn-line:#6b5225;--bad:#f08a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:30rem;margin:12vh auto 4rem;padding:0 1.25rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.75rem}
h1{font-size:1.25rem;margin:0 0 .25rem}
.en{color:var(--muted);margin:0}
p{margin:.75rem 0}
.mark{font-weight:600;letter-spacing:.02em;color:var(--muted);font-size:.8rem;margin-bottom:1.25rem}
label{display:block;font-weight:600;margin:1.25rem 0 .4rem}
input[type=text]{width:100%;font:600 1.5rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;padding:.6rem .75rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button{font:inherit;font-weight:600;border-radius:8px;padding:.7rem 1.1rem;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);width:100%;margin-top:1.25rem}
button.quiet{background:transparent;color:var(--fg);border-color:var(--line);margin-top:.6rem}
button.danger{background:var(--bad);border-color:var(--bad);color:#fff}
dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:1.25rem 0;font-size:.95rem}
dt{color:var(--muted)}dd{margin:0;word-break:break-word}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:8px;padding:.75rem .9rem;margin:1.25rem 0}
.error{color:var(--bad);font-weight:600}
.foot{margin-top:1.5rem;font-size:.85rem;color:var(--muted)}
a{color:inherit}
`;

let styleHash: Promise<string> | null = null;

async function cspStyleHash(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `'sha256-${btoa(binary)}'`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Text with a Korean line and an English line. */
interface Bilingual {
  readonly ko: string;
  readonly en: string;
}

function lines(text: Bilingual): string {
  return `<p>${escapeHtml(text.ko)}</p><p class="en" lang="en">${escapeHtml(text.en)}</p>`;
}

function heading(text: Bilingual): string {
  return `<h1>${escapeHtml(text.ko)}</h1><p class="en" lang="en">${escapeHtml(text.en)}</p>`;
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function row(key: string, label: Bilingual, value: string, mono = false): string {
  const cls = mono ? ' class="mono"' : "";
  return `<dt>${escapeHtml(label.ko)} · <span lang="en">${escapeHtml(label.en)}</span></dt><dd data-row="${key}"${cls}>${escapeHtml(value)}</dd>`;
}

export type View =
  | { readonly kind: "enter"; readonly csrf: string; readonly triesLeft?: number }
  | { readonly kind: "locked" }
  | { readonly kind: "expired" }
  | { readonly kind: "used" }
  | {
      readonly kind: "confirm";
      readonly csrf: string;
      readonly userCode: string;
      readonly name: string;
      readonly fingerprint: string;
      readonly email: string;
      readonly place: string;
      readonly time: string;
    }
  | { readonly kind: "done"; readonly name: string }
  | { readonly kind: "denied" }
  | { readonly kind: "resetStart"; readonly csrf: string }
  | {
      readonly kind: "resetConfirm";
      readonly csrf: string;
      readonly email: string;
      readonly meshId: string | null;
      readonly nodes: number;
    }
  | { readonly kind: "resetDone" }
  | { readonly kind: "error"; readonly reason: Bilingual }
  | { readonly kind: "limited" };

const AGAIN: Bilingual = {
  ko: "기기에서 pen login 을 다시 실행해 새 코드를 받으세요.",
  en: "Run pen login on the machine again to get a new code.",
};

function body(view: View): string {
  switch (view.kind) {
    case "enter": {
      const wrong =
        view.triesLeft === undefined
          ? ""
          : `<p class="error">코드가 맞지 않습니다. 남은 시도: ${view.triesLeft}</p><p class="en error" lang="en">That code didn't match. Tries left: ${view.triesLeft}</p>`;
      return `${heading({ ko: "기기 추가", en: "Add a machine" })}
${lines({ ko: "기기의 터미널에 표시된 8자리 코드를 입력하세요.", en: "Type the 8-character code shown in the machine's terminal." })}
${wrong}
<form method="post" action="/device">${csrfField(view.csrf)}
<label for="code">코드 · <span lang="en">Code</span></label>
<input type="text" id="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" required>
<button type="submit">계속 · <span lang="en">Continue</span></button></form>
<p class="foot">이 계정의 메시 등록을 지우려면 <a href="/reset">초기화</a>. · <span lang="en">To clear this account's mesh registration, <a href="/reset">reset it</a>.</span></p>`;
    }
    case "locked":
      return `${heading({ ko: "잘못된 코드가 너무 많습니다", en: "Too many wrong codes" })}
${lines({ ko: "10분 뒤에 터미널의 코드를 다시 입력하세요.", en: "Wait 10 minutes, then type the code from the terminal again." })}`;
    case "expired":
      return `${heading({ ko: "코드가 만료되었습니다", en: "This code has expired" })}${lines(AGAIN)}`;
    case "used":
      return `${heading({ ko: "이미 처리된 코드입니다", en: "This code was already used" })}${lines(AGAIN)}`;
    case "confirm":
      return `${heading({ ko: "이 기기를 추가할까요?", en: "Add this machine?" })}
<dl>
${row("code", { ko: "코드", en: "Code" }, view.userCode, true)}
${row("machine", { ko: "기기", en: "Machine" }, view.name)}
${row("fingerprint", { ko: "지문", en: "Fingerprint" }, view.fingerprint, true)}
${row("account", { ko: "계정", en: "Account" }, view.email)}
${row("place", { ko: "요청 위치", en: "Requested from" }, view.place)}
${row("time", { ko: "요청 시각", en: "Requested at" }, view.time)}
</dl>
<div class="warn">${lines({
        ko: "이 기기는 메시의 모든 기기에 대한 전체 권한을 받습니다. 터미널의 코드와 지문이 같고 직접 시작한 요청일 때만 추가하세요.",
        en: "This machine will get full access to every machine in your mesh. Add it only if you started this request and the code and fingerprint match your terminal.",
      })}</div>
<form method="post" action="/device/confirm">${csrfField(view.csrf)}
<button type="submit" name="action" value="approve">추가 · <span lang="en">Add machine</span></button>
<button type="submit" name="action" value="deny" class="quiet">내가 시작하지 않았습니다 · <span lang="en">I didn't start this</span></button></form>`;
    case "done":
      return `${heading({ ko: "기기를 추가했습니다", en: "Machine added" })}
${lines({ ko: `${view.name} 의 터미널로 돌아가세요. 나머지는 그곳에서 끝납니다.`, en: `Go back to the terminal on ${view.name}. pen login finishes there.` })}`;
    case "denied":
      return `${heading({ ko: "요청을 거부했습니다", en: "Request denied" })}
${lines({ ko: "기기는 추가되지 않았습니다. 다른 사람이 시작한 요청이었다면 이 창을 닫으면 됩니다.", en: "The machine was not added. If someone else started this request, you can close this page." })}`;
    case "resetStart":
      return `${heading({ ko: "계정 등록 초기화", en: "Reset this account's registration" })}
${lines({
  ko: "초기화하면 새 기기가 어느 메시에 합류할지 알려 주는 등록 정보가 지워집니다. 이미 있는 메시와 기기는 바뀌지 않습니다.",
  en: "Resetting clears the record that tells new machines which mesh to join. Existing meshes and machines do not change.",
})}
<form method="post" action="/reset">${csrfField(view.csrf)}
<button type="submit">Google로 로그인 · <span lang="en">Sign in with Google to continue</span></button></form>`;
    case "resetConfirm":
      return `${heading({ ko: "이 등록을 지울까요?", en: "Clear this registration?" })}
<dl>
${row("account", { ko: "계정", en: "Account" }, view.email)}
${row("mesh", { ko: "메시", en: "Mesh" }, view.meshId ?? "—", true)}
${row("nodes", { ko: "등록된 기기", en: "Registered machines" }, String(view.nodes))}
</dl>
${lines({ ko: "다음에 pen login 을 실행하는 기기가 메시를 새로 만들거나 연결합니다.", en: "The next machine that runs pen login will found or bind a mesh again." })}
<form method="post" action="/reset/confirm">${csrfField(view.csrf)}
<button type="submit" class="danger">초기화 · <span lang="en">Reset</span></button></form>`;
    case "resetDone":
      return `${heading({ ko: "초기화했습니다", en: "Registration cleared" })}
${lines({ ko: "이제 기기에서 pen login 을 실행하세요.", en: "Run pen login on a machine to set things up again." })}`;
    case "error":
      return `${heading({ ko: "문제가 생겼습니다", en: "Something went wrong" })}
${lines(view.reason)}
${lines({ ko: "코드 입력부터 다시 시작하세요.", en: "Start again from the code page." })}
<p><a href="/device">코드 입력 · <span lang="en">Enter a code</span></a></p>`;
    case "limited":
      return `${heading({ ko: "요청이 너무 많습니다", en: "Too many requests" })}
${lines({ ko: "1분 뒤에 다시 시도하세요.", en: "Wait a minute, then try again." })}`;
  }
}

/** A page response with its CSP; formOrigins lists origins a form here may end up at. */
export async function page(
  view: View,
  status: number,
  formOrigins: ReadonlyArray<string> = [],
): Promise<Response> {
  styleHash ??= cspStyleHash();
  const csp = [
    "default-src 'none'",
    `style-src ${await styleHash}`,
    `form-action 'self' ${formOrigins.join(" ")}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pen</title><style>${STYLE}</style></head><body><main><div class="card"><div class="mark">PEN</div>${body(view)}</div></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
  });
}
