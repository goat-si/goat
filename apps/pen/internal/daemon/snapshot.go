package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"net"
)

// Snapshot is one watch.snapshot line (contract "Snapshot watch"): the whole member list, every time.
type Snapshot struct {
	T       string           `json:"t"`
	Gen     uint64           `json:"gen"`
	Mesh    string           `json:"mesh"`
	Self    string           `json:"self"`
	Members []SnapshotMember `json:"members"`
	Revoked []NameRef        `json:"revoked"`
}

// SnapshotMember is a member in a snapshot; User and HostKeys are always present.
type SnapshotMember struct {
	NodeID   string   `json:"nodeId"`
	SignPub  string   `json:"signPub"`
	NoisePub string   `json:"noisePub"`
	Name     string   `json:"name"`
	User     string   `json:"user"`
	HostKeys []string `json:"hostKeys"`
	Online   bool     `json:"online"`
}

// maxSnapWatchers bounds watch.snapshot; each line's write is bounded by the control connection (boundedConn).
const maxSnapWatchers = 8

// snapshotLineLocked renders the current snapshot; d.mu is held.
func (d *Daemon) snapshotLineLocked() []byte {
	v := d.lastView
	s := Snapshot{T: "snapshot", Gen: d.snapGen, Mesh: v.MeshID, Self: d.nodeID, Members: []SnapshotMember{}, Revoked: refs(v.SortedRevoked())}
	for _, m := range v.SortedMembers() {
		s.Members = append(s.Members, SnapshotMember{
			NodeID: m.NodeID, SignPub: m.SignPub, NoisePub: m.NoisePub, Name: m.Name, User: m.User,
			HostKeys: append([]string{}, m.HostKeys...),
			// This node answering is this node online; peers are as their last session left them.
			Online: m.NodeID == d.nodeID || d.seen[m.SignPub].Online,
		})
	}
	b, _ := json.Marshal(s)
	return append(b, '\n')
}

// publishSnapshotLocked raises the generation once and sends the new snapshot to every watcher; a watcher
// that is 16 lines behind is closed. d.mu is held.
func (d *Daemon) publishSnapshotLocked() {
	d.snapGen++
	if len(d.snapWatchers) == 0 {
		return
	}
	line := d.snapshotLineLocked()
	for ch := range d.snapWatchers {
		select {
		case ch <- line:
		default:
			close(ch)
			delete(d.snapWatchers, ch)
		}
	}
}

// controlSnapshot runs op watch.snapshot: the current snapshot at once, then one per published change.
func (d *Daemon) controlSnapshot(ctx context.Context, c net.Conn, fail func(error)) {
	ch := make(chan []byte, 16)
	d.mu.Lock()
	if len(d.snapWatchers) >= maxSnapWatchers {
		d.mu.Unlock()
		fail(errors.New("too many snapshot watchers"))
		return
	}
	d.snapWatchers[ch] = struct{}{}
	first := d.snapshotLineLocked()
	d.mu.Unlock()
	defer func() {
		d.mu.Lock()
		delete(d.snapWatchers, ch)
		d.mu.Unlock()
	}()
	write := func(line []byte) bool {
		_, err := c.Write(line)
		return err == nil
	}
	if !write(first) {
		return
	}
	gone := clientGone(c)
	for {
		select {
		case line, ok := <-ch:
			if !ok || !write(line) {
				return
			}
		case <-gone:
			return
		case <-ctx.Done():
			return
		case <-d.stopCh:
			return
		}
	}
}
