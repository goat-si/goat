package daemon

import (
	"errors"
	"io"
	"os"
	"time"
)

const (
	// maxLog is the size past which daemon.log moves to daemon.log.1.
	maxLog = 4 << 20
	// logCapEvery is how often a running daemon checks its log size.
	logCapEvery = time.Minute
)

// capLog moves an oversized log to path.1 by copying it and truncating it in place. Its writers (launchd,
// or the pen up that detached this daemon) hold it open with O_APPEND, so a rename would leave them
// writing to the moved file; after a truncate their next write lands at offset 0. Lines written between
// the copy and the truncate are lost.
func capLog(path string, limit int64) error {
	fi, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || fi.Size() <= limit {
		return err
	}
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := path + ".1.tmp"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path+".1"); err != nil {
		return err
	}
	return os.Truncate(path, 0)
}

func (d *Daemon) capLog() {
	if err := capLog(d.st.Path("daemon.log"), maxLog); err != nil {
		d.opt.Logf("daemon.log: %v", err)
	}
}

// pruneInvites removes expired invites, so an unused one does not keep its secret in offers.json.
func (d *Daemon) pruneInvites() {
	iv := d.inviteBook()
	if iv == nil {
		return
	}
	if err := iv.Prune(d.now()); err != nil {
		d.opt.Logf("offers.json: %v", err)
	}
}
