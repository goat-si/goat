// @effect-diagnostics nodeBuiltinImport:off globalDate:off - page deadlines and hashing sit at the browser boundary.
import type { PreviewAutomationRead, PreviewAutomationReadInput } from "@goat/contracts";
import * as NodeCrypto from "node:crypto";
import type { CDPSession, Page } from "playwright-core";
import { MARKDOWN_FORMAT, normalizeText } from "./markdownFormat.ts";
import { attachNetworkTracker } from "./networkTracker.ts";
import { dottedPattern, maskSecrets, openReaders, tabCookies } from "./pageSecrets.ts";
import { HIDDEN_IN_DOCUMENT, readFailure, resolvePageScope, scopeHidden } from "./pageScope.ts";
import { withoutDataPayload } from "./ServerBrowserPage.ts";
import type { SessionControl } from "./SessionControl.ts";

const READ_SCRIPT = `async (scope, { settleMs, timeoutMs, markdown, scoped }) => {
  const document = scope.ownerDocument;
  const window = document.defaultView;
  const deadline = performance.now() + timeoutMs;
  let lastMutation = performance.now();
  let quietTimer, deadlineTimer;
  let observer;
  const roots = new Set();
  const observe = root => {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  let wake;
  const schedule = () => {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (document.readyState === 'complete') {
        if (performance.now() - lastMutation >= settleMs) wake();
        else schedule();
      }
    }, Math.max(0, settleMs - (performance.now() - lastMutation)));
  };
  const loaded = () => schedule();
  try {
    await new Promise(resolve => {
      wake = resolve;
      observer = new window.MutationObserver(() => { lastMutation = performance.now(); schedule(); });
      observe(scope);
      const pending = [scope];
      let count = 0;
      while (pending.length && count++ < 200000 && performance.now() < deadline) {
        const element = pending.pop();
        if (element.shadowRoot) { observe(element.shadowRoot); for (const child of element.shadowRoot.children) if (pending.length + count < 200000) pending.push(child); }
        if (element.localName === 'iframe') {
          try { const body = element.contentDocument && element.contentDocument.body; if (body) { observe(body); pending.push(body); } } catch {}
        }
        for (const child of element.children) if (pending.length + count < 200000) pending.push(child);
      }
      window.addEventListener('load', loaded);
      deadlineTimer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
      schedule();
    });
    const domChanging = performance.now() - lastMutation < settleMs;
    const loading = document.readyState !== 'complete';
    let collapsedCount = 0, omittedFrames = 0, nodes = 0, truncatedRender = false;
    const formatNode = ${MARKDOWN_FORMAT};
    const hiddenInDocument = ${HIDDEN_IN_DOCUMENT};
    const skipped = new Set(['script','style','template','noscript','input','textarea','select','option','head']);
    const hrefOf = element => {
      try {
        const url = new URL(element.getAttribute('href') || '', element.ownerDocument.baseURI);
        if (!['http:','https:','mailto:'].includes(url.protocol)) return '';
        for (const key of [...url.searchParams.keys()]) if (/token|secret|passw|session|cookie|credential|authoriz|^auth$|api[-_]?key|csrf|xsrf/i.test(key)) url.searchParams.set(key, 'redacted');
        return url.href;
      } catch { return ''; }
    };
    const renderDeadline = performance.now() + Math.min(250, timeoutMs);
    const render = (node, depth = 0, pre = false) => {
      if (++nodes > 200000 || depth > 512 || performance.now() > renderDeadline) { truncatedRender = true; return ''; }
      if (node.nodeType === 3) return pre ? node.nodeValue : node.nodeValue.replace(/\\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.localName;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      if (skipped.has(tag) || node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return '';
      if (node.getAttribute('aria-expanded') === 'false') collapsedCount++;
      if (tag === 'details' && !node.hasAttribute('open')) {
        collapsedCount++;
        const summary = [...node.children].find(child => child.localName === 'summary');
        return summary ? render(summary, depth + 1) : '';
      }
      if (tag === 'iframe') {
        try {
          const frame = node.contentDocument;
          if (!frame || !frame.body) { omittedFrames++; return ''; }
          return '\\n\\n[frame: ' + (node.title || frame.title || 'untitled') + ']\\n' + render(frame.body, depth + 1);
        } catch { omittedFrames++; return ''; }
      }
      if (tag === 'br') return '\\n';
      if (tag === 'img') return (node.getAttribute('alt') || '').trim();
      const children = node.shadowRoot ? node.shadowRoot.childNodes : tag === 'slot' && node.assignedNodes().length ? node.assignedNodes() : node.childNodes;
      let inner = '';
      for (const child of children) {
        if (nodes >= 200000 || performance.now() > renderDeadline) { truncatedRender = true; break; }
        inner += render(child, depth + 1, pre || tag === 'pre');
      }
      if (tag === 'pre') return markdown ? '\\n\\n~~~\\n' + inner.replace(/\\n+$/, '') + '\\n~~~\\n\\n' : '\\n\\n' + inner + '\\n\\n';
      return formatNode(node, inner, markdown, hrefOf);
    };
    return { url: document.location.href, title: document.title, text: scoped && hiddenInDocument(scope) ? '' : render(scope), loading, domChanging, collapsedCount, omittedFrames, truncatedRender };
  } finally {
    if (observer) observer.disconnect();
    clearTimeout(quietTimer);
    clearTimeout(deadlineTimer);
    window.removeEventListener('load', loaded);
  }
}`;

type Rendered = {
  url: string;
  title: string;
  text: string;
  loading: boolean;
  domChanging: boolean;
  collapsedCount: number;
  omittedFrames: number;
  truncatedRender: boolean;
};

