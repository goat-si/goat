export const screenTabExtrasPrelude = String.raw`
const __tabExtras = (tab, call, aim) => ({
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
