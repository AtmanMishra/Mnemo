package anim

import (
	"fmt"
	"testing"
	"time"
)

// presets is every preset the interface has, so a new one joins the physics
// tests by being added here rather than by remembering to write a new test.
var presets = []Preset{Snappy, Soft, Slow}

// TestEveryPresetComesToRest is the test this package exists for. Each preset is
// advanced from cold and has to arrive — and arrive inside a tick budget, so a
// regression in the physics fails the suite instead of hanging it. A spring that
// never settles is a UI that never stops redrawing, which on a laptop is a fan
// nobody can explain.
func TestEveryPresetComesToRest(t *testing.T) {
	for _, p := range presets {
		for _, tick := range cadences {
			for _, move := range []struct{ from, to float64 }{{0, 1}, {1, 0}, {0, 0.5}} {
				t.Run(fmt.Sprintf("%s/%v/%v-to-%v", p, tick, move.from, move.to), func(t *testing.T) {
					motionOn(t)
					g := NewGroup(tick)
					s := g.New(p, move.from)
					s.To(move.to)
					if !g.Animating() {
						t.Fatalf("%s was told to go to %v and did not move", p, move.to)
					}
					n := drive(t, g, settledWithin)
					if got := s.Value(); got != move.to {
						t.Fatalf("%s came to rest at %v, want exactly %v", p, got, move.to)
					}
					t.Logf("%s %v→%v: %d frames, %.0fms", p, move.from, move.to, n, float64(n)*tick.Seconds()*1000)
				})
			}
		}
	}
}

// TestSettlingCostsTheSameWallClockTimeWhateverTheCadence is why the tick
// interval can be a parameter at all. Harmonica solves the spring analytically,
// so a coarse frame receives more travel per frame and shares the same arrival
// time as a fine one; if that ever stopped being true, the interface's 80ms
// spinner tick would animate the same transition several times slower than a
// 16ms one and the presets would not survive being reused.
func TestSettlingCostsTheSameWallClockTimeWhateverTheCadence(t *testing.T) {
	for _, p := range presets {
		t.Run(p.String(), func(t *testing.T) {
			motionOn(t)
			cost := func(tick time.Duration) time.Duration {
				g := NewGroup(tick)
				s := g.New(p, 0)
				s.To(1)
				return time.Duration(drive(t, g, settledWithin)) * tick
			}
			fast, coarse := cost(Frame), cost(80*time.Millisecond)
			if d := fast - coarse; d > 100*time.Millisecond || d < -100*time.Millisecond {
				t.Fatalf("%s settles in %v at 16ms frames and %v at 80ms ones: more than a frame's difference means the physics is measuring frames, not time", p, fast, coarse)
			}
		})
	}
}

// TestThePresetsAreTheShapesTheyClaim holds the two claims that decide which
// preset a transition gets: Snappy arrives without wobbling (text that overshoots
// reads as a rendering fault) and Soft is allowed the small settle that makes a
// modal read as coming to rest rather than being switched on.
func TestThePresetsAreTheShapesTheyClaim(t *testing.T) {
	motionOn(t)
	peak := func(p Preset) float64 {
		g := NewGroup(Frame)
		s := g.New(p, 0)
		s.To(1)
		_, hi := bounds(until(t, g, s, settledWithin))
		return hi
	}
	if hi := peak(Snappy); hi > 1 {
		t.Fatalf("Snappy overshot to %v: it is the preset for a block appearing, and a wobbling line of prose is a rendering fault", hi)
	}
	if hi := peak(Soft); hi <= 1 {
		t.Fatalf("Soft never passed its target (peak %v): the small overshoot is what tells the eye the modal has landed", hi)
	} else if hi > 1.03 {
		t.Fatalf("Soft overshot to %v, past the 3%% its preset claims", hi)
	}
}

// TestARestedGroupStaysStill is the still-screen rule at its narrowest: rest is
// exact, and it is a fixed point. Even a ticker that does not know to stop cannot
// make a rested screen move, so a bug in the app's scheduling costs a wasted
// frame rather than an interface that never draws two identical frames.
func TestARestedGroupStaysStill(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	a, b := g.New(Snappy, 0), g.New(Soft, 1)
	a.To(1)
	b.To(0)
	drive(t, g, settledWithin)

	if a.Value() != 1 || b.Value() != 0 {
		t.Fatalf("at rest the values are %v and %v, want exactly 1 and 0: nearly-the-target is a value that creeps", a.Value(), b.Value())
	}
	for i := 0; i < 500; i++ {
		g.Tick()
		if g.Animating() {
			t.Fatalf("a rested group started animating again on frame %d", i+1)
		}
	}
	if a.Value() != 1 || b.Value() != 0 {
		t.Fatalf("500 frames moved a rested value to %v and %v", a.Value(), b.Value())
	}
}

