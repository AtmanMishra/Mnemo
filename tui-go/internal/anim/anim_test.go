package anim

import (
	"math"
	"os"
	"sync"
	"testing"
	"time"
)

// settledWithin is how long any preset may take to come to rest.
//
// It is a wall-clock budget rather than a tick count, because a spring settles in
// the same wall-clock time whatever the cadence: measured, the slowest preset
// takes about 800ms at 16ms and at 80ms ticks alike. This is that with room on
// top, and TestEveryPresetComesToRest fails if a preset outgrows it.
const settledWithin = 950 * time.Millisecond

// cadences are the tick intervals everything here is tested at: the package's own
// frame, a middle rate, and the interface's coarse spinner tick
// (theme.SpinnerIntervalMS).
var cadences = []time.Duration{Frame, 33 * time.Millisecond, 80 * time.Millisecond}

// motionOn forces motion on for one test, whatever the environment says. On a
// machine with MNEMO_NO_ANIMATION=1 set, the convergence tests would otherwise
// pass while proving nothing at all.
func motionOn(t *testing.T) {
	t.Helper()
	was := Enabled()
	SetEnabled(true)
	t.Cleanup(func() { SetEnabled(was) })
}

// motionOff puts the process into reduced motion for one test.
func motionOff(t *testing.T) {
	t.Helper()
	was := Enabled()
	SetEnabled(false)
	t.Cleanup(func() { SetEnabled(was) })
}

// ticksIn is how many frames fit in d, plus a couple of frames of slack, so a
// budget is a budget rather than an off-by-one.
func ticksIn(d, tick time.Duration) int { return int(d/tick) + 2 }

// drive ticks a group until nothing in it is animating, and returns the frames
// that took.
//
// It fails rather than loops. A spring that never settles is the bug this package
// exists to prevent, so a regression in the physics has to fail the suite with
// the budget it spent — hanging the suite tells the next person nothing.
func drive(t *testing.T, g *Group, budget time.Duration) int {
	t.Helper()
	limit := ticksIn(budget, g.Interval())
	for i := 1; i <= limit; i++ {
		g.Tick()
		if !g.Animating() {
			return i
		}
	}
	t.Fatalf("still animating after %d ticks (%v at %v a frame): a spring that never settles is a UI that never stops redrawing",
		limit, budget, g.Interval())
	return 0
}

// until drives a group to rest and returns every value the spring passed
// through: the frames the screen would have drawn, in order.
func until(t *testing.T, g *Group, s *Spring, budget time.Duration) []float64 {
	t.Helper()
	limit := ticksIn(budget, g.Interval())
	seen := make([]float64, 0, limit)
	for i := 1; i <= limit; i++ {
		g.Tick()
		seen = append(seen, s.Value())
		if !g.Animating() {
			return seen
		}
	}
	t.Fatalf("still animating after %d ticks (%v at %v a frame): a spring that never settles is a UI that never stops redrawing",
		limit, budget, g.Interval())
	return nil
}

// bounds is the lowest and highest of a run of samples.
func bounds(vals []float64) (lo, hi float64) {
	lo, hi = math.Inf(1), math.Inf(-1)
	for _, v := range vals {
		lo, hi = math.Min(lo, v), math.Max(hi, v)
	}
	return lo, hi
}

// apart is the largest difference between two windows of samples: how far a
// repeated motion has drifted from the last time it happened.
func apart(a, b []float64) float64 {
	worst := 0.0
	for i := range a {
		worst = math.Max(worst, math.Abs(a[i]-b[i]))
	}
	return worst
}

// --- reduced motion -------------------------------------------------------

// TestTheEnvironmentDecidesWhetherMotionStarts is the whole grammar of the
// switch: a value that reads as yes turns motion off, and everything else —
// including a value that reads as no, an empty one, and a typo — leaves it on. A
// preference is not worth an error dialog, and it is certainly not worth
// silently stopping motion because somebody spelled the value oddly.
func TestTheEnvironmentDecidesWhetherMotionStarts(t *testing.T) {
	on := []string{"", " ", "0", "false", "no", "off", "maybe", "enabled", "2"}
	for _, v := range on {
		if !fromEnv(func(string) string { return v }) {
			t.Errorf("MNEMO_NO_ANIMATION=%q stopped motion; only a value that reads as yes should", v)
		}
	}
	off := []string{"1", "true", "TRUE", "t", "y", "yes", "on", " yes ", "\ton\n"}
	for _, v := range off {
		if fromEnv(func(string) string { return v }) {
			t.Errorf("MNEMO_NO_ANIMATION=%q did not stop motion; it reads as yes", v)
		}
	}
}

