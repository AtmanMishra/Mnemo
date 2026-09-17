package anim

import (
	"testing"
	"time"
)

// TestThePulseIsBoundedPeriodicAndUndrifted is the pulse's whole contract, and
// each half of it catches a different failure: a value outside [0,1] is a glitch
// in whatever it paints, a pulse that never reaches the ends is a shimmer rather
// than an indicator, and a pulse that drifts against its own beat is a
// distraction — the eye finds the seam even when it cannot say what moved.
func TestThePulseIsBoundedPeriodicAndUndrifted(t *testing.T) {
	for _, tick := range cadences {
		t.Run(tick.String(), func(t *testing.T) {
			motionOn(t)
			p := NewPulse(tick, 0)
			if p.Period() < PulsePeriod-tick || p.Period() > PulsePeriod+tick {
				t.Fatalf("no period asked for and the pulse breathes at %v, want PulsePeriod %v", p.Period(), PulsePeriod)
			}
			frames := int(p.Period() / tick)
			const periods = 6
			vals := make([]float64, 0, frames*periods)
			for i := 0; i < frames*periods; i++ {
				p.Tick()
				vals = append(vals, p.Value())
			}

			lo, hi := bounds(vals)
			if lo < 0 || hi > 1 {
				t.Fatalf("the pulse left its range, reaching [%v,%v]", lo, hi)
			}
			if lo > 0.05 || hi < 0.95 {
				t.Fatalf("over six periods the pulse only reaches [%.3f,%.3f]: one that does not travel to both ends is not an indicator", lo, hi)
			}

			// Every period is the one before it, to the bit.
			last := vals[len(vals)-frames:]
			for k := 1; k <= 3; k++ {
				earlier := vals[len(vals)-(k+1)*frames : len(vals)-k*frames]
				if d := apart(earlier, last); d > 1e-9 {
					t.Fatalf("the pulse drifted by %v over %d period(s)", d, k)
				}
			}
			t.Logf("%d frames a period (%v), reaching [%.4f,%.4f]", frames, p.Period(), lo, hi)
		})
	}
}

// TestThePulsePeriodIsWholeFrames is what makes the periodicity check above
// possible at all. A half period landing between two frames is not a period: the
// drive would run 37 frames one way and 38 back, and the breath would slip a frame
// against its own beat — which is precisely the drift the test above would then
// catch, too late to be useful.
func TestThePulsePeriodIsWholeFrames(t *testing.T) {
	for _, tick := range cadences {
		p := NewPulse(tick, PulsePeriod)
		if p.Period()%tick != 0 {
			t.Fatalf("at %v a frame the period is %v, which is not a whole number of frames", tick, p.Period())
		}
		if half := p.Period() / 2; half%tick != 0 {
			t.Fatalf("at %v a frame half a period is %v, which is not a whole number of frames either", tick, half)
		}
		if d := p.Period() - PulsePeriod; d > tick || d < -tick {
			t.Fatalf("asked for %v, got %v back", PulsePeriod, p.Period())
		}
	}
	if p := NewPulse(Frame, time.Millisecond); p.Period() < 2*Frame {
		t.Fatalf("a one-millisecond period became %v: the shortest breath is two frames", p.Period())
	}
	if got := NewPulse(Frame, 0).Period(); got < PulsePeriod-Frame || got > PulsePeriod+Frame {
		t.Fatalf("a zero period breathes at %v, want the default %v", got, PulsePeriod)
	}
}

// TestThePulseStartsQuietAndRises: the indicator comes up from dark rather than
// being lit from its first frame, so the first thing the frame draws agrees with
// the value it was given.
func TestThePulseStartsQuietAndRises(t *testing.T) {
	motionOn(t)
	p := NewPulse(Frame, 0)
	if got := p.Value(); got != 0 {
		t.Fatalf("a pulse before its first frame is at %v, want 0", got)
	}
	p.Tick()
	if got := p.Value(); got <= 0 || got >= 1 {
		t.Fatalf("the first frame of a pulse is at %v, want it on its way up from quiet", got)
	}
}

// TestWithMotionOffThePulseIsLitAndStill: reduced motion stops the movement, not
// the information. A thinking indicator that went dark during work would be the
// one reading that is wrong.
func TestWithMotionOffThePulseIsLitAndStill(t *testing.T) {
	motionOff(t)
	p := NewPulse(Frame, 0)
	for i := 1; i <= 90; i++ {
		p.Tick()
		if got := p.Value(); got != 1 {
			t.Fatalf("frame %d of a pulse with motion off is %v, want a steady 1", i, got)
		}
	}
}

// TestThePulseIsNotWhatKeepsTheScreenAwake holds the design decision that keeps
// the still-screen rule intact: the pulse is not in the group, because it never
// settles. Its reason for a frame is the work, and the work is already tracked by
// the thing that turns the spinner. If a pulse ever became a group member, this
// is the test that would fail, rather than a user's fan.
func TestThePulseIsNotWhatKeepsTheScreenAwake(t *testing.T) {
	motionOn(t)
	g := NewGroup(Frame)
	g.New(Soft, 0) // an overlay at rest, open on screen
	p := NewPulse(Frame, 0)
	for i := 1; i <= 200; i++ {
		p.Tick()
		g.Tick()
		if g.Animating() {
			t.Fatalf("frame %d: the pulse made a still group ask for a frame", i)
		}
	}
}
