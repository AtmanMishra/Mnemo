package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The memory-overlay fixtures re-exec THIS test binary as the stand-in memsrv.
//
// They used to be `#!/bin/sh` scripts written into a temp directory, which only
// runs where there is a POSIX shell — so on Windows the sidecar never started,
// the overlay fell back to its error list, and Tree() was nil. The protocol
// under test is a line of JSON in and a line of JSON out; nothing about it needs
// a shell. (internal/memory has the same fixture for the same reason.)
const (
	envFakeSrv  = "MNEMO_TEST_FAKESRV"
	envFakeSpec = "MNEMO_TEST_FAKE_SPEC"
)

// TestMain is also the fake sidecar's entry point: when the environment says
// so, this process is the sidecar and never the test runner.
func TestMain(m *testing.M) {
	if os.Getenv(envFakeSrv) == "1" {
		os.Exit(fakeSrvMain())
	}
	os.Exit(m.Run())
}

// fakeSpec says what the stand-in sidecar answers. Replies is keyed by RPC
// method; anything not listed gets Default.
type fakeSpec struct {
	Capture string            `json:"capture,omitempty"` // every request line is appended here
	Replies map[string]string `json:"replies,omitempty"` // method -> raw JSON for "result"
	Default string            `json:"default,omitempty"` // result for an unlisted method
}

var (
	fakeID     = regexp.MustCompile(`"id"\s*:\s*([0-9]+)`)
	fakeMethod = regexp.MustCompile(`"method"\s*:\s*"([^"]+)"`)
)

func fakeSrvMain() int {
	var spec fakeSpec
	if err := json.Unmarshal([]byte(os.Getenv(envFakeSpec)), &spec); err != nil {
		fmt.Fprintln(os.Stderr, "fake sidecar: bad spec:", err)
		return 2
	}
	in := bufio.NewReader(os.Stdin)
	for {
		line, err := in.ReadString('\n')
		if line != "" {
			if strings.Contains(line, `"exit"`) {
				return 0
			}
			if spec.Capture != "" {
				if f, ferr := os.OpenFile(spec.Capture, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); ferr == nil {
					_, _ = f.WriteString(strings.TrimRight(line, "\r\n") + "\n")
					_ = f.Close()
				}
			}
			id := 1
			if m := fakeID.FindStringSubmatch(line); m != nil {
				if n, convErr := strconv.Atoi(m[1]); convErr == nil {
					id = n
				}
			}
			method := ""
			if m := fakeMethod.FindStringSubmatch(line); m != nil {
				method = m[1]
			}
			result := spec.Default
			if r, ok := spec.Replies[method]; ok {
				result = r
			}
			if result == "" {
				result = "{}"
			}
			fmt.Printf("{\"id\":%d,\"ok\":true,\"result\":%s}\n", id, result)
		}
		if err != nil {
			return 0
		}
	}
}

// fakeSrv arms the given behaviour and returns the path to run: this test
// binary, re-executed.
func fakeSrv(t *testing.T, spec fakeSpec) string {
	t.Helper()
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(envFakeSrv, "1")
	t.Setenv(envFakeSpec, string(raw))
	return os.Args[0]
}
