
# Brain-Area Memory Architecture (Mnemo) — design v0
Extends memory-design-spec.md. Naming: the agent is MNEMO (Mnemosyne); the memory
layer becomes a simulated brain with SPECIALIZED AREAS, mimicking regional
specialization of the human brain.

## 1. Why areas
Today every node lives in one undifferentiated graph; search mixes everything.
Brains route by region: each area has cell types, inputs, and a JOB. For an agent,
areas give us: cheaper retrieval (search the right region first), specialized
retention policies, and interpretable steering ("the procedural area was wrong").

## 2. The areas (v1 set)
| Area | Brain analogue | Node types | Retention | Retrieval bias |
|------|---------------|------------|-----------|----------------|
| EPISODIC | hippocampus | TaskEpisode, Outcome | compacted aggressively; vivid failures kept longer | recency + outcome-weight |
| SEMANTIC | temporal lobe / neocortex | Aspect facts | stable; supersede-only | similarity dominant |
| PROCEDURAL | cerebellum / basal ganglia | Harness, skills | kept while success-rate high; pruned on repeated failure | usage frequency |
| SPATIAL | parietal lobe | Entity (repos, paths, services) | stable | structural/graph hops |
| SALIENCE | amygdala | failure/pain markers | fast capture, slow decay | high priority boost |
| EXECUTIVE | prefrontal | steering decisions, plans | short | always consulted first |

## 3. Mechanics
- Every node gets `area` (derived from kind at creation; overridable).
- memsrv search gains `areas?: string[]` filter and a routing step:
  query classifier (cheap keyword/heuristic v0) picks 1-2 primary areas;
  other areas searched at reduced weight instead of excluded.
- Cross-area edges keep the global graph connected (EPISODIC episode cites
  SEMANTIC aspects it used - already our DerivedFrom).
- Steering writes to SALIENCE first (pain marker), then Executive decides:
  supersede fact (Semantic), reweight harness (Procedural), or rewire (any).
- Consolidation job (later): nightly replay compacts Episodic into Semantic
  facts - literally "sleep".

## 4. Implementation path (NOT started)
P1: add area to model.rs + memsrv create_node/search filter/route heuristic
P2: area-aware scoring weights in search.rs expansion
P3: salience markers written by steer(); consolidation job skeleton
P4: cockpit Memory pane groups by area

## 5. Open questions
Q1: does area live on node (column) vs derived from kind? -> column, default by kind.
Q2: cross-area retrieval discount factor? tune via memeval.
Q3: do sub-agents get restricted area views? (executive decides exposure)
