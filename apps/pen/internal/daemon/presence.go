package daemon

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
		d.pushWithin(d.runCtx, d.view().SortedMembers(), d.opt.PresenceTimeout)
		d.presenceMu.Lock()
		d.presenceRunning = false
		d.presenceMu.Unlock()
		if d.opt.PresenceDone != nil {
			d.opt.PresenceDone()
		}
	})
}
