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
      for (const key of ['callId', 'effectStarted', 'nextStep', 'safety', 'refused', 'detail', 'evidence', 'receipts'])
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
const __winPt = (arg) =>
  arg !== null && typeof arg === 'object' && !Array.isArray(arg) &&
  Array.isArray(arg.window) && arg.window.length === 2;
const __legacy = (arg) =>
  arg !== null && typeof arg === 'object' && !Array.isArray(arg) && !__winPt(arg) &&
  ('ref' in arg || 'elementRef' in arg || 'point' in arg || 'x' in arg || 'selector' in arg || 'targetRef' in arg ||
    'sourceRef' in arg || 'deltaY' in arg || 'deltaX' in arg || 'mode' in arg || 'baseObservationId' in arg || 'urlIncludes' in arg || 'loadState' in arg);
const __pointerMethods = new Set(['click', 'right_click', 'drag', 'scroll', 'move_cursor']);
const __inputs = new Set(['click', 'right_click', 'drag', 'scroll', 'select_text', 'set_value', 'press_key',
  'type_text', 'select', 'navigate_tab', 'reload_tab', 'back_tab', 'forward_tab', 'bring_to_front', 'launch_app', 'invoke_menu']);
const __target = (binding, note, owner, extraProps = {}) => {
  let ref = binding.targetRef ?? binding;
  const tab = ref.kind === 'tab';
  const seen = { observation: undefined, image: undefined, replaced: false };
  // Older call forms reach the host directly; tab input ends the tab screenshot, app points stay usable.
  const call = (method, arg = {}) => {
    if (tab && __inputs.has(method)) seen.image = undefined;
    const withRegion =
      !tab &&
      __pointerMethods.has(method) &&
      seen.image &&
      arg &&
      typeof arg === 'object' &&
      ('x' in arg || 'from_x' in arg) &&
      !('regionId' in arg) &&
      !('coordinate_space' in arg)
        ? { ...arg, regionId: seen.image.regionId }
        : arg;
    return __call(method, { ...withRegion, targetRef: ref });
  };
  const act = async (name, method, arg) => {
    if (tab) seen.image = undefined;
    const reply = await __checked(method, { ...arg, targetRef: ref }, !tab && __batchable.has(method) && arg.elementRef !== undefined);
    const verdict = __verdict(reply);
    __remember({ call: name, verdict });
    if (reply.v === undefined) return { verdict };
    const extra =
      reply.v && typeof reply.v === 'object'
        ? {
            ...('point' in reply.v ? { point: reply.v.point } : {}),
            ...('hit' in reply.v ? { hit: reply.v.hit } : {}),
          }
        : {};
    return { verdict, ...extra, result: reply.v };
  };
  const element = (target) => {
    const observation = seen.observation;
    if (!observation)
      throw new ScreenError(
        'stale_reference',
        typeof target === 'number' ? 'Numbers come from observe(); call it first.' : 'Observe before naming an element.',
        true,
      );
    if (typeof target === 'number') {
      const found = observation.elements.find((item) => item.index === target);
      if (!found) throw new ScreenError('stale_reference', 'No [' + target + '] in the latest observe; observe again.', true);
      return found;
    }
    // An accessibility id is exact and the same in every language.
    if (typeof target === 'object' && target !== null && target.id !== undefined) {
      const byId = observation.elements.filter((item) => item.id === String(target.id));
      if (byId.length !== 1)
        throw new ScreenError(byId.length ? 'target_ambiguous' : 'target_missing',
          (byId.length ? byId.length + ' elements have ' : 'Nothing has ') + 'id ' + JSON.stringify(target.id) + '; use a number from observe.', true);
      return byId[0];
    }
    const name = typeof target === 'string' ? target : target.name;
    const role = typeof target === 'string' ? undefined : target.role;
    const fits = (item) => role === undefined || item.role.toLowerCase().includes(String(role).toLowerCase());
    let found = observation.elements.filter((item) => fits(item) && (name === undefined || item.name === name));
    if (found.length === 0 && name !== undefined)
      found = observation.elements.filter((item) => fits(item) && item.name.toLowerCase().includes(String(name).toLowerCase()));
    // An element with no name of its own, such as a cell or a generic box, is found by its text.
    if (found.length === 0 && name !== undefined)
      found = observation.elements.filter((item) => fits(item) && String(item.text ?? '').toLowerCase().includes(String(name).toLowerCase()));
    if (found.length !== 1)
      throw new ScreenError(found.length ? 'target_ambiguous' : 'target_missing',
        (found.length ? found.length + ' elements match ' : 'Nothing matches ') + JSON.stringify(target) + '; use a number from observe.', true);
    return found[0];
  };
  const shot = () => {
    if (!seen.image && seen.replaced)
      throw new ScreenError('stale_reference', 'The window this screenshot showed was replaced; take a new screenshot.', true);
    if (!seen.image)
      throw new ScreenError(
        'invalid_argument',
        tab
          ? 'Points need a current screenshot: observe({screenshot:true}) first.'
          : '[x, y] are screenshot pixels and this cell has no screenshot; use { window: [x, y] } window points, or take a screenshot.',
        true,
      );
    return seen.image;
  };
  const point = (target) => {
    if (__winPt(target)) {
      if (tab) throw new ScreenError('invalid_argument', 'Tabs use [x, y] viewport pixels.', true);
      return { x: target.window[0], y: target.window[1], coordinate_space: 'window_points' };
    }
    const image = shot();
    if (!tab) return { x: target[0], y: target[1], regionId: image.regionId };
    return { point: { observationId: image.observationId, regionId: image.regionId, x: target[0], y: target[1] } };
  };
  const aim = (target) => {
    if (Array.isArray(target) || __winPt(target)) return point(target);
    if (tab && typeof target === 'string') return { selector: target };
    const found = element(target);
    return tab ? { ref: found.ref } : { elementRef: found.ref };
  };
  const needsImplicitObserve = (target) =>
    !tab &&
    !seen.observation &&
    target !== null &&
    target !== undefined &&
    typeof target !== 'number' &&
    !Array.isArray(target) &&
    !__winPt(target) &&
    !__legacy(target) &&
    (typeof target === 'string' || (typeof target === 'object' && ('name' in target || 'role' in target || 'id' in target)));
  let implicitRead;
  const ensureObserved = () => {
    if (seen.observation) return Promise.resolve();
    if (!implicitRead) implicitRead = observe().finally(() => { implicitRead = undefined; });
    return implicitRead;
  };
  const remember = (observation) => {
    if (observation && observation.targetRef && observation.targetRef.id === ref.id && observation.targetRef.generation > ref.generation) {
      ref = observation.targetRef;
      if (seen.image) { seen.image = undefined; seen.replaced = true; }
    }
    if (observation && Array.isArray(observation.elements)) seen.observation = observation;
    if (observation && observation.image) { seen.image = observation.image; seen.replaced = false; }
    return observation;
  };
  const observe = async (arg = {}) => {
    if (__legacy(arg)) return remember(await call(tab ? 'observe' : 'get_accessibility_tree', arg));
    const diff = arg.diff !== false && seen.observation !== undefined;
    const page = !tab && arg.after !== undefined;
    const base = diff ? { mode: 'diff', baseObservationId: seen.observation.observationId } : {};
    const options = tab
      ? { ...base, ...(arg.screenshot ? { screenshot: true } : {}), ...(arg.interactiveOnly ? { interactiveOnly: true } : {}), ...(arg.fullPage ? { fullPage: true } : {}), ...(arg.scope ? { scope: arg.scope } : {}) }
      : page ? { after: arg.after, ...(seen.observation ? { baseObservationId: seen.observation.observationId } : {}) }
      : arg.query ? { mode: 'query', query: arg.query }
      : { ...base, ...(arg.interactiveOnly ? { interactiveOnly: true } : {}) };
    let observation;
    try {
      const value = (await __reply(tab ? 'observe' : 'get_accessibility_tree', [{ ...options, targetRef: ref }])).v;
      observation = page ? value : remember(value);
      // A page's elements join the read it continues, so numbers and names from every page resolve.
      if (page && seen.observation && value && Array.isArray(value.elements))
        seen.observation = { ...seen.observation, elements: [...seen.observation.elements, ...value.elements] };
    }
    catch (raw) { throw __error(raw); }
    if (!tab && arg.screenshot) {
      try { seen.image = (await __reply('screenshot', [{ targetRef: ref }])).v; seen.replaced = false; }
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
      // {role, name} waits for an element that may not exist yet, so it names it by role.
      ...(wanted.target !== undefined || wanted.role === undefined
        ? {}
        : { selector: 'role=' + String(wanted.role) + (wanted.name === undefined ? '' : '[name=' + JSON.stringify(String(wanted.name)) + ' s]') }),
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
    ...(tab && binding.tab && binding.tab.tabId !== undefined ? { tabId: binding.tab.tabId } : {}),
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
      const run = () =>
        act('click', options.button === 'right' ? 'right_click' : 'click', {
          ...aim(target),
          ...(!tab && options.count !== undefined ? { count: options.count } : {}),
          ...(!tab && options.send === true ? { send: true } : {}),
          ...(!tab && options.action !== undefined ? { action: options.action } : {}),
        });
      return needsImplicitObserve(target) ? ensureObserved().then(run) : run();
    },
    type: (text, target, options = {}) => {
      if (Array.isArray(target) || __winPt(target))
        throw new ScreenError('invalid_argument', 'Click the point first, then type without a target.', true);
      const run = () =>
        act('type', 'type_text', {
          text,
          ...(target === undefined ? {} : aim(target)),
          ...(!tab && options && options.replace === true ? { replace: true } : {}),
          ...(!tab && options && options.send === true ? { send: true } : {}),
        });
      return needsImplicitObserve(target) ? ensureObserved().then(run) : run();
    },
    press: async (key, target, options = {}) => {
      const targetIsSendOpts =
        target !== null && typeof target === 'object' && !Array.isArray(target) &&
        'send' in target && !('name' in target) && !('role' in target) && !('id' in target) && !__legacy(target);
      const actualTarget = targetIsSendOpts ? undefined : target;
      const actualOpts = targetIsSendOpts ? target : (options ?? {});
      if (!tab && (Array.isArray(actualTarget) || __winPt(actualTarget)))
        throw new ScreenError('invalid_argument', 'Click the point first, then press the key without a target.', true);
      if (needsImplicitObserve(actualTarget)) await ensureObserved();
      if (tab && actualTarget !== undefined) await common.click(actualTarget);
      return act('press', 'press_key', {
        ...__keys(key, tab),
        ...(!tab && actualTarget !== undefined ? aim(actualTarget) : {}),
        ...(!tab && actualOpts && actualOpts.send === true ? { send: true } : {}),
      });
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
      const run = () => {
        if (target === null || target === undefined)
          return act('scroll', 'scroll', { scrollCenter: true, direction, amount });
        return act('scroll', 'scroll', { ...aim(target), direction, amount });
      };
      return needsImplicitObserve(target) ? ensureObserved().then(run) : run();
    },
    setValue: (target, value) => {
      if (value === undefined) return call('set_value', target ?? {});
      if (Array.isArray(target) || __winPt(target))
        throw new ScreenError('invalid_argument', 'Name the field by number, selector or role and name; a point cannot hold a value.', true);
      const run = () =>
        act('setValue', 'set_value', tab ? { ...aim(target), text: value } : { ...aim(target), value });
      return needsImplicitObserve(target) ? ensureObserved().then(run) : run();
    },
    drag: (from, to, options = {}) => {
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
      const run = () =>
        act('drag', 'drag', {
          fromEnd: aim(from),
          toEnd: aim(to),
          ...(options && options.send === true ? { send: true } : {}),
        });
      return needsImplicitObserve(from) || needsImplicitObserve(to)
        ? ensureObserved().then(run)
        : run();
    },
    // The timeout comes as a number, waitFor(c, 5000), or as options, waitFor(c, {timeoutMs: 5000}).
    waitFor: (wanted = {}, options = {}) => wait(wanted, typeof options === 'number' ? options : options.timeoutMs),
    verify: (wanted = {}) => wait(wanted, tab ? 250 : 0),
    rightClick: (arg = {}) => call('right_click', arg),
    selectText: (arg = {}) => call('select_text', arg),
    pressKey: (arg = {}) => call('press_key', arg),
    typeText: (arg = {}) => call('type_text', arg),
  };
  const surface = tab ? {
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
    ...extraProps,
    menu: (path, options = {}) => act('menu', 'invoke_menu', { path, ...(options && options.send === true ? { send: true } : {}) }),
    launch: () => act('launch', 'launch_app', {}),
    getWindowState: () => call('get_window_state'),
    verifyState: (arg = {}) => call('verify_state', arg),
    screenshot: async (arg = {}) => { const image = await call('screenshot', arg); seen.image = image; seen.replaced = false; return image; },
    bringToFront: () => call('bring_to_front'),
    endForeground: () => call('end_foreground'),
  };
  Object.defineProperties(surface, {
    generation: { get: () => ref.generation, enumerable: true },
    targetRef: { get: () => ref, enumerable: true },
  });
  return Object.freeze(surface);
};
const __tab = (bound) => __target(bound, __note('site', String((bound.tab && bound.tab.url) ?? '')), bound.tab ? bound.tab.owner : undefined);
const __appTarget = (bound, key, launched, windowId) =>
  __target(bound, __note('app', String(key ?? '')), undefined, { launched, windowId });
