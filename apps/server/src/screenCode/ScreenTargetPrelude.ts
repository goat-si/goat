import { MAX_BATCH_CALLS } from "./ScreenRunLimits.ts";

/**
 * The guest-side \`screen\` API a goat_screen_run cell sees. Apps and tabs share one Target shape
 * (observe, click, type, press, scroll, setValue, drag, waitFor, verify) over the host methods;
 * the snake_case globals and the older Target methods stay for cells written against them.
 */
export const screenTargetPrelude = (methods: ReadonlyArray<string>): string => String.raw`
var __screenValues = Object.create(null);
var __screenResults = [];
const __values = new Proxy(__screenValues, {
  set(target, key, value) {
    const json = JSON.stringify(value);
    if (typeof key !== 'string' || json === undefined || json.length > 65536)
      throw new TypeError('screen.values accepts bounded JSON only');
    target[key] = JSON.parse(json);
    return true;
  }
});
class ScreenError extends Error {
  constructor(code, message, nothingSent, host) {
    super(message);
    this.name = 'ScreenError';
    this.code = code;
    this.nothingSent = nothingSent;
    if (host)
      for (const key of ['callId', 'effectStarted', 'nextStep', 'safety', 'refused', 'detail', 'receipts'])
        if (host[key] !== undefined) this[key] = host[key];
  }
}
const __error = (raw) => {
  if (raw instanceof ScreenError) return raw;
  let host;
  try { host = typeof raw === 'string' ? JSON.parse(raw) : undefined; } catch (_) { host = undefined; }
  if (!host || typeof host.code !== 'string') return new ScreenError('refused', String(raw), true);
  const mayHaveLanded = host.effectStarted === true || (host.safety && host.safety.possibleCommit === true);
  const error = new ScreenError(host.code, host.message ?? host.nextStep ?? host.code, !mayHaveLanded, host);
  // An uncaught host failure reports this receipt verbatim, as the host gave it.
  Object.defineProperty(error, '__receipt', { value: String(raw) });
  return error;
};
const __remember = (entry) => {
  __screenResults.push(entry);
  if (__screenResults.length > 64) __screenResults.shift();
};
const __sendJson = async (method, json) => {
  let out;
  try { out = await __host(method, json); }
  catch (raw) { throw __error(raw); }
  return JSON.parse(out);
};
const __send = async (method, args) => __sendJson(method, JSON.stringify(args));
// Element input started without awaiting each call waits until the cell's code yields, then goes
// out as one batch group per run on a target (ScreenBatchGroups); any other call first sends what
// waits, so the cell's calls keep their order. Each call still gets its own reply. The runtime
// admits a group whole (__hostGroup) or refuses all of it before any goes out.
const __batchable = new Set(['click', 'right_click', 'type_text', 'set_value']);
let __queued = [];
const __flush = () => {
  const queued = __queued;
  __queued = [];
  for (let start = 0; start < queued.length;) {
    let end = start + 1;
    while (end < queued.length && end - start < ${MAX_BATCH_CALLS} && queued[end].arg.targetRef.id === queued[start].arg.targetRef.id) end++;
    const group = queued.slice(start, end);
    start = end;
    let jsons;
    try {
      jsons = group.map((entry, index) =>
        JSON.stringify([group.length > 1 ? { ...entry.arg, batch: { index, size: group.length } } : entry.arg]));
    } catch (raw) { for (const entry of group) entry.reject(__error(raw)); continue; }
    if (group.length > 1 && !__hostGroup(JSON.stringify(group.map((entry, index) => [entry.method, jsons[index]])))) {
      for (const entry of group) entry.reject(new ScreenError('refused', 'screen call refused', true));
      continue;
    }
    group.forEach((entry, index) => __sendJson(entry.method, jsons[index]).then(entry.resolve, entry.reject));
  }
};
const __reply = (method, args) => {
  if (__queued.length > 0) __flush();
  return __send(method, args);
};
const __enqueue = (method, arg) => new Promise((resolve, reject) => {
  if (__queued.length === 0) Promise.resolve().then(() => { if (__queued.length > 0) __flush(); });
  __queued.push({ method, arg, resolve, reject });
});
const __tabQuery = (query) =>
  typeof query === 'string' ? (/^[a-z][a-z0-9+.-]*:/i.test(query) ? { url: query } : { tabId: query }) : query;
const __call = async (method, arg) => (await __reply(method, [arg])).v;
const __checked = async (method, arg, queued = false) => {
  try { return await (queued ? __enqueue(method, arg) : __reply(method, [arg])); }
  catch (raw) {
    const error = __error(raw);
    __remember({ call: method, error: error.code, nothingSent: error.nothingSent });
    throw error;
  }
};
const __verdict = (reply) => (reply.c === 'confirmed' ? 'confirmed' : 'unverifiable');
const __keys = (key, tab) => {
  const parts = key === '+' ? ['+'] : key.split('+').filter((part) => part.length > 0);
  const last = parts.pop() ?? key;
  const names = tab
    ? { cmd: 'Meta', command: 'Meta', meta: 'Meta', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift' }
    : { cmd: 'command', command: 'command', meta: 'command', ctrl: 'control', control: 'control', alt: 'option', option: 'option', shift: 'shift' };
  const modifiers = parts.map((part) => {
    const name = names[part.toLowerCase()];
    if (!name) throw new ScreenError('invalid_argument', 'Unknown modifier ' + part + ' in ' + key, true);
    return name;
  });
  return { key: last, ...(modifiers.length ? { modifiers } : {}) };
};
const __legacy = (arg) =>
  arg !== null && typeof arg === 'object' && !Array.isArray(arg) &&
  ('ref' in arg || 'elementRef' in arg || 'point' in arg || 'x' in arg || 'selector' in arg || 'targetRef' in arg ||
    'sourceRef' in arg || 'deltaY' in arg || 'deltaX' in arg || 'mode' in arg || 'baseObservationId' in arg || 'urlIncludes' in arg || 'loadState' in arg);
const __inputs = new Set(['click', 'right_click', 'drag', 'scroll', 'select_text', 'set_value', 'press_key',
  'type_text', 'select', 'navigate_tab', 'reload_tab', 'back_tab', 'forward_tab', 'bring_to_front', 'launch_app', 'invoke_menu']);
const __target = (binding, note, owner) => {
  const ref = binding.targetRef ?? binding;
  const tab = ref.kind === 'tab';
  const seen = { observation: undefined, image: undefined };
  // Older call forms reach the host directly; any that sends input also ends the screenshot.
  const call = (method, arg = {}) => {
    if (__inputs.has(method)) seen.image = undefined;
    return __call(method, { ...arg, targetRef: ref });
  };
  const act = async (name, method, arg) => {
    // Input can change what is under a pixel, so screenshot points end with it; refs do not.
    seen.image = undefined;
    const reply = await __checked(method, { ...arg, targetRef: ref }, !tab && __batchable.has(method) && arg.elementRef !== undefined);
    const verdict = __verdict(reply);
    __remember({ call: name, verdict });
    return reply.v === undefined ? { verdict } : { verdict, result: reply.v };
  };
  const element = (target) => {
    const observation = seen.observation;
    if (!observation) throw new ScreenError('stale_reference', 'Observe before naming an element.', true);
    if (typeof target === 'number') {
      const found = observation.elements.find((item) => item.index === target);
      if (!found) throw new ScreenError('stale_reference', 'No [' + target + '] in the latest observe; observe again.', true);
      return found;
    }
    const name = typeof target === 'string' ? target : target.name;
    const role = typeof target === 'string' ? undefined : target.role;
    const fits = (item) => role === undefined || item.role.toLowerCase().includes(String(role).toLowerCase());
    let found = observation.elements.filter((item) => fits(item) && (name === undefined || item.name === name));
    if (found.length === 0 && name !== undefined)
      found = observation.elements.filter((item) => fits(item) && item.name.toLowerCase().includes(String(name).toLowerCase()));
    if (found.length !== 1)
      throw new ScreenError(found.length ? 'target_ambiguous' : 'target_missing',
        (found.length ? found.length + ' elements match ' : 'Nothing matches ') + JSON.stringify(target) + '; use a number from observe.', true);
    return found[0];
  };
  // A point is a pixel of the latest screenshot; input may move what is under it, so it ends there.
  const shot = () => {
    if (!seen.image) throw new ScreenError('invalid_argument', 'Points need a current screenshot: observe({screenshot:true}) first.', true);
    return seen.image;
  };
  const point = (target) => {
    const image = shot();
    if (!tab) return { x: target[0], y: target[1] };
    return { point: { observationId: image.observationId, regionId: image.regionId, x: target[0], y: target[1] } };
  };
  const aim = (target) => {
    if (Array.isArray(target)) return point(target);
    if (tab && typeof target === 'string') return { selector: target };
    const found = element(target);
    return tab ? { ref: found.ref } : { elementRef: found.ref };
  };
  const remember = (observation) => {
    if (observation && Array.isArray(observation.elements)) seen.observation = observation;
    if (observation && observation.image) seen.image = observation.image;
    return observation;
  };
  const observe = async (arg = {}) => {
    if (__legacy(arg)) return remember(await call(tab ? 'observe' : 'get_accessibility_tree', arg));
    const diff = arg.diff !== false && seen.observation !== undefined;
    const base = diff ? { mode: 'diff', baseObservationId: seen.observation.observationId } : {};
    const options = tab
      ? { ...base, ...(arg.screenshot ? { screenshot: true } : {}), ...(arg.interactiveOnly ? { interactiveOnly: true } : {}), ...(arg.fullPage ? { fullPage: true } : {}), ...(arg.scope ? { scope: arg.scope } : {}) }
      : base;
    let observation;
    try { observation = remember((await __reply(tab ? 'observe' : 'get_accessibility_tree', [{ ...options, targetRef: ref }])).v); }
    catch (raw) { throw __error(raw); }
    if (!tab && arg.screenshot) {
      try { seen.image = (await __reply('screenshot', [{ targetRef: ref }])).v; }
      catch (raw) { throw __error(raw); }
    }
    const { indexedText, ...rest } = observation;
    const shown = { text: indexedText, ...rest, ...(seen.image && arg.screenshot ? { image: seen.image } : {}) };
    // Cells written before text read indexedText; it is not enumerable, so results do not carry it twice.
    Object.defineProperty(shown, 'indexedText', { value: indexedText, enumerable: false });
    __remember({ call: 'observe', mode: shown.mode, text: String(indexedText).slice(0, 4000) });
    return shown;
  };
  const condition = (wanted, timeoutMs) => {
    const arg = timeoutMs === undefined ? {} : { timeoutMs };
    if (!tab) return { ...wanted, ...arg };
    if (__legacy(wanted)) return { ...wanted, ...arg };
    return {
      ...arg,
      ...(wanted.text === undefined ? {} : { text: wanted.text }),
      ...(wanted.url === undefined ? {} : { urlIncludes: wanted.url }),
      ...(wanted.load === undefined ? {} : { loadState: wanted.load }),
      ...(wanted.target === undefined ? {} : aim(wanted.target)),
    };
  };
  const wait = async (wanted, timeoutMs) => {
    const reply = await __checked('wait_for', { ...condition(wanted, timeoutMs), targetRef: ref });
    const met = tab ? reply.v && reply.v.status === 'met' : reply.v && reply.v.met === true;
    __remember({ call: 'waitFor', met });
    return { met, ...(reply.v && typeof reply.v === 'object' ? reply.v : {}) };
  };
  const common = {
    kind: ref.kind,
    identity: ref.id,
    environment: ref.environmentId,
    generation: ref.generation,
    ...(owner === undefined ? {} : { owner }),
    capabilities: tab
      ? ['observe', 'input', 'selectors', 'read', 'fetch', 'navigate', 'claim']
      : ['observe', 'input', 'points', 'menu', 'launch', 'screenshot'],
    targetRef: ref,
    ...(note === undefined ? {} : { note }),
    observe,
    click: (target = {}, options = {}) => {
      if (__legacy(target)) return call('click', target);
      if (tab && options.count !== undefined && options.count !== 1)
        throw new ScreenError('unsupported', 'Tabs click once per call.', true);
      return act('click', options.button === 'right' ? 'right_click' : 'click', {
        ...aim(target),
        ...(!tab && options.count !== undefined ? { count: options.count } : {}),
      });
    },
    type: (text, target) => {
      if (Array.isArray(target))
        throw new ScreenError('invalid_argument', 'Click the point first, then type without a target.', true);
      return act('type', 'type_text', { text, ...(target === undefined ? {} : aim(target)) });
    },
    press: async (key, target) => {
      if (target !== undefined) await common.click(target);
      return act('press', 'press_key', __keys(key, tab));
    },
    scroll: (target, direction, amount = 3) => {
      if (typeof direction !== 'string') return call('scroll', target ?? {});
      const sign = direction === 'up' || direction === 'left' ? -1 : 1;
      if (tab) {
        const delta = sign * amount * 100;
        return act('scroll', 'scroll', {
          ...(target === null || target === undefined ? {} : aim(target)),
          ...(direction === 'left' || direction === 'right' ? { deltaX: delta } : { deltaY: delta }),
        });
      }
      if (!Array.isArray(target) && target !== null && target !== undefined)
        throw new ScreenError('invalid_argument', 'App scroll needs a point [x, y] from a screenshot.', true);
      const image = shot();
      const at = Array.isArray(target) ? target : [Math.floor(image.pixelWidth / 2), Math.floor(image.pixelHeight / 2)];
      return act('scroll', 'scroll', { x: at[0], y: at[1], direction, amount });
    },
    setValue: (target, value) => {
      if (value === undefined) return call('set_value', target ?? {});
      if (Array.isArray(target))
        throw new ScreenError('invalid_argument', 'Name the field by number, selector or role and name; a point cannot hold a value.', true);
      return act('setValue', 'set_value', tab ? { ...aim(target), text: value } : { ...aim(target), value });
    },
    drag: (from, to) => {
      if (to === undefined) return call('drag', from ?? {});
      if (tab) {
        const source = aim(from);
        const target = aim(to);
        // A map or canvas drags between two screenshot points; an element and a point do not mix.
        if (source.point && target.point)
          return act('drag', 'drag', { point: source.point, toPoint: target.point });
        if (source.point || target.point) throw new ScreenError('unsupported', 'Drag between two elements or two points [x, y].', true);
        return act('drag', 'drag', {
          ...(source.ref ? { sourceRef: source.ref } : { sourceSelector: source.selector }),
          ...(target.ref ? { destinationRef: target.ref } : { destinationSelector: target.selector }),
        });
      }
      if (!Array.isArray(from) || !Array.isArray(to))
        throw new ScreenError('invalid_argument', 'App drag goes between points [x, y].', true);
      shot();
      return act('drag', 'drag', { from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] });
    },
    waitFor: (wanted = {}, options = {}) => wait(wanted, options.timeoutMs),
    verify: (wanted = {}) => wait(wanted, tab ? 250 : 0),
    rightClick: (arg = {}) => call('right_click', arg),
    selectText: (arg = {}) => call('select_text', arg),
    pressKey: (arg = {}) => call('press_key', arg),
    typeText: (arg = {}) => call('type_text', arg),
  };
  return Object.freeze(tab ? {
    ...common,
    status: () => call('tab_status'),
    read: (arg = {}) => call('read_page', arg),
    fetch: async (url, options = {}) => (await __checked('fetch_tab', { ...options, url, targetRef: ref })).v,
    claim: () => call('claim_tab'),
    keep: (reason = 'deliverable') => call('keep_tab', { reason }),
    goto: (url) => act('goto', 'navigate_tab', { url }),
    navigate: (url) => call('navigate_tab', { url }),
    reload: () => act('reload', 'reload_tab', {}),
    back: () => act('back', 'back_tab', {}),
    forward: () => act('forward', 'forward_tab', {}),
    close: () => call('close_tab'),
    select: (arg = {}) => call('select', arg),
  } : {
    ...common,
    menu: (path) => act('menu', 'invoke_menu', { path }),
    launch: () => act('launch', 'launch_app', {}),
    getWindowState: () => call('get_window_state'),
    verifyState: (arg = {}) => call('verify_state', arg),
    screenshot: async (arg = {}) => { const image = await call('screenshot', arg); seen.image = image; return image; },
    bringToFront: () => call('bring_to_front'),
    endForeground: () => call('end_foreground'),
  });
};
const __tab = (bound) => __target(bound, __note('site', String((bound.tab && bound.tab.url) ?? '')), bound.tab ? bound.tab.owner : undefined);
const __app = async (query) => {
  let wanted = query;
  const app = query.bundle_id ?? query.bundleId ?? query.name;
  if (query.window_id === undefined && query.windowId === undefined && app !== undefined) {
    const listed = await __call('list_apps', {});
    const pids = (listed && listed.apps ? listed.apps : []).filter((item) => item.bundle_id === app || item.name === app).map((item) => item.pid);
    if (pids.length !== 1) throw new ScreenError(pids.length ? 'target_ambiguous' : 'target_missing', 'Find ' + app + ' with screen.discover() and pass window_id.', true);
    const windows = await __call('list_windows', { pid: pids[0] });
    const own = (windows && windows.windows ? windows.windows : []).filter((item) => item.pid === pids[0]);
    if (own.length !== 1) throw new ScreenError(own.length ? 'target_ambiguous' : 'target_missing', app + ' has ' + own.length + ' windows; pass window_id from screen.discover().', true);
    wanted = { ...query, window_id: own[0].window_id };
  }
  return __target(await __call('bind_app', wanted), __note('app', String(app ?? '')));
};
globalThis.ScreenError = ScreenError;
globalThis.screen = Object.freeze({ values: __values, state: {},
  discover: async () => {
    const result = { apps: [], windows: [], tabs: [], unavailable: {} };
    try { result.apps = await __call('list_apps', {}); result.windows = await __call('list_windows', {}); }
    catch (error) { result.unavailable.desktop = String(error); }
    try { result.tabs = await __call('list_tabs', {}); }
    catch (error) { result.unavailable.browser = String(error); }
    return result;
  },
  app: async (query = {}) => __app(query),
  tab: async (query = {}) => __tab(await __call('select_tab', __tabQuery(query))),
  openTab: async (arg = {}) => __tab(await __call('open_tab', arg)),
  listTabs: () => __call('list_tabs', {}),
  ${methods.map((method) => `${method}: async (...args) => (await __reply(${JSON.stringify(method)}, args)).v`).join(",\n  ")}
});
globalThis.console = Object.freeze({ log: (...args) => __log(args.map(String).join(' ')) });
`;
