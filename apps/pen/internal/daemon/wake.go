package daemon

import (
	"context"
	"time"
)

// wakeJump is how far the wall clock may run ahead of the monotonic clock between two checks
// before the daemon treats it as a sleep (the monotonic clock stops while the machine sleeps).
const wakeJump = 10 * time.Second

// wakeLoop redials every uplink at once after the machine slept: its sockets are likely dead, and
// waiting for a write to fail or the silence deadline would keep the node unreachable for a minute.
func (d *Daemon) wakeLoop(ctx context.Context) {
	ticks := d.opt.WakeTicks
	if ticks == nil {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		ticks = t.C
	}
	last := d.now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
		now := d.now()
		wall := now.Round(0).Sub(last.Round(0))
		// A forward wall-clock step over 10 s (an NTP correction) looks the same and costs one redial.
		if slept := wall - d.opt.Since(last); slept > wakeJump {
			d.opt.Logf("woke after about %v asleep; redialing the relays", slept.Round(time.Second))
			d.redialUplinks()
		}
		last = now
	}
}

func (d *Daemon) redialUplinks() {
	d.upMu.Lock()
	defer d.upMu.Unlock()
	for _, sl := range d.slots {
		sl.up.Redial()
	}
}
