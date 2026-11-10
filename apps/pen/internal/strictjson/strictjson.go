// Package strictjson decodes signed JSON bodies with exact, case-sensitive member names.
package strictjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

// Unmarshal decodes one JSON object into the struct v points to. Member names must match v's JSON
// names exactly (encoding/json alone matches them case-insensitively); unknown, case-variant and
// duplicate names and trailing data are rejected.
func Unmarshal(b []byte, v any) error {
	if err := ExactKeys(b, Names(v)); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.More() {
		return errors.New("trailing data")
	}
	return nil
}

// Names lists the JSON member names of the struct v points to.
func Names(v any) map[string]bool {
	t := reflect.TypeOf(v).Elem()
	names := map[string]bool{}
	for i := 0; i < t.NumField(); i++ {
		tag, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
		if tag != "" && tag != "-" {
			names[tag] = true
		}
	}
	return names
}

// ExactKeys checks that b is an object whose member names are all in allowed, each once.
func ExactKeys(b []byte, allowed map[string]bool) error {
	keys, err := Keys(b)
	if err != nil {
		return err
	}
	for _, k := range keys {
		if !allowed[k] {
			return fmt.Errorf("unknown member %q", k)
		}
	}
	return nil
}

// Keys lists an object's member names in order, rejecting a duplicate name.
func Keys(b []byte) ([]string, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	if t != json.Delim('{') {
		return nil, errors.New("not an object")
	}
	seen := map[string]bool{}
	var out []string
	for d.More() {
		k, err := d.Token()
		if err != nil {
			return nil, err
		}
		ks, _ := k.(string)
		if seen[ks] {
			return nil, fmt.Errorf("duplicate member %q", ks)
		}
		seen[ks] = true
		out = append(out, ks)
		var skip json.RawMessage
		if err := d.Decode(&skip); err != nil {
			return nil, err
		}
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	if d.More() {
		return nil, errors.New("trailing data")
	}
	return out, nil
}

// UnmarshalNested decodes an object nested in a signed body: unknown member names are ignored, but a
// duplicate name, or one that differs from a known name only by case, is rejected.
func UnmarshalNested(b []byte, v any) error {
	keys, err := Keys(b)
	if err != nil {
		return err
	}
	known := Names(v)
	for _, k := range keys {
		if known[k] {
			continue
		}
		for n := range known {
			if strings.EqualFold(k, n) {
				return fmt.Errorf("member %q differs from %q only by case", k, n)
			}
		}
	}
	return json.Unmarshal(b, v)
}
