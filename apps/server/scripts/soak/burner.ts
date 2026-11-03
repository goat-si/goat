// A separate owned process keeps CPU pressure off the driver's event loop.
let value = 1;
for (;;) value = Math.imul(value ^ (value >>> 11), 2654435761);
