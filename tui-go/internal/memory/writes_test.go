package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// srvFor writes a memsrv stand-in that captures every request body (minus the
// exit call) into `capture` and answers everything else with `result`, a JSON
// object. Reading the captured line is how a test pins a wire shape.
func srvFor(t *testing.T, capture, result string) string {
	t.Helper()
	return fakeSrv(t, `while IFS= read -r line; do
  case "$line" in *'"exit"'*) exit 0;; esac
  printf '%s\n' "$line" > '`+capture+`'
  id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
  printf '{"id":%s,"ok":true,"result":' "$id"
  printf '%s' '`+result+`'
  printf '}\n'
done`)
}

func captured(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func wantWire(t *testing.T, raw string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(raw, w) {
			t.Fatalf("request does not carry %s:\n%s", w, raw)
		}
	}
}

func TestAddFactSendsNodeKeyValueAndReturnsTheId(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"fact":41}`))
	id, err := c.AddFact(22, "port", "8080")
	if err != nil {
		t.Fatal(err)
	}
	if id != 41 {
		t.Fatalf("fact id = %d, want 41", id)
	}
	wantWire(t, captured(t, capt), `"method":"fact"`, `"node":22`, `"key":"port"`, `"value":"8080"`)
}

func TestSetAreaSendsTheAreaAndReturnsWhereItLanded(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"area":"Semantic"}`))
	got, err := c.SetArea(22, "semantic")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Semantic" {
		t.Fatalf("area = %q", got)
	}
	wantWire(t, captured(t, capt), `"method":"set_area"`, `"node":22`, `"area":"semantic"`)
}

func TestCreateNodeSendsKindLabelAndOptionalArea(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"node":88,"area":"Episodic"}`))
	node, area, err := c.CreateNode("aspect", "helm rollback needs wait", "episodic")
	if err != nil {
		t.Fatal(err)
	}
	if node != 88 || area != "Episodic" {
		t.Fatalf("node=%d area=%q", node, area)
	}
	wantWire(t, captured(t, capt), `"method":"create_node"`, `"kind":"aspect"`,
		`"label":"helm rollback needs wait"`, `"area":"episodic"`)

	capt2 := filepath.Join(t.TempDir(), "req2")
	c2 := open(t, srvFor(t, capt2, `{"node":89}`))
	if _, _, err := c2.CreateNode("outcome", "deploy went green", ""); err != nil {
		t.Fatal(err)
	}
	raw := captured(t, capt2)
	wantWire(t, raw, `"method":"create_node"`, `"kind":"outcome"`)
	if strings.Contains(raw, `"area"`) {
		t.Fatalf("an empty area must not ride along:\n%s", raw)
	}
}

func TestGoodMarksAnEpisodeAndCarriesTheDetail(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"reinforced":true}`))
	if err := c.Good(3, "the retry loop worked"); err != nil {
		t.Fatal(err)
	}
	wantWire(t, captured(t, capt), `"method":"good"`, `"episode":3`, `"detail":"the retry loop worked"`)
}

func TestSteerWithAFixSupersedesTheStaleFact(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"superseded_on":3}`))
	fix := &Correction{Node: 3, OldFact: 9, NewKey: "port", NewValue: "8081 taken"}
	if err := c.Steer(1, "the port moved", fix); err != nil {
		t.Fatal(err)
	}
	wantWire(t, captured(t, capt),
		`"method":"steer"`, `"episode":1`, `"failure":"the port moved"`,
		`"fix"`, `"node":3`, `"fact":9`, `"new_key":"port"`, `"new_value":"8081 taken"`)
}

func TestSteerWithoutAFixOmitsIt(t *testing.T) {
	capt := filepath.Join(t.TempDir(), "req")
	c := open(t, srvFor(t, capt, `{"pain_node":4}`))
	if err := c.Steer(1, "just recording", nil); err != nil {
		t.Fatal(err)
	}
	raw := captured(t, capt)
	wantWire(t, raw, `"method":"steer"`, `"failure":"just recording"`)
	if strings.Contains(raw, "\"fix\"") {
		t.Fatalf("no correction means no fix object:\n%s", raw)
	}
}

func TestFactRowReadsThePiecesBackOut(t *testing.T) {
	for _, c := range []struct {
		id          string
		node        int
		key, value  string
		ok          bool
	}{
		{"22:  - port: 8080 taken by auth", 22, "port", "8080 taken by auth", true},
		{"7:  - deploy: ", 7, "deploy", "", true},
		// values may contain colons; only the first one splits
		{"9:  - URL: https://example.com/x:y", 9, "URL", "https://example.com/x:y", true},
		// a bare memory and an area heading are not fact rows
		{"7", 0, "", "", false},
		{"area:semantic", 0, "", "", false},
	} {
		node, key, value, ok := FactRow(c.id)
		if ok != c.ok || node != c.node || key != c.key || value != c.value {
			t.Fatalf("FactRow(%q) = %d, %q, %q, %v; want %d, %q, %q, %v",
				c.id, node, key, value, ok, c.node, c.key, c.value, c.ok)
		}
	}
}