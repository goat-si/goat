//go:build unix

package daemon

import "time"

// awakeClock reads Go's monotonic clock, which stops while the machine sleeps on Linux and macOS.
func awakeClock() func() time.Duration {
	start := time.Now()
	return func() time.Duration { return time.Since(start) }
}
