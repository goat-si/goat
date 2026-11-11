package daemon

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var queryUnbiasedInterruptTime = windows.NewLazySystemDLL("kernel32.dll").NewProc("QueryUnbiasedInterruptTime")

// awakeClock reads QueryUnbiasedInterruptTime, which leaves out time asleep. Go's monotonic clock on
// Windows reads the interrupt time, which keeps counting while the machine sleeps.
func awakeClock() func() time.Duration {
	return func() time.Duration {
		var t uint64 // 100 ns units
		queryUnbiasedInterruptTime.Call(uintptr(unsafe.Pointer(&t)))
		return time.Duration(t) * 100
	}
}
