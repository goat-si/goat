// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too. macOS needs neither.
export const MACOS_BIND_PRELOAD = `const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  if (typeof port !== "number" || typeof host !== "string") return listen.apply(this, arguments);
  return listen.call(this, { port, host, reusePort: true }, callback);
};
`;
