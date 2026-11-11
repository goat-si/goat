package daemon

import (
	"errors"
	"fmt"
)

// The identity line J for a caller that is not a member (contract "Identity line forms"). Every value comes from
// an identifier alphabet, so none needs escaping; a value that does not is refused rather than escaped.

// clientIdentityLine renders J for the listed client key noisePub with list id id.
func clientIdentityLine(meshID, self, id, noisePub, name string) ([]byte, error) {
	if err := lineHead(meshID, self, name); err != nil {
		return nil, err
	}
	if !validID(id) {
		return nil, fmt.Errorf("client id %q is not 26 base32 characters", id)
	}
	if _, ok := decodeKey32(noisePub); !ok {
		return nil, errors.New("the client key is not canonical base64url")
	}
	return []byte(`{"v":1,"mesh":"` + meshID + `","self":"` + self + `","client":{"id":"` + id + `","noisePub":"` + noisePub +
		`"},"stream":"` + name + `"}`), nil
}

// pairingIdentityLine renders J for a pairing handshake on invite, from the initiator key noisePub, with its sas.
func pairingIdentityLine(meshID, self, invite, noisePub, sas, name string) ([]byte, error) {
	if err := lineHead(meshID, self, name); err != nil {
		return nil, err
	}
	if !validInviteID(invite) {
		return nil, errors.New("the invite id is not 16 canonical base64url characters")
	}
	for _, k := range []string{noisePub, sas} {
		if _, ok := decodeKey32(k); !ok {
			return nil, errors.New("a pairing key or sas is not canonical base64url")
		}
	}
	return []byte(`{"v":1,"mesh":"` + meshID + `","self":"` + self + `","pairing":{"invite":"` + invite + `","noisePub":"` +
		noisePub + `","sas":"` + sas + `"},"stream":"` + name + `"}`), nil
}

func lineHead(meshID, self, name string) error {
	if !validID(meshID) || !validID(self) {
		return errors.New("a mesh or node id is not 26 base32 characters")
	}
	if !ValidServiceName(name) {
		return errors.New("the service name is outside its alphabet")
	}
	return nil
}

// validInviteID reports 16 canonical base64url characters (12 bytes), the service invite id.
func validInviteID(s string) bool {
	if len(s) != 16 {
		return false
	}
	b, err := strictB64.DecodeString(s)
	return err == nil && len(b) == 12
}