// TestAPresetWithNoStiffnessIsAtItsTarget covers the zero value, which is what a
// caller writes when they meant "no motion here". Harmonica with no angular
// frequency returns coefficients of one, so the value never changes — and a
// spring that never moves never settles. Handling that as "at the target" is the
// difference between an honest no and an always-on redraw.
func TestAPresetWithNoStiffnessIsAtItsTarget(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	s := g.New(Preset{}, 0)
	s.To(1)
	if got := s.Value(); got != 1 {
		t.Fatalf("a spring with no stiffness sat at %v, want its target 1", got)
	}
	if g.Animating() {
		t.Fatal("a spring that cannot move must not report that it is still moving: the value would animate forever on a screen that never changes")
	}
	for i := 0; i < 50; i++ {
		g.Tick()
	}
	if got := s.Value(); got != 1 {
		t.Fatalf("a spring with no stiffness drifted to %v", got)
	}
}

// TestAZeroTickIsNotAFreeze: a group built with no tick interval falls back to
// Frame rather than to a delta time that cannot move anything.
func TestAZeroTickIsNotAFreeze(t *testing.T) {
	motionOn(t)
	for _, tick := range []time.Duration{0, -time.Second} {
		g := NewGroup(tick)
		if got := g.Interval(); got != Frame {
			t.Fatalf("a group built with %v runs at %v a frame, want the built-in %v", tick, got, Frame)
		}
		s := g.New(Snappy, 0)
		s.To(1)
		if n := drive(t, g, settledWithin); n < 2 {
			t.Fatalf("the spring arrived in %d frame(s): a value that never changes never settles either", n)
		}
	}
}

// TestAskingForWhereItAlreadyIsIsNotMotion is the no-op case a view creates by
// accident: recomputing every target, every frame, from state that has not
// changed. If that restarted motion the interface would redraw forever without
// anything moving, which is exactly the bug that looks like nothing at all.
func TestAskingForWhereItAlreadyIsIsNotMotion(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	s := g.New(Snappy, 1)
	s.To(1)
	if g.Animating() {
		t.Fatal("sending a spring to where it already is started a journey")
	}
	for i := 0; i < 10; i++ {
		s.To(1)
		if g.Animating() {
			t.Fatalf("frame %d of a view that recomputes its targets restarted a resting spring", i+1)
		}
	}
}

// TestSnapIsHowAScreenOpensAtRest: a panel that is already open when the frame is
// drawn must be drawn open, not slid in from wherever some earlier layout left
// the value. That is what --dump renders, and what a resize looks like.
func TestSnapIsHowAScreenOpensAtRest(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	s := g.New(Soft, 0)
	s.To(1)
	if !g.Animating() {
		t.Fatal("the spring should be travelling before it is snapped")
	}
	s.Snap(1)
	if g.Animating() {
		t.Fatal("Snap left the spring in motion: a screen's first frame has to be final")
	}
	if got := s.Value(); got != 1 {
		t.Fatalf("Snap put the value at %v, want 1", got)
	}
	g.Tick()
	if g.Animating() || s.Value() != 1 {
		t.Fatalf("the frame after a Snap moved the value to %v", s.Value())
	}
}

// TestTheTrajectoryDoesNotReadTheClock is the determinism claim, tested the only
// way it can be: run the same number of frames twice, with real time passing
// between the frames of one run, and require the same numbers. If anything in
// this package reached for time.Now, sleeping would change the answer.
func TestTheTrajectoryDoesNotReadTheClock(t *testing.T) {
	motionOn(t)
	trace := func(gap time.Duration) []float64 {
		g := NewGroup(Frame)
		s := g.New(Snappy, 0)
		s.To(1)
		out := make([]float64, 0, 20)
		for i := 0; i < 20; i++ {
			g.Tick()
			out = append(out, s.Value())
			time.Sleep(gap)
		}
		return out
	}
	instant := trace(0)
	if instant[0] == instant[len(instant)-1] {
		t.Fatal("the spring did not move in twenty frames")
	}
	delayed := trace(3 * time.Millisecond)
	if d := apart(instant, delayed); d != 0 {
		t.Fatalf("the same frames took a different path when real time passed between them (worst difference %v): a tick interval that is not the only input to the physics is a UI that animates differently on a busy machine", d)
	}
}