// TestTheVariableIsTheDocumentedSpelling pins the name. It is in README.md, in
// this package's documentation and in whatever a user has in their shell; a
// rename that only changes the constant breaks nobody's build and everybody's
// terminal.
func TestTheVariableIsTheDocumentedSpelling(t *testing.T) {
	if EnvNoAnimation != "MNEMO_NO_ANIMATION" {
		t.Fatalf("EnvNoAnimation is %q, want MNEMO_NO_ANIMATION", EnvNoAnimation)
	}
}

// TestSettingTheVariableReachesTheSwitch runs the start-up path again: the
// environment is read into the very switch every value consults, so a process
// started with MNEMO_NO_ANIMATION=1 is motionless from the first frame rather
// than from the first frame after somebody remembered to check it.
func TestSettingTheVariableReachesTheSwitch(t *testing.T) {
	was := Enabled()
	t.Cleanup(func() { SetEnabled(was) })
	t.Setenv(EnvNoAnimation, "1")
	applyEnv(os.Getenv)
	if Enabled() {
		t.Fatal("MNEMO_NO_ANIMATION=1 did not reach the switch")
	}
	g := NewGroup(Frame)
	s := g.New(Soft, 0)
	s.To(1)
	if got := s.Value(); got != 1 {
		t.Fatalf("with motion off the value is where it was told to go: got %v", got)
	}
	if g.Animating() {
		t.Fatal("with motion off nothing has anywhere to go, so nothing asks for a frame")
	}
}

// TestOffIsTheSwitch is the programmatic spelling of the same state.
func TestOffIsTheSwitch(t *testing.T) {
	motionOn(t)
	Off()
	if Enabled() {
		t.Fatal("Off must say off")
	}
	SetEnabled(true)
	if !Enabled() {
		t.Fatal("SetEnabled(true) must say on")
	}
}

// TestWithMotionOffOneTickReachesTheTarget is the contract in the task's own
// terms: one frame after a change the screen is final, and the question is
// answered before a frame is even spent.
func TestWithMotionOffOneTickReachesTheTarget(t *testing.T) {
	motionOff(t)
	g := NewGroup(Frame)
	s := g.New(Soft, 0)
	s.To(1)

	g.Tick()
	if got := s.Value(); got != 1 {
		t.Fatalf("one tick with motion off left the value at %v, want the target 1", got)
	}
	if g.Animating() {
		t.Fatal("with motion off Animating must be false immediately: there is nothing left to draw")
	}
	for i := 0; i < 10; i++ {
		g.Tick()
	}
	if got := s.Value(); got != 1 {
		t.Fatalf("the value wandered to %v with motion off", got)
	}
}

// TestTurningMotionOffMidFlightLandsTheValue is the case that is easy to get
// wrong: the switch flips while a spring is in the air. A pause would leave a
// panel half way up the screen forever — and with nothing animating there would
// be no frame coming to finish it. The frame that lands it is the last one.
func TestTurningMotionOffMidFlightLandsTheValue(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	s := g.New(Slow, 0)
	s.To(1)
	g.Tick()
	g.Tick()
	if !g.Animating() {
		t.Fatal("the spring should still be in the air two frames in")
	}
	Off()
	g.Tick()
	if got := s.Value(); got != 1 {
		t.Fatalf("the frame after Off left the value at %v, want the target 1: a frozen spring is a panel stuck half way", got)
	}
	if g.Animating() {
		t.Fatal("the frame after Off must be the last one: nothing is animating, so nothing asks for another")
	}
	for i := 0; i < 10; i++ {
		g.Tick()
	}
	if got := s.Value(); got != 1 {
		t.Fatalf("the value wandered to %v with motion off", got)
	}
}

// TestTheSwitchIsSafeToReadWhileItIsBeingChanged is what a race detector is for.
// The switch is read on the render path and written wherever the app learns that
// motion should stop, so it is atomic. The springs themselves are
// single-goroutine by contract, and this test does not pretend otherwise: one
// goroutine ticks the group while another works the switch.
func TestTheSwitchIsSafeToReadWhileItIsBeingChanged(t *testing.T) {
	t.Cleanup(func() { SetEnabled(true) })
	g := NewGroup(Frame)
	s := g.New(Snappy, 0)
	s.To(1)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 2000; i++ {
			SetEnabled(i%2 == 0)
		}
		close(stop)
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				SetEnabled(Enabled())
			}
		}
	}()
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				g.Animating()
				g.Tick()
				_ = s.Value()
			}
		}
	}()
	wg.Wait()
}
