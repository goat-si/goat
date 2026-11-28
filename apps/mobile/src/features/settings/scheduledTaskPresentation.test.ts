import { expect, it, vi } from "vite-plus/test";

import { formatTime, scheduledMemoryAccess, timePickerValue } from "./scheduledTaskPresentation";

it("keeps the saved ceiling separate from unknown current access", () => {
  expect(scheduledMemoryAccess({})).toBeNull();
  expect(scheduledMemoryAccess({ memoryGrantCeiling: "read_write" })).toBe(
    "Memory limit: read & write",
  );
});

it("keeps a fixed time on a DST spring-forward day in the phone's zone", () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "America/New_York";
  vi.useFakeTimers({ toFake: ["Date"] });
  // 02:00 to 02:59 does not exist in New York on this day.
  vi.setSystemTime(new Date("2026-03-08T12:00:00-04:00"));
  try {
    const picker = timePickerValue("02:30");
    // Native pickers keep the value's date and set the chosen local hour and minute.
    const picked = new Date(picker);
    picked.setHours(2, 30);
    expect({
      label: formatTime("02:30"),
      pickerTime: [picker.getHours(), picker.getMinutes()],
      pickedTime: [picked.getHours(), picked.getMinutes()],
    }).toEqual({
      label: new Date(Date.UTC(2000, 0, 1, 2, 30)).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }),
      pickerTime: [2, 30],
      pickedTime: [2, 30],
    });
  } finally {
    vi.useRealTimers();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});
