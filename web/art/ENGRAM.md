# Engram

*An algorithmic philosophy for the Mnemo hero, written before the code, as the
algorithmic-art skill asks.*

**Consolidation.** A memory is not stored; it is settled. Noise comes first: a field
of characters with no one in particular to be, drifting on a slow current. Engram is
the moment some of that noise agrees to stay. Cells that belong to the shape begin
to flicker through brighter and brighter glyphs, then stop being text at all and
become a pixel. The beauty is in the process of agreeing, not in the final frame,
and no two seeds agree in the same order.

**Computation.** Everything is one lattice of cells and two fields over it. The first
is a seeded value-noise current, sampled at a drifting offset, that decides what
every free cell shows: which glyph from a ramp of seven, in which of four inks, at
what strength. The second is a delay field: each cell of the sprite is given a
moment to settle, a blend of its distance from the middle and a seeded roll, so the
shape closes from several places at once rather than wiping on from an edge. The
same seed always produces the same drift and the same order of settling.

**Behaviour.** Settled pixels are not final. At a long, slow interval a ring of
forgetting crosses the figure and the cells under it fall back to glyphs for a
moment before they re-settle: recall is an act, repeated, and the figure is only as
stable as the last time it was remembered. The pointer is a lantern: cells near it
brighten and change their ink, settled or not, and let go when it leaves.

**Restraint.** The piece draws on a character grid and a fixed palette, because the
product lives in a terminal and thinks in pixels. It runs at a capped frame rate,
pauses when it is off screen or the tab is hidden, and when motion is reduced it is
a single, finished frame. The craft is in the parameters being few and meaningful:
cell size, current scale, drift speed, settling time and lantern radius, each tuned
until the field reads as weather and the figure as a thing that was always going to
arrive.

**The quiet reference.** Elephants never forget. The sprite is Mne, the mascot, in
the exact eighteen-by-eighteen pixel map used by the terminal interface, so the page
and the product draw the same animal.