const cap = (text: string) =>
  text.length > 2048 ? `${text.slice(0, boundary(text, 2047))}…` : text;
const boundary = (text: string, end: number) =>
  end > 0 &&
  end < text.length &&
  /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
  /[\uDC00-\uDFFF]/.test(text[end] ?? "")
    ? end - 1
    : end;

const pageResult = (
  fullText: string,
  metadata: Omit<PreviewAutomationRead, "text" | "nextOffset">,
  input: PreviewAutomationReadInput,
): PreviewAutomationRead => {
  const start = metadata.offset;
  const result = (end: number): PreviewAutomationRead => ({
    ...metadata,
    text: fullText.slice(start, end),
    nextOffset: end < fullText.length ? end : null,
  });
  const maxBytes = input.maxBytes ?? 32_000;
  if (Buffer.byteLength(JSON.stringify(result(start))) > maxBytes)
    throw readFailure("output_limit");
  let low = start,
    high = Math.min(fullText.length, start + (input.maxChars ?? 40_000));
  if (boundary(fullText, high) === start && high < fullText.length) high++;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(result(boundary(fullText, mid)))) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const end = boundary(fullText, low);
  if (end === start && start < fullText.length) throw readFailure("output_limit");
  return result(end);
};

export const pageRead = (
  page: Page,
  cdp: CDPSession,
  control: Pick<SessionControl, "observe">,
  input: PreviewAutomationReadInput,
): Promise<PreviewAutomationRead> =>
  control.observe(async () => {
    if ((input.offset ?? 0) > 0 && !input.revision) throw readFailure("revision_required");
    const tracker = attachNetworkTracker(page);
    const deadline = Date.now() + (input.timeoutMs ?? 10_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const documentId = tracker.state().documentId;
      const initialUrl = page.url();
      try {
        const { read } = await openReaders(page, cdp);
        const before = await read().catch(() => {
          throw readFailure("pageChanged");
        });
        if (before.some((values) => values === undefined)) throw readFailure("pageChanged");
        const cookiesBefore = await tabCookies(page);
        let rendered: Rendered;
        for (;;) {
          const scope = await resolvePageScope(page, input.scope);
          const args = {
            settleMs: input.settleMs ?? 600,
            timeoutMs: Math.max(1, deadline - Date.now()),
            markdown: input.format !== "text",
            scoped: input.scope !== undefined,
          };
          const render = new Function(
            "scope",
            `return (${READ_SCRIPT})(scope, ${JSON.stringify(args)})`,
          ) as (scope: unknown) => Promise<Rendered>;
          rendered = await scope.evaluate(render);
          // Frame elements embedding the scope live in other documents; check them after the read.
          if (input.scope && (await scopeHidden(scope))) rendered = { ...rendered, text: "" };
          if (tracker.state().network !== "busy" || Date.now() >= deadline) break;
          await tracker.changed(Math.max(1, deadline - Date.now()));
        }
        const head = (await page.evaluate(
          `({ url: location.href, title: document.title, loading: document.readyState !== "complete" })`,
        )) as Pick<Rendered, "url" | "title" | "loading">;
        rendered = { ...rendered, ...head, loading: rendered.loading || head.loading };
        const after = await read(before).catch(() => {
          throw readFailure("pageChanged");
        });
        if (JSON.stringify(before) !== JSON.stringify(after)) throw readFailure("pageChanged");
        const network = tracker.state();
        if (network.documentId !== documentId || page.url() !== initialUrl)
          throw readFailure("pageChanged");
        const cookies = [...cookiesBefore, ...(await tabCookies(page))];
        const mask = maskSecrets(dottedPattern(after.flatMap((values) => values ?? [])), cookies);
        const fullText = mask(normalizeText(rendered.text));
        const format = input.format ?? "markdown";
        const revision = NodeCrypto.createHash("sha256")
          .update(JSON.stringify([documentId, initialUrl, input.scope ?? null, format, fullText]))
          .digest("hex")
          .slice(0, 24);
        const changed = input.revision !== undefined && input.revision !== revision;
        const offset = changed
          ? 0
          : boundary(fullText, Math.min(input.offset ?? 0, fullText.length));
        const settled = !rendered.loading && !rendered.domChanging && network.network !== "busy";
        return pageResult(
          fullText,
          {
            url: cap(mask(withoutDataPayload(rendered.url))),
            title: cap(mask(rendered.title)),
            urlTruncated: mask(withoutDataPayload(rendered.url)).length > 2048,
            titleTruncated: mask(rendered.title).length > 2048,
            format,
            offset,
            totalChars: fullText.length,
            revision,
            changed,
            settled,
            network: network.network,
            pendingRequests: network.pendingRequests,
            pending: {
              network: network.pendingRequests,
              domChanging: rendered.domChanging,
              loading: rendered.loading,
            },
            collapsedCount: rendered.collapsedCount,
            omittedFrames: rendered.omittedFrames,
            truncatedRender: rendered.truncatedRender,
            scopeFound: true,
            ...(!settled
              ? {
                  next: "Still rendering: wait (goat_preview_wait text/selector) or call goat_preview_read again.",
                }
              : {}),
          },
          input,
        );
      } catch (cause) {
        if (tracker.state().documentId === documentId && page.url() === initialUrl) throw cause;
        if (attempt === 1 || Date.now() >= deadline) throw readFailure("pageChanged");
        await page
          .waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) })
          .catch(() => {
            throw readFailure("pageChanged");
          });
      }
    }
    throw readFailure("pageChanged");
  });
