package prompt

import "testing"

func TestQueueFrontPutsTheMessageAheadOfTheRest(t *testing.T) {
	m := New(false)
	m.Queue("older")
	if err := m.Focus(); err != nil {
		t.Fatal(err)
	}
	m.Queue("in the middle")
	m.QueueFront("urgent")
	q := m.Queued()
	if len(q) != 3 || q[0] != "urgent" || q[1] != "older" || q[2] != "in the middle" {
		t.Fatalf("queue = %v", q)
	}
}
