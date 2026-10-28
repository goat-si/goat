/** Synthetic sites the secret-fill tests route every request to. */
export const PAGES: Record<string, string> = {
  "https://login.test/": [
    "<title>Sign in</title>",
    '<input id="user" aria-label="Email"><input id="pw" type="password" aria-label="Password">',
    '<p id="echo"></p>',
    "<script>document.getElementById('pw').addEventListener('input', (event) => {",
    "  console.log('typed ' + event.target.value);",
    "  document.getElementById('echo').textContent = 'you typed ' + event.target.value;",
    "});</script>",
  ].join(""),
  "https://login.test/focus": '<title>Focus</title><input id="pw" type="password">',
  "https://login.test/framed":
    '<title>Framed</title><iframe id="auth" src="https://auth.test/frame"></iframe>' +
    '<iframe id="sandboxed" sandbox="allow-scripts" src="https://auth.test/frame"></iframe>',
  "https://auth.test/frame": '<input id="pw" type="password" aria-label="Password">',
  "https://other.test/": '<title>Other</title><input id="pw" type="password">',
  "https://login.test/next": "<title>Next</title><p>Signed in</p>",
  "https://login.test/form": [
    "<title>Sign in</title>",
    '<form method="post" action="https://login.test/welcome">',
    '<input id="user" name="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
    "<script>document.getElementById('pw').addEventListener('input', (event) =>",
    "  localStorage.setItem('typed', event.target.value));</script>",
  ].join(""),
  "https://login.test/mention": [
    "<p>Welcome back jun@example.com</p><form>",
    '<input id="user" autocomplete="username" value="wrong@example.com">',
    '<input id="pw" type="password"></form>',
  ].join(""),
  "https://login.test/echo-error": [
    '<form><input id="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" type="password"><p role="alert" id="err"></p></form>',
    "<script>document.getElementById('pw').addEventListener('input', (event) => {",
    "  document.getElementById('err').textContent = 'x'.repeat(195) + event.target.value;",
    "});</script>",
  ].join(""),
  "https://login.test/form-denied": [
    '<form method="post" action="https://login.test/denied">',
    '<input id="user" name="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
  ].join(""),
  "https://login.test/denied":
    '<title>Denied</title><p role="alert">That password is not right for jun@example.com.</p>',
  "https://login.test/opens-blank": [
    '<form><input id="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" type="password"></form>',
    "<script>window.copyToPopup = () => { const popup = window.open('about:blank');",
    "  popup.document.body.textContent = document.getElementById('pw').value; };</script>",
  ].join(""),
  "https://login.test/submits-on-input": [
    '<form><input id="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" type="password"></form>',
    "<script>document.getElementById('pw').addEventListener('input', (event) =>",
    "  fetch('https://login.test/api', { method: 'POST', body: 'pw=' + event.target.value }));",
    "</script>",
  ].join(""),
  "https://login.test/shadow": [
    "<p>Welcome back jun@example.com</p><div id='host'></div><script>",
    "const root = document.getElementById('host').attachShadow({ mode: 'open' });",
    'root.innerHTML = \'<input id="user" autocomplete="username" value="wrong@example.com">\' +',
    '  \'<input id="pw" type="password">\';</script>',
  ].join(""),
  "https://login.test/framed-blank":
    '<iframe id="auth" src="https://auth.test/blank-user"></iframe>',
  "https://auth.test/blank-user":
    '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>',
  "https://login.test/blank-user":
    '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>',
  "https://login.test/welcome": [
    "<title>Welcome</title><p>Signed in as jun@example.com</p><canvas id='c'></canvas>",
    "<script>const c = document.getElementById('c').getContext('2d');",
    "c.fillText(localStorage.getItem('typed') || '', 10, 10);</script>",
  ].join(""),
  "https://login.test/two":
    '<title>Two</title><input id="pw" type="password"><input id="pw2" type="password">',
  "https://login.test/step":
    '<p>Continue as jun@example.com.</p><input id="pw" type="password" aria-label="Password">',
  "https://login.test/step-other":
    '<p>Continue as not-jun@example.com</p><input id="pw" type="password" aria-label="Password">',
  "https://login.test/blank-submit": [
    '<form method="post" action="https://login.test/next">',
    '<input id="user" name="user" autocomplete="username">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
  ].join(""),
  "https://login.test/cancelled-then-other": [
    '<form id="a" method="post" action="https://login.test/welcome">',
    '<input id="user" name="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
    "<script>document.getElementById('a').addEventListener('submit', (e) => e.preventDefault());",
    "window.sendOther = () => { const f = document.createElement('form'); f.method = 'post';",
    "  f.action = 'https://login.test/welcome'; const i = document.createElement('input');",
    "  i.name = 'pw'; i.value = document.getElementById('pw').value; f.append(i);",
    "  document.body.append(f); f.submit(); };</script>",
  ].join(""),
};
