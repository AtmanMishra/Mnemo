package anim

import "testing"

// TestTheGroupIsTheOnlyQuestion is the contract the app codes against: one
// question, asked once, answered for the whole surface. There is no per-spring
// equivalent for a call site to forget.
func TestTheGroupIsTheOnlyQuestion(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	if g.Animating() {
		t.Fatal("an empty group needs no frames")
	}
	s := g.New(Snappy, 0)
	if g.Animating() {
		t.Fatal("a spring made at rest, where it was put, needs no frames: a screen that opens still must stay still")
	}
	s.To(1)
	if !g.Animating() {
		t.Fatal("a spring with somewhere to go must ask for a frame")
	}
	drive(t, g, settledWithin)
	if g.Animating() {
		t.Fatal("a group whose every spring has arrived must stop asking for frames: this is the answer that ends the tick, and the difference between a moving interface and one that never rests")
	}
}

// TestAGroupAnswersForEverySpringItHolds: one spring still travelling is a frame,
// however many others have arrived. An implementation that answered for the last
// spring added, or the first, would leave the others mid-journey and frozen —
// which is exactly the kind of bug a single question is meant to make impossible.
func TestAGroupAnswersForEverySpringItHolds(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	slide := g.New(Soft, 0)
	block := g.New(Snappy, 0)

	// The FIRST spring added is the one travelling.
	block.To(1)
	if !g.Animating() {
		t.Fatal("the group answered for a spring that is not moving")
	}
	drive(t, g, settledWithin)
	if g.Animating() {
		t.Fatal("the block has arrived and the slide never moved, so nothing needs a frame")
	}

	// The SECOND spring added is the one travelling.
	slide.To(1)
	if !g.Animating() {
		t.Fatal("the group answered for the spring already at rest")
	}
	drive(t, g, settledWithin)

	// Both at once.
	block.To(0)
	slide.To(0)
	if !g.Animating() {
		t.Fatal("two travelling springs is still one frame")
	}
	drive(t, g, settledWithin)
	if g.Animating() {
		t.Fatal("everything has arrived")
	}
}

// TestTheGroupTicksAtTheIntervalItWasGiven pins that the cadence is the caller's
// and nobody's else's: it is what the app schedules its next frame with, so the
// springs and the frames that carry them cannot drift apart.
func TestTheGroupTicksAtTheIntervalItWasGiven(t *testing.T) {
	for _, tick := range cadences {
		if got := NewGroup(tick).Interval(); got != tick {
			t.Fatalf("a group built for %v ticks at %v", tick, got)
		}
	}
	if got := NewGroup(0).Interval(); got != Frame {
		t.Fatalf("a group with no interval ticks at %v, want the built-in %v", got, Frame)
	}
}
