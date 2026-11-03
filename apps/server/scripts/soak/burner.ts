// @effect-diagnostics globalTimers:off globalDate:off
const parent = process.ppid;
const deadline = Date.now() + Number(process.argv[2] ?? 1_860_000);
setInterval(() => {
  if (process.ppid !== parent || Date.now() >= deadline) process.exit(0);
}, 2000).unref();
let value = 1;
const burn = () => {
  for (let i = 0; i < 100_000; i++) value = Math.imul(value ^ (value >>> 11), 2654435761);
  setImmediate(burn);
};
burn();
