package daemon

import (
	"context"
	"time"
)

// presenceTimeout bounds one presence sync, so a member that never answers is shown offline soon.
const presenceTimeout = 15 * time.Second

// refreshPresence syncs with every member in the background, at most once per PresenceEvery and
// never twice at once. The periodic sync runs every 10 minutes; a dashboard someone is looking at
// refreshes sooner, so a member that went to sleep stops being shown online within about a minute.
func (d *Daemon) refreshPresence() {
	if d.runCtx == nil {
		return
	}
	d.presenceMu.Lock()
	now := d.now()
	if d.presenceRunning || !d.presenceAt.IsZero() && now.Sub(d.presenceAt) < d.opt.PresenceEvery {
		d.presenceMu.Unlock()
		return
	}
	d.presenceRunning = true
	d.presenceAt = now
	d.presenceMu.Unlock()
	d.spawn(func() {
		ctx, cancel := context.WithTimeout(d.runCtx, presenceTimeout)
		defer cancel()
		d.pushAll(ctx)
		d.presenceMu.Lock()
		d.presenceRunning = false
		d.presenceMu.Unlock()
		if d.opt.PresenceDone != nil {
			d.opt.PresenceDone()
		}
	})
}
