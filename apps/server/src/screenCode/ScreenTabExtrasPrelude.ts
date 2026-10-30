export const screenTabExtrasPrelude = String.raw`
const __tabExtras = (tab, call) => ({
  logs: (options = {}) => {
    if (!tab) throw new ScreenError('unsupported', 'Logs are only available on tabs.', true);
    return call('tab_logs', __only('logs options', options, ['since']));
  },
});
`;