// list_windows with a pid answers every layer; menu bar items and slivers are not windows to bind.
// It also keeps windows an app closed but still holds, which look like minimized ones: off screen.
const __own = (listed, pid) => (listed && listed.windows ? listed.windows : []).filter((item) =>
  item.pid === pid && (item.layer === undefined || item.layer === 0) &&
  !(item.bounds && (item.bounds.width <= 1 || item.bounds.height <= 1)));
// Without window_id: an app running with one window on screen binds it and nothing launches;
// several windows or processes are ambiguous, and windows all off screen are named, not guessed.
// An app with no window, closed or running, is launched (reopened when running) and its first
// window bound in that one launch_app call.
const __app = async (query) => {
  const windowId = query.window_id ?? query.windowId;
  const bundle = query.bundle_id ?? query.bundleId;
  const { name, path } = query;
  if ((windowId !== undefined && path === undefined) || (bundle === undefined && name === undefined && path === undefined))
    return __appTarget(await __call('bind_app', query), bundle ?? name, false, windowId);
  const listed = await __call('list_apps', {});
  // A reply cut at the channel's cap lists nothing: that is not "not running", so nothing launches.
  if (!listed || !Array.isArray(listed.apps))
    throw new ScreenError('target_missing', 'The app list came back incomplete, so whether ' + (bundle ?? name ?? path) + ' runs is unknown and nothing was launched. Pass window_id from screen.discover().', true);
  const rows = listed.apps;
  let id = bundle;
  let copyName;
  if (path !== undefined) {
    const copy = rows.find((item) => item.launch_path === path);
    if (!copy)
      throw new ScreenError('invalid_argument', 'list_apps does not list ' + path + '; another copy of that app may be running. Pass bundle_id to use the running copy.', true);
    id = copy.bundle_id ?? id;
    copyName = copy.name;
  }
  if (id === undefined && name !== undefined) {
    // A name stands for one app only when the rows it matches share one bundle id.
    const ids = [...new Set(rows.filter((item) => item.name === name && item.bundle_id).map((item) => item.bundle_id))];
    if (ids.length > 1)
      throw new ScreenError('target_ambiguous', name + ' names ' + ids.length + ' apps (' + ids.join(', ') + '); pass bundle_id.', true);
    // A process listed under that name without an id may be another app: the name alone cannot choose.
    const unnamed = rows.filter((item) => item.pid > 0 && item.running !== false && !item.bundle_id && item.name === name);
    if (ids.length === 1 && unnamed.length > 0)
      throw new ScreenError('target_ambiguous', name + ' is ' + ids[0] + ' and also a process listed without an id (pid ' + unnamed.map((item) => item.pid).join(', ') + '); pass bundle_id, or window_id from screen.discover() with name.', true);
    id = ids[0];
  }
  if (windowId !== undefined)
    return __appTarget(await __call('bind_app', { ...(id !== undefined ? { bundle_id: id } : { name: copyName }), window_id: windowId }), id ?? path, false, windowId);
  const label = id ?? name ?? path;
  const mine = rows.filter((item) => (id !== undefined ? item.bundle_id === id : item.name === name));
  const live = (item) => item.pid > 0 && item.running !== false;
  const running = mine.filter(live);
  // Linux and Windows can list a running process without the id its installed row carries. A
  // shared display name does not prove it is this app, so it is named, never bound or relaunched.
  if (running.length === 0 && id !== undefined) {
    const names = new Set(mine.map((item) => item.name).filter((each) => typeof each === 'string'));
    const unproven = rows.filter((item) => live(item) && (item.bundle_id === undefined || item.bundle_id === null) && names.has(item.name));
    if (unproven.length > 0)
      throw new ScreenError('target_ambiguous', label + ' may be running as ' + unproven.map((item) => item.name + ' (pid ' + item.pid + ')').join(', ') + ', listed without its id; nothing was launched. If it is, pick its window in screen.discover() and call screen.app({name: ' + JSON.stringify(String(unproven[0].name)) + ', window_id}).', true);
  }
  const pids = [...new Set(running.map((item) => item.pid))];
  if (pids.length > 1)
    throw new ScreenError('target_ambiguous', label + ' runs as ' + pids.length + ' processes (pid ' + pids.join(', ') + '); pass window_id from screen.discover().', true);
  const by = (row) => (row.bundle_id ? { bundle_id: row.bundle_id } : { name: row.name });
  let wanted;
  if (pids.length === 1) {
    const listedWindows = await __call('list_windows', { pid: pids[0] });
    if (!listedWindows || !Array.isArray(listedWindows.windows))
      throw new ScreenError('target_missing', 'The window list of ' + label + ' came back incomplete; nothing was launched. Pass window_id from screen.discover().', true);
    const all = __own(listedWindows, pids[0]);
    const own = all.filter((item) => item.is_on_screen !== false);
    const named = (items) => items.map((item) => item.window_id + (item.title ? ' ' + JSON.stringify(String(item.title)) : '')).join(', ');
    if (own.length > 1)
      throw new ScreenError('target_ambiguous', label + ' has ' + own.length + ' windows (' + named(own) + '); pass window_id.', true);
    if (own.length === 1)
      return __appTarget(await __call('bind_app', { ...by(running[0]), window_id: own[0].window_id }), label, false, own[0].window_id);
    if (all.length > 0)
      throw new ScreenError('target_missing', label + ' is running with no window on screen; ' + named(all) + ' may be minimized, hidden, on another Space or closed. Pass window_id to bind one, or ask the person to show it.', true);
    wanted = by(running[0]);
  } else if (path !== undefined) {
    wanted = { path };
  } else {
    // Several installed copies of one bundle id and none running: the /Applications copy.
    const copies = [...new Set(mine.map((item) => item.launch_path).filter((each) => typeof each === 'string'))];
    const preferred = id !== undefined && copies.length > 1 ? copies.find((each) => each.startsWith('/Applications/')) : undefined;
    const row = mine[0];
    wanted = {
      ...(id !== undefined ? { bundle_id: id } : row && row.bundle_id ? { bundle_id: row.bundle_id } : {}),
      ...(name !== undefined ? { name } : row && typeof row.name === 'string' ? { name: row.name } : {}),
      ...(row && typeof row.launch_path === 'string' ? { launch_path: row.launch_path } : {}),
      ...(preferred === undefined ? {} : { prefer_path: preferred }),
    };
  }
  const reply = await __checked('launch_app', { ...wanted, bind: true });
  __remember({ call: 'launch', verdict: __verdict(reply) });
  return __appTarget(reply.v, reply.v.bundle_id ?? label, true, reply.v.windowId);
};
const __launch = async (query = {}) => {
  const bundle = query.bundle_id ?? query.bundleId;
  const reply = await __checked('launch_app', {
    ...(bundle === undefined ? {} : { bundle_id: bundle }),
    ...(query.name === undefined ? {} : { name: query.name }),
    ...(query.path === undefined ? {} : { path: query.path }),
  });
  __remember({ call: 'launch', verdict: __verdict(reply) });
  return reply.v;
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
  launch: __launch,
  tab: async (query = {}) => __tab(await __call('select_tab', __tabQuery(query))),
  openTab: async (arg = {}) => __tab(await __call('open_tab', arg)),
  listTabs: () => __call('list_tabs', {}),
  ${methods.map((method) => `${method}: async (...args) => (await __reply(${JSON.stringify(method)}, args)).v`).join(",\n  ")}
});
globalThis.console = Object.freeze({ log: (...args) => __log(args.map(String).join(' ')) });
`;
