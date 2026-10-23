// Unit tests run under plain Node, where the real "electron" package only exports the binary's
// path, and its first import downloads and extracts that binary without a lock. Parallel test
// workers then collide in electron/dist. Tests mock what they use (vi.mock("electron") resolves
// here too), so this module stands in for the package and never installs anything.
export default {};
