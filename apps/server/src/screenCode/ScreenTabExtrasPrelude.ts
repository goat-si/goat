export const screenTabExtrasPrelude = String.raw`
const __tabExtras = (tab, call, aim, act) => ({
  fillSecret: async (target, secretRef) => {
    if (!tab) throw new ScreenError('unsupported', 'Secret fill is only available on tabs.', true);
    if (typeof target === 'string' || (target && typeof target.selector === 'string'))
      return call('tab_fill_secret', { selector: typeof target === 'string' ? target : target.selector, secretRef });
    const aimed = target && target.targetId && target.observationId ? { ref: target } : aim(target);
    if (!aimed.ref) throw new ScreenError('unsupported', 'Name an observed element or a CSS selector.', true);
    await act('click', 'click', aimed);
    return call('tab_fill_secret', { secretRef });
  },
  upload: (target, files) => {
    if (!tab) throw new ScreenError('unsupported', 'Uploads are only available on tabs.', true);
    return call('tab_upload', { ...aim(target), files });
  },
  dialog: (action, promptText) => {
    if (!tab) throw new ScreenError('unsupported', 'Dialogs are only available on tabs.', true);
    return call('tab_dialog', { action, ...(promptText === undefined ? {} : { promptText }) });
  },
  evaluate: (expression) => {
    if (!tab) throw new ScreenError('unsupported', 'Evaluation is only available on tabs.', true);
    return call('tab_evaluate', { expression });
  },
  logs: (options = {}) => {
    if (!tab) throw new ScreenError('unsupported', 'Logs are only available on tabs.', true);
    return call('tab_logs', __only('logs options', options, ['since']));
  },
});
`;
