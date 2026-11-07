export const ACP_LOCAL_PRESETS = [
  {
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    args: ["acp", "--approval-mode", "always-ask"],
    // The project icon (oh-my-pi assets/icon.svg) on a dark tile, inlined so the dialog fetches nothing.
    iconUrl:
      "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Crect%20width%3D%22120%22%20height%3D%22120%22%20rx%3D%2224%22%20fill%3D%22%230d0d0d%22%2F%3E%3Cg%20transform%3D%22translate(0%2015)%22%3E%3Crect%20x%3D%2210%22%20y%3D%228%22%20width%3D%22100%22%20height%3D%2212%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2225%22%20y%3D%2220%22%20width%3D%2212%22%20height%3D%2262%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2275%22%20y%3D%2220%22%20width%3D%2212%22%20height%3D%2245%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2271%22%20y%3D%2255%22%20width%3D%2220%22%20height%3D%2216%22%20rx%3D%223%22%20fill%3D%22%23f97316%22%2F%3E%3Crect%20x%3D%2276%22%20y%3D%2259%22%20width%3D%223%22%20height%3D%228%22%20rx%3D%221%22%20fill%3D%22%230d0d0d%22%2F%3E%3Crect%20x%3D%2282%22%20y%3D%2259%22%20width%3D%223%22%20height%3D%228%22%20rx%3D%221%22%20fill%3D%22%230d0d0d%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E",
    installHint: "curl -fsSL https://omp.sh/install | sh",
    docsUrl: "https://github.com/can1357/oh-my-pi",
  },
] as const;
