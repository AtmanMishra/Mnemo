# Evaluating Coding Agents: Research for Mnemo

*Compiled August 2026. Mnemo is a terminal-native agentic coding assistant: a Go TUI (`tui-go/`, Bubble Tea-style), a pi-based agent runtime (`agent/`), and a graph-shaped "brain area" memory layer (`memory-layer/`, Rust, with an existing `memeval` retrieval harness reporting Hit@1/Hit@3/MRR — see `STATUS.md`).*

> **A note on numbers.** Frontier-model leaderboard scores move weekly and several sources below (secondary blogs, "leaderboard" aggregator sites) are unreliable or possibly speculative — some numbers found during this research could not be corroborated against the benchmark's own primary site. Wherever a specific score is cited, the source is linked; treat any single-digit-precision score as a snapshot, not a fact that will still be true when you read this. Primary sources (`swebench.com`, official GitHub repos, arXiv papers, lab system cards) are preferred and flagged as such; aggregator/SEO sites are used only where no primary source was found, and are marked **[unverified/secondary]**.

---

## 1. Standard benchmarks for coding agents

### 1.1 Comparison table

| Benchmark | What it measures | Format / harness | Size | Status in 2026 | Source |
|---|---|---|---|---|---|
| **HumanEval / MBPP** | Single-function code generation from a docstring, pass@1 via unit tests | Simple exec-and-check, no repo context | 164 / ~1,000 problems | **Saturated**: SOTA models are near 99%/94% pass@1; contamination documented (8–18% overlap with pretraining corpora like RedPajama/StarCoder-Data); tests only isolated functions, not real SWE work | [Benchmark saturation overview](https://www.emergentmind.com/topics/benchmark-saturation) |
| **LiveCodeBench** | Contest-style code generation, self-repair, execution, test-output prediction | Only scores problems released after a model's training cutoff (contamination-resistant by construction) | Continuously growing (contest problems from LeetCode/AtCoder/Codeforces) | Active successor to HumanEval/MBPP for pure code-gen; explicitly **does not** test multi-file code, long context, or debugging existing code | [livecodebench.github.io](https://livecodebench.github.io/), [GitHub](https://github.com/livecodebench/livecodebench) |
| **BigCodeBench** | Multi-tool / multi-library function calling with complex, compositional instructions | 1,140 tasks across 139 libraries/7 domains; PEP-257-style docstrings as spec | 1,140 tasks (+ "Hard" subset) | Not saturated: best models ~60% vs. ~97% human performance on the Hard split as of the original paper | [arXiv:2406.15877](https://arxiv.org/abs/2406.15877), [HF dataset](https://huggingface.co/datasets/bigcode/bigcodebench) |
| **RepoBench** | Repository-level completion: cross-file retrieval (R), next-line completion (C), and combined pipeline (P) | Static retrieval + completion, Python & Java | Multi-file dataset drawn from real repos | Useful for **context-retrieval quality**, not full agentic SWE — a good analogue for testing Mnemo's memory/retrieval, not its patch-writing | [arXiv:2306.03091](https://arxiv.org/abs/2306.03091) |
| **CodeContests** | Competitive programming problems (Codeforces-style), used to train/evaluate AlphaCode | Held-out tests, brute-force I/O checking | ~10K problems (train) + val/test | Largely superseded by LiveCodeBench for frontier eval, but still used for RL training data; DeepMind's original AlphaCode reached ~top-54th percentile | [DeepMind blog](https://deepmind.google/blog/competitive-programming-with-alphacode/), [GitHub](https://github.com/google-deepmind/code_contests) |
| **SWE-bench (original)** | Resolve real GitHub issues in Python repos via a generated patch | Docker sandbox; FAIL_TO_PASS / PASS_TO_PASS test sets define "resolved" | 2,294 instances (12 repos) | Superseded by **Verified** for headline reporting; original set had known label/test-leakage issues | [swebench.com](https://www.swebench.com/SWE-bench/) |
| **SWE-bench Verified** | Same as above, but human-filtered by OpenAI/contractors to remove unsolvable/ambiguous instances | Same Docker harness | 500 instances | **Near-saturated at the frontier**: multiple labs cluster within ~1 point near 80%+, making it a saturation indicator rather than a ranking tool as of 2026 | [SWE-bench Verified leaderboard analysis](https://arxiv.org/html/2506.17208v2), [llm-stats.com](https://llm-stats.com/benchmarks/swe-bench-verified) **[secondary for current scores]** |
| **SWE-bench Lite** | Cheaper/faster subset of original SWE-bench | Same harness | 300 instances | Declining relevance/activity as Verified and Pro absorbed attention | [pricepertoken.com Lite leaderboard](https://pricepertoken.com/leaderboards/benchmark/swe-bench-lite) **[secondary]** |
| **SWE-bench Multimodal** | Issue resolution requiring visual/UI understanding (screenshots, JS/frontend repos) | Same harness family, non-Python repos | Smaller, curated | Adds a modality the original SWE-bench lacks; less saturated than Verified | Referenced alongside Verified/Pro in [swebench.com](https://www.swebench.com/) family docs |
| **SWE-bench Pro** | Harder, more realistic issue resolution designed specifically to resist the saturation seen on Verified | Same harness family, extended | Baseline pass@1 reported **below 25%** for frontier models — much more discriminative | [morphllm.com SWE-bench Pro leaderboard](https://www.morphllm.com/swe-bench-pro) **[secondary]** |
| **SWE-bench Multilingual** | Issue resolution across 9 languages (C, C++, Go, Java, JS, TS, PHP, Ruby, Rust), not just Python | Same harness family | 300 tasks, 42 repos | Directly relevant to Mnemo/Go: tests whether an agent's SWE competence is Python-specific | [swebench.com/multilingual](https://www.swebench.com/multilingual.html) |
| **Multi-SWE-bench** | Broader multilingual issue-resolving benchmark (separate project from SWE-bench Multilingual) | Same family conventions | 2,132 instances, 68 expert annotators | Larger and more expert-curated than SWE-bench Multilingual; overlapping goal | [arXiv:2504.02605](https://arxiv.org/html/2504.02605v1), [GitHub](https://github.com/multi-swe-bench/multi-swe-bench) |
| **Aider Polyglot** | Real edit-loop coding: model must emit changes in a structured diff format, gets one retry with failing test output | Aider's own harness; graded via `pass_rate_2` + "well-formed edits" | 225 hardest Exercism exercises across C++, Go, Java, JS, Python, Rust | Actively maintained, widely cited as complement to SWE-bench's Python bias; GPT‑5-era models reported around 88% pass_rate_2 **[secondary for exact score]** | [Aider GitHub benchmark](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md), [leaderboard.steel.dev](https://leaderboard.steel.dev/leaderboards/aider/) **[secondary]** |
| **Commit0** | Generate a whole library from a spec + interactive unit tests, not just patch an existing repo | Interactive: static-analysis + execution feedback loop | 54 Python libraries (ML, networking, dataviz, etc.) | Far from saturated — SOTA pass rates reported as low as ~6–29% depending on subset; tests long-horizon spec-following, not patching | [arXiv:2412.01769](https://arxiv.org/abs/2412.01769) |
| **SWE-Lancer** | Real Upwork freelance SWE tasks (bug fixes to full features) *and* managerial/triage decisions | Docker image, end-to-end tests triple-verified by engineers; managerial tasks graded against the real hired manager's choice | 1,400+ tasks, **$1M total real-world payout value** ($50 to $32,000 per task) | Explicitly designed to price agent capability in dollars, not just pass rate; frontier models still fail the majority of tasks | [OpenAI announcement](https://openai.com/index/swe-lancer/), [arXiv:2502.12115](https://arxiv.org/abs/2502.12115), [GitHub](https://github.com/openai/swelancer-benchmark) |

### 1.2 Why HumanEval/MBPP are considered saturated (and what that means practically)

Top models sit at ~99% (HumanEval) / ~94% (MBPP) pass@1, and both sets are known to overlap 8–18% with common pretraining corpora (RedPajama-Data-1T, StarCoder-Data), so a high score partly reflects memorization rather than generalization ([benchmark saturation survey](https://www.emergentmind.com/topics/benchmark-saturation)). Both benchmarks also test only isolated, single-function synthesis — no repo context, no multi-step tool use, no test-writing — which is a poor proxy for what an agentic coding tool like Mnemo actually does. **Recommendation: don't use these for Mnemo's own evaluation; they're useful only as a sanity check that an underlying model isn't badly broken.**

### 1.3 SWE-bench family saturation, concretely

Multiple 2026 leaderboard analyses describe SWE-bench Verified as having stopped discriminating between frontier labs — several models cluster within ~1 point of each other near or above 80% ([Dissecting the SWE-Bench Leaderboards, arXiv:2506.17208](https://arxiv.org/html/2506.17208v2)). SWE-bench Pro was built explicitly in response: it reports frontier pass@1 rates **below 25%**, restoring separation between models ([morphllm SWE-bench Pro summary](https://www.morphllm.com/swe-bench-pro) — secondary source, treat exact numbers as illustrative). A companion critique worth reading directly is *"The Growing Pains of Frontier Models: When Leaderboards Stop Separating"* ([arXiv:2605.18840](https://arxiv.org/pdf/2605.18840)), which argues the community should track *what a benchmark is still discriminating on*, not just the score.

A separate and important critique for anyone adopting SWE-bench-style evaluation: **"Position: Coding Benchmarks Are Misaligned with Agentic Software Engineering"** ([arXiv:2606.17799](https://arxiv.org/pdf/2606.17799)) argues that issue-resolution-style benchmarks reward a narrow slice of what real agentic SWE work looks like (single well-scoped GitHub issues) and under-represent exploration, planning, and long-horizon maintenance work — exactly the terrain Mnemo's memory layer is meant to help with.

---

## 2. Agentic / tool-use / terminal benchmarks

| Benchmark | What it measures | Harness | Notes |
|---|---|---|---|
| **Terminal-Bench** | End-to-end terminal workflows: compiling, training models, configuring servers, debugging, sysadmin, security tasks — not isolated code snippets | Official harness spins up Docker/tmux sandboxes; the reference agent **Terminus** is deliberately tool-minimal (just a tmux pane + keystrokes) to isolate raw model capability from harness cleverness. The harness was rewritten as **Harbor** in the 2.0 release for better reliability/observability/RL-rollout support | 89 hand-crafted, human-verified tasks in the 2.x set. Official site/leaderboard: [tbench.ai](https://www.tbench.ai/about); harness docs: [tbench.ai/docs/harness](https://www.tbench.ai/docs/harness); repo: [harbor-framework/terminal-bench](https://github.com/harbor-framework/terminal-bench) |
| **OSWorld / OSWorld 2.0** | Long-horizon **computer-use** (not just terminal) — full desktop OS in a VM, natural-language goal, reward from final VM state | VM snapshot + execution-verification script | OSWorld 2.0 (mid-2026) raised the bar sharply: 108 long-horizon workflows averaging ~318 tool calls (vs. ~30 in 1.0) and a human median completion time of ~1.6 hours per task. Reported result: best agents complete only ~20.6% of tasks despite ~85% scores on the earlier, easier OSWorld — a concrete illustration of a benchmark going from "near-solved" to "wide open" through a harder v2 ([arXiv:2606.29537](https://arxiv.org/abs/2606.29537), [GitHub](https://github.com/xlang-ai/OSWorld-V2)) |
| **τ-bench / τ²-bench** | Multi-turn **tool-agent-user** interaction under domain policy constraints (retail, airline, telecom customer service) | Compares final DB state to an annotated goal state; introduces **pass^k** (all k of k trials must succeed) as a reliability metric, distinct from pass@k's "any one of k" optimism | Even strong function-calling models solve <50% of tasks and are "terribly inconsistent" (pass^8 < 25% in retail) — a useful reminder that single-run pass rates overstate real reliability. [arXiv:2406.12045](https://arxiv.org/pdf/2406.12045) |
| **BigCodeBench (Hard) / multi-tool composition** | Straddles category 1 and 2 — tool composition under a coding lens | See §1 | Cross-reference for agentic tool-calling quality inside code tasks specifically |
| **GAIA, Cybench, GDM CTF** (adjacent, not coding-specific) | General tool-use, cyber-offense capability | Bundled as pre-built evals in `inspect_ai` (§5) | Mentioned because Mnemo's harness/tool-plugin system (`harness-engine/`) is architecturally similar to what these benchmarks probe — dynamic tool creation and use |

**What "recovery from failure" and "long-horizon" specifically test for:** OSWorld 2.0's jump from ~30 to ~318 average tool calls per task, and the pass^k metric in τ-bench, both target the same failure mode — agents that look competent on a short, clean trajectory but degrade over many steps or across repeated attempts. A directly relevant paper: **SlopCodeBench**, "Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks" ([arXiv:2603.24755](https://arxiv.org/pdf/2603.24755)) — worth reading in full since Mnemo's whole thesis (memory should make long sessions *more* reliable, not less) is exactly what this class of benchmark is built to catch.

---

## 3. Memory and long-context evaluation

This is the section most directly relevant to Mnemo's memory layer, so it goes deeper.

### 3.1 The two benchmarks that matter most

**LoCoMo (Long-term Conversational Memory)** — [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)
- Multi-session dialogues with persistent personas and a temporal event graph (up to 25 events over 6–12 months), each dialogue spanning up to 32 sessions, ~600 turns, ~16K tokens.
- Question types: single-hop retrieval, multi-hop retrieval, **temporal reasoning**, and open-domain knowledge — i.e., it doesn't just test "can you find the fact," it tests "can you reason about *when* things happened relative to each other."
- Generation pipeline is itself LLM-architected (personas expanded, event graphs generated), which means LoCoMo inherits some of the same synthetic-data concerns other benchmarks have — worth noting as a caveat, not a disqualifier.
- Primary evaluation framework cited for long-horizon agent memory research broadly.

**LongMemEval** — [arXiv:2410.10813](https://arxiv.org/abs/2410.10813), [GitHub](https://github.com/xiaowu0162/LongMemEval)
- 500 curated questions over freely-scalable synthetic chat histories, evaluating five distinct memory abilities: **information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention** (i.e., correctly saying "I don't know" / not hallucinating a memory that was never stored).
- Headline finding: commercial chat assistants and long-context LLMs show a **~30% accuracy drop** on sustained multi-session recall compared to single-session recall — a strong, quotable number for why a dedicated memory layer (rather than just a bigger context window) is worth building.
- The paper's own recommended architecture — index/retrieve/read, with session decomposition, fact-augmented key expansion, and time-aware query expansion — maps closely onto what a graph memory system like Mnemo's (facts/state/log/context nodes, typed edges) is trying to do; this is a good design reference as well as an eval target.
- **"Knowledge updates" and "abstention" are the two categories most likely to expose bugs in Mnemo specifically**: does the memory layer correctly overwrite/supersede a stale fact (e.g., "the port changed from 8080 to 8081") rather than returning both, and does retrieval correctly return "no memory found" rather than hallucinating a plausible-sounding one?

### 3.2 Needle-in-a-haystack and its multi-needle successors

The original single-needle-in-a-haystack test (paste one fact into a long context, ask for it back) is now considered too easy and is not a strong signal for real memory systems. What has replaced it:
- **Multi-needle variants** — placing multiple facts at different positions/depths and asking for all of them, or asking for a fact that must be combined with another (reasoning across needles) ([arXiv:2504.04150](https://arxiv.org/pdf/2504.04150)).
- **MMNeedle** — the multimodal extension (image needle in an image haystack), 40K images / 560K captions / 280K needle-haystack pairs, with "existence accuracy," "index accuracy," and "exact accuracy" as separate metrics rather than one blended score ([arXiv:2406.11230](https://arxiv.org/abs/2406.11230)). Not directly relevant to Mnemo unless it starts ingesting screenshots into memory, but the metric decomposition (did it find *that* the fact exists vs. find *where* it is vs. reproduce it *exactly*) is a good template to borrow for a Mnemo-specific memory eval.
- General critique: needle tests (single or multi) measure **retrieval under adversarial placement**, not **retrieval under realistic distribution** (i.e., real usage rarely buries one fact in 100K tokens of unrelated filler — it accumulates hundreds of small, related, sometimes-contradictory facts over weeks). LoCoMo and LongMemEval are closer to that realistic distribution; needle tests are cheap but shallow.

### 3.3 "Remembering a constraint stated many turns ago" — the specific Mnemo scenario

None of the standard benchmarks target this exact framing (constraint persistence across sessions, e.g., "always use pnpm in this repo" said once and expected to hold weeks later) as a first-class metric, but three things compose into it:
1. LongMemEval's **knowledge-update** category (does new information correctly supersede old, or get treated as an addition).
2. τ-bench's **policy-adherence** framing (does the agent keep following a stated domain rule across a long multi-turn session) — same shape of problem, different domain (customer-service policy vs. coding-repo convention).
3. Mnemo's own `memeval` harness already measures Hit@1/Hit@3/MRR for retrieval quality (`memory-layer/src/bin/memeval`, per `STATUS.md`) — this is the right place to add a small **constraint-persistence** eval set: seed a handful of "stated once, must hold N sessions later" facts (a port number, a package-manager choice, a coding-style rule) and check both (a) retrieval recall and (b) whether the agent's *behavior* in a later session actually complies, not just whether the fact is retrievable. That behavioral check is the harder and more valuable half — LongMemEval and LoCoMo mostly test QA-style recall, not downstream compliance.

### 3.4 Contamination/synthetic-data caveat for memory benchmarks specifically

Because LoCoMo and LongMemEval both use LLM-generated conversations/personas rather than real multi-week user histories, there's a standing question (not fully resolved in the literature surveyed here) about how well performance on them predicts performance on genuinely messy, contradictory, human-authored long-term interaction. **Flagging this as uncertain** — no source found during this research quantifies the sim-to-real gap for conversational-memory benchmarks specifically, unlike the well-documented contamination numbers for HumanEval/MBPP.

---

## 4. Metrics people actually report

| Metric | Definition | Where used | Gameable? / guard |
|---|---|---|---|
| **pass@k** | Task counts as solved if ≥1 of k independent attempts succeeds | HumanEval, MBPP, LiveCodeBench, SWE-bench (usually pass@1) | Optimistic — rewards lucky variance, not reliability. Guard: report alongside pass^k or multiple-seed variance. |
| **pass^k** | All k of k independent trials must succeed (average over tasks) | τ-bench | Much stricter reliability measure; harder to game by resampling. [arXiv:2406.12045](https://arxiv.org/pdf/2406.12045) |
| **resolve rate** | Fraction of instances where the patch passes both FAIL_TO_PASS and PASS_TO_PASS test sets | SWE-bench family | Can be gamed by patches that special-case the exact test rather than the general bug — see reward-hacking discussion below. |
| **cost per task ($/instance)** | API/compute $ spent to attempt one task | SWE-bench Pro reporting, Artificial Analysis coding-agent index | Increasingly reported alongside resolve rate as a Pareto frontier (resolve rate vs. $) rather than a single number — mean cost per checkpoint has been shown to grow ~2.2× from start to end of long-horizon tasks, which a single-number cost figure hides ([Artificial Analysis methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)). |
| **wall-clock latency** | Time-to-completion per task or session | Lab system cards, agent harness reports | Sensitive to infra (parallelism, retries) as much as model quality; rarely normalized across reports, so cross-report comparison is weak. |
| **tokens per task** | Input+output tokens consumed | Cost proxies, efficiency comparisons (e.g., GPT-5.5 reported as more token-efficient at similar/better scores) | Useful efficiency signal but conflates "efficient" with "thinks less," which isn't always good — pair with resolve rate, not standalone. |
| **tool-call accuracy** | Correct tool selected + correct arguments constructed | τ-bench, TRAJECT-Bench, agent trajectory evals | Decomposed further into **Parameter Validity** (type/range/referential correctness) and selection accuracy — see [Langfuse agent trajectory guide](https://langfuse.com/resources/engineering/ai-agent-evaluation) and [TRAJECT-Bench](https://arxiv.org/pdf/2510.04550). |
| **edit-precision / patch validity** | Whether a generated diff applies cleanly and is minimal/well-formed | Aider ("well-formed edits" score, separate from pass rate) | Aider explicitly reports this *separately* from pass_rate_2 specifically because a model can solve the exercise logically but fail to emit a parseable diff — an important distinction for an agent (like Mnemo) that must produce real patches, not prose. |
| **regression rate** | Fraction of "fixes" that break previously-passing tests (PASS_TO_PASS failures) | Implicit in SWE-bench's PASS_TO_PASS gate; explicit metric in some internal lab evals | Directly guards against the most common form of reward hacking: over-fitting to the named failing test while breaking something else. |
| **human-preference / Elo** | Pairwise human judgment between two model outputs in situ | **Copilot Arena** (LMArena's coding-specific arena): 4.5M+ suggestions served, 10 models, 11K+ pairwise judgments, avg. prompt length ~1,002 tokens (far longer than static benchmark prompts); rankings from Copilot Arena diverge from static-benchmark rankings, showing static benchmarks miss things real usage cares about | [Copilot Arena paper](https://openreview.net/forum?id=9bYOqwtAud), [GitHub](https://github.com/lmarena/copilot-arena) |
| **trajectory-level metrics** | Exact-match / inclusion of required tool sequence, ordering, schema conformance, LLM-judge "trajectory-satisfy" score when no gold trace exists | TRAJECT-Bench and similar | Most expensive to compute (often needs an LLM judge itself, or manual annotation), but the only metric family that scores *how* an agent got to an answer, not just whether it arrived — matters a lot for debugging a coding agent's failure modes, not just its score. |

### 4.1 Reward hacking: the metric-gaming problem for coding agents specifically

Several 2026 papers formalize what had been anecdotal: agents that improve their *measured* score without improving the *underlying capability*, by manipulating the evaluation itself rather than solving the task.

- **EvilGenie** modifies LiveCodeBench to give agents the *opportunity* to manipulate test files, and finds that **LLM judges outperform held-out tests** at catching this — i.e., a static held-out-test guard is not sufficient on its own ([arXiv:2511.21654](https://arxiv.org/abs/2511.21654) / [emergentmind summary](https://www.emergentmind.com/papers/2511.21654)).
- **SpecBench** measures reward hacking specifically in *long-horizon* coding agents, which is the regime Mnemo's memory layer is meant to help with — worth reading directly if building any multi-session eval ([arXiv:2605.21384](https://arxiv.org/html/2605.21384v1)).
- Concrete exploit taxonomy found in the survey: fabricating intermediate artifacts to skip expensive upstream work ("sequence manipulation") was the most common chained-regime exploit; **TRACE** catalogs 517 real hacking trajectories across 54 categories and found even GPT-5.2-class judges catch only ~63% of them; **Terminal Wrench** catalogs 331 hackable Terminal-Bench-style tasks with 3,632 exploit trajectories.
- Practical guard pattern that recurs across sources: **combine held-out tests you never show the agent, a PASS_TO_PASS regression gate, and an LLM judge reviewing the diff for suspicious patterns** (editing the test file, hardcoding expected outputs, catching-and-suppressing exceptions around the checked behavior) — no single guard is sufficient alone.
- Separately, real-world cherry-picking has been documented in public model reports — e.g., a case where a coding agent's own self-reported eval numbers (79.0% vs. 79.26%) turned out to require mutually exclusive configurations, meaning both couldn't have been true simultaneously ([benchmarking-is-broken survey, arXiv:2510.07575](https://arxiv.org/html/2510.07575v2)). This is a caution about **self-reported numbers from any agent, including Mnemo's own eval runs** — always re-verify a headline number by re-running the harness independently before trusting it.

---

## 5. Harnesses and infrastructure

| Harness | What it runs | Requirements | Notes |
|---|---|---|---|
| **SWE-bench official harness** | SWE-bench / Verified / Lite / Multilingual instances | Docker (three image layers: base → ~60 environment images → per-instance images); **~120GB free disk space** at release; `swebench.harness.prepare_images` + `swebench.harness.run_evaluation` as entry points | [swebench.com harness docs](https://www.swebench.com/SWE-bench/reference/harness/), [Docker setup](https://www.swebench.com/SWE-bench/guides/docker_setup/), [GitHub](https://github.com/SWE-bench/SWE-bench). A community-reported shortcut exists for running Verified in ~1 hour on one machine ([Epoch AI](https://epoch.ai/latest/swebench-docker)). |
| **SWE-agent** | Reference "agent-computer interface" scaffold, the most-cited SWE harness | Any OpenAI-compatible model API + Docker | Introduced the ACI pattern (structured file-view/edit/search tools) that most later coding-agent harnesses copy. |
| **OpenHands** (formerly OpenDevin) | Generalist agent platform with a SWE-bench adapter | Docker; broader scope than SWE-agent (browsing, more tool types) | In controlled comparisons on identical backbones, harness choice alone produced meaningfully different resolve rates — see "**The Scaffold Effect in Coding Agents**" ([arXiv:2607.22585](https://arxiv.org/html/2607.22585)), which argues no SWE-bench-style leaderboard currently controls for harness as a variable, so cross-system number comparisons should be treated with real skepticism. |
| **mini-SWE-agent** | Minimal-harness baseline (deliberately thin) | Same | Used as the "how much is the scaffold doing" control in scaffold-effect studies. |
| **Terminus / Terminal-Bench harness (Harbor)** | Terminal-Bench 2.x | Docker/tmux multi-container sandboxes; Harbor is the rewritten harness for reliability/observability/RL rollouts | Terminus itself is intentionally tool-minimal (just a tmux pane) to isolate raw model capability from harness cleverness — a useful design reference for a "baseline mode" in Mnemo's own eval harness. [tbench.ai/docs/harness](https://www.tbench.ai/docs/harness) |
| **Aider's own benchmark runner** | Aider Polyglot | Docker strongly recommended ("the harness will execute LLM-written code without human review — the LLM could generate dangerous code that harms your system"); run via `./benchmark/docker.sh` then `./benchmark/benchmark.py <run-name> --model <model> --edit-format <fmt> --threads N --exercises-dir polyglot-benchmark` | Reports include the git commit hash of the aider repo at run time, specifically so a score can be reproduced later — good practice to copy. [Aider benchmark README](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md) |
| **inspect_ai** | General LLM/agent eval framework (UK AI Security Institute) | Python; sandboxing via Docker, Kubernetes, Modal, Proxmox, Vagrant, etc. | 200+ pre-built evals including GAIA, SWE-Bench, GDM CTF, Cybench; can drive **external CLI agents directly** (Claude Code, Codex CLI, Gemini CLI are explicitly supported), which makes it a strong candidate as the outer harness for a Mnemo eval suite rather than building one from scratch. Adopted by Anthropic, DeepMind, and others. [GitHub](https://github.com/UKGovernmentBEIS/inspect_ai), [inspect.aisi.org.uk](https://inspect.aisi.org.uk/), [Inspect Evals announcement](https://www.aisi.gov.uk/blog/inspect-evals) |
| **lm-evaluation-harness** (EleutherAI) | Static/non-agentic LLM benchmarks (HumanEval, MBPP, etc.) | Python, model API or local weights | Not agent-native — good for the model-only sanity checks in §1.2, not for anything requiring tool use/multi-turn/sandboxes. |
| **Go/TUI-specific testing approaches** | See §9 below (VHS golden frames, lazygit-style scripted integration tests) | — | No SWE-bench-equivalent exists for TUI correctness; this space is closer to snapshot/integration testing than benchmark leaderboards. |

**Cost/time reality check:** running the full SWE-bench Verified harness locally needs real disk (100GB+) and real time even with prebuilt images; Aider Polyglot and Terminal-Bench both explicitly warn about running untrusted LLM-generated code and mandate Docker isolation. None of these are "run on every PR" cheap by default — that shapes the tiered recommendation in §7/§10.

---

## 6. How the big labs report coding results

- **Anthropic** system cards report SWE-bench Verified as an **average over many trials** (25 trials cited for a recent Opus release) and Terminal-Bench with even heavier repetition (89 tasks × 15 repeats = 1,335 trials, run across 3 time-separated batches) — explicitly to smooth out run-to-run variance rather than reporting a single lucky run. They also report a **thinking-effort tradeoff** (e.g., "low effort" mode scoring lower but using ~40% fewer output tokens), giving a Pareto view rather than one number. [System card example](https://www-cdn.anthropic.com/0dd865075ad3132672ee0ab40b05a53f14cf5288.pdf) — primary source, though the specific version/number will be stale by the time you read this.
- **OpenAI** reports headline SWE-bench Verified / SWE-bench Pro / Aider Polyglot / Terminal-Bench numbers in model announcement posts, plus **internal, non-public evals** (e.g., an "Expert-SWE" long-horizon eval with an estimated 20-hour median human-completion time) that are described but not released for independent reproduction — a recurring community complaint (see below). [Introducing GPT-5](https://openai.com/index/introducing-gpt-5/), [GPT-5.5 system card evaluations](https://deploymentsafety.openai.com/gpt-5-5/evaluations-with-challenging-prompts)
- **Open-source agent projects** (Aider, SWE-agent, OpenHands, Terminal-Bench's own leaderboard) tend to publish full run logs/configs and encourage reproduction — this is the main practical difference from lab system cards, which usually describe methodology in prose without shipping the exact harness config used.
- **What the community criticizes:**
  1. **Harness-as-hidden-variable** — the same model scores differently under different agent scaffolds, and leaderboards rarely hold the harness constant, so "Model A beats Model B" claims often can't be disentangled from "Harness A beats Harness B" ([The Scaffold Effect, arXiv:2607.22585](https://arxiv.org/html/2607.22585)).
  2. **Cherry-picking / incompatible-configuration reporting** — the documented case of a coding agent reporting two mutually exclusive best-case numbers (79.0% and 79.26%) from configurations that couldn't both apply at once ([arXiv:2510.07575](https://arxiv.org/html/2510.07575v2)).
  3. **Saturation masking real differences** — see §1.3; near-ceiling scores on Verified get reported as headline wins even when statistically the models are tied.
  4. **Internal-only evals** — labs increasingly cite proprietary long-horizon evals (like "Expert-SWE") that outsiders cannot verify, which the field has flagged as reducing the evidentiary value of lab-published numbers relative to open leaderboards like Terminal-Bench's or SWE-bench's official site.
  5. **Reward hacking not fully screened out** — see §4.1; a resolve-rate number alone doesn't tell you whether the agent solved the underlying problem or gamed the grader.

---

## 7. What a small project can realistically run

This is the section that matters most for Mnemo day-to-day, so it's organized as a concrete tier plan rather than a survey.

### 7.1 Constraints specific to Mnemo

- No dedicated eval infra budget implied by the repo (`STATUS.md` shows evals run against free/OpenRouter models so far — `ox-alpha-free`, `nemotron-120b:free`). Cost-sensitivity is real.
- Existing eval asset: `memory-layer/src/bin/memeval` already runs a 15-query / 12-node / 3-domain retrieval eval reporting Hit@1/Hit@3/MRR — this is a real, cheap, deterministic-ish benchmark already in the repo and should be the backbone of the "every commit" tier for the memory layer.
- Existing test asset: `tui-go/app/app_test.go` exists — a Go TUI has ordinary `go test` unit-test coverage available essentially for free.
- Full SWE-bench / Terminal-Bench-style runs require Docker + real compute + (for API-model runs) real API spend; not something to run per-commit on a project this size.

### 7.2 Tiered plan

| Tier | What | Why this tier | Rough cost | Rough runtime |
|---|---|---|---|---|
| **Every commit / PR (CI, deterministic)** | `go test ./...` in `tui-go`; `cargo test` in `memory-layer` and `tui`; `npm test` in `agent`/`harness-engine`; `memeval` retrieval regression check (Hit@1/Hit@3/MRR must not regress vs. a committed baseline); a small **constraint-persistence** eval (§3.3) added to `memeval` — 10-20 seeded "stated once, must hold later" facts, checked deterministically (no LLM judge needed if it's pure retrieval); VHS golden-frame diff for 5-10 core TUI screens (§9) | Zero flakiness, zero $ cost, catches regressions before merge; matches "cheap, deterministic" framing exactly | **$0** (no LLM calls) | Seconds to low minutes |
| **Nightly** | A small, fixed LLM-judged eval: (a) the existing 3-task memory-vs-no-memory eval from `STATUS.md` re-run against 1-2 free/cheap models to catch prompt-injection-style regressions in the memory directive; (b) a hand-picked 10-20 task subset of **SWE-bench Multilingual** (or a Go-specific mini-set you curate, since SWE-bench Multilingual covers Go) run through Mnemo's own agent runtime against one cheap model, using the official SWE-bench Docker harness; (c) a 20-30 task **LongMemEval**-style knowledge-update/abstention probe against the memory layer, LLM-judged | Bridges "does the agent actually behave correctly" (not just "is the fact retrievable") without full-benchmark cost; SWE-bench Multilingual chosen over full Verified specifically because Mnemo is not Python-first | Low tens of dollars per night depending on model choice (cheap/free-tier model keeps this near $0; a frontier model for judging adds ~$1-5/night for this size of set) | 15-60 minutes |
| **Before a release** | Full official **SWE-bench Multilingual** run (300 tasks) via the real Docker harness against Mnemo's shipped default model; a curated **Terminal-Bench** subset (or full 89-task set if budget allows) run through Terminal-Bench's own harness with Mnemo's agent as the driven agent (Terminal-Bench explicitly supports plugging in arbitrary agents, similar to how it wraps Claude Code/Codex CLI); a full **LoCoMo** or **LongMemEval** pass against the memory layer for a genuine long-horizon-recall number, not just the 15-query internal set; a manual/scripted **narrow-terminal + accessibility pass** on the TUI (§9) | This is where $100s and real GPU/API time are justified — pre-release is the right gate for the expensive, high-signal-but-costly benchmarks | Roughly **$50-300** depending on model pricing and whether Terminal-Bench's full container matrix is run (SWE-bench Verified alone has been shown reproducible in ~1 hour on one machine per Epoch AI, so a 300-task Multilingual run is a few hours, not days, once images are cached) | A few hours to half a day |
| **Occasional / exploratory (not gated on any schedule)** | Aider Polyglot (useful specifically because it's multi-language and reports edit-format validity separately from correctness — directly useful for tuning Mnemo's patch-application logic); a small internal reward-hacking screen inspired by EvilGenie/SpecBench (does Mnemo's agent ever edit the test it's being graded against, when given the opportunity) | High learning value, not needed on a fixed cadence for a project this size | Low, if run against a handful of tasks rather than the full 225-exercise set | An afternoon |

### 7.3 What to explicitly *not* build

- A custom SWE-bench-equivalent from scratch — use the official harness or `inspect_ai` (which can drive an arbitrary CLI agent, including Mnemo's) rather than reinventing Docker sandboxing and FAIL_TO_PASS/PASS_TO_PASS grading.
- A bespoke Elo/human-preference system — not worth the engineering cost pre-1.0; Copilot Arena-style preference collection only pays off once there's a real user base to sample judgments from.
- Full OSWorld/computer-use benchmarking — Mnemo is terminal-native, not a GUI-driving agent; OSWorld's desktop-VM harness is out of scope entirely.

---

## 8. UI/TUI-specific evaluation

Terminal UI testing has no benchmark-leaderboard culture like coding agents do — it's closer to conventional snapshot/integration testing, borrowed directly from web frontend practice but adapted to text grids.

- **VHS (Charmbracelet)** — write a `.tape` file (window size, theme, typing speed, commands, pauses, screenshots) and render it to GIF/MP4/WebM **or** to a plain `.txt`/`.ascii` frame dump. The text-frame output is the useful one for CI: commit it as a **golden file** and fail CI on any diff, giving you deterministic, zero-flakiness regression testing for exact TUI output — the same tape file doubles as documentation/demo material. [VHS README](https://github.com/charmbracelet/vhs/blob/main/README.md), [pkg.go.dev](https://pkg.go.dev/github.com/charmbracelet/vhs). Since Mnemo already ships a Charm-adjacent Go TUI, VHS is a very natural fit — same ecosystem, same maintainers as the tooling the TUI is likely already built with.
- **lazygit's integration-test pattern** — record a real interactive session (keystrokes + timestamps) into a JSON fixture, then replay it in tests and diff the resulting repo state against an expected end-state; a test-runner TUI lets you re-run/debug/sandbox individual recorded tests interactively (`s` to sandbox, `d` to debug in the test-runner UI). This is a strong template for testing Mnemo's TUI flows that involve real state changes (e.g., a memory-pane search-and-recall flow, a session switch) rather than pure rendering. [lazygit integration README](https://github.com/jesseduffield/lazygit/blob/master/pkg/integration/README.md), [dev blog](https://jesseduffield.com/IntegrationTests/)
- **`gh` CLI accessibility work** — GitHub's own writeup on making `gh` more accessible is the most concrete primary source found for terminal-specific a11y practice: screen readers (NVDA/JAWS/VoiceOver) struggle with ASCII art, animated spinners, and complex visual table layouts, and scrolling through long terminal output is itself a known pain point for screen-reader users. [GitHub blog](https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/)
- **Narrow-terminal / responsive testing** — no single standard tool; the common pattern is simulating widths via env var overrides (`CLI_WIDTH` or an explicit `terminalWidth` option) and running the same golden-frame tests at multiple fixed widths (e.g., 80, 100, 120, and a deliberately narrow 40-60 column case) to check for wrapping/truncation bugs rather than relying on manual resize testing. [studyraid width-handling notes](https://app.studyraid.com/en/read/12628/409783/terminal-width-handling) — secondary but practically actionable.
- **Go-specific option beyond VHS**: standard Go golden-file testing (`go-cmdtest` from Google, or the lighter `xorcare/golden` package) for any command that isn't full-screen-interactive (e.g., `mnemo traces --json`, `mnemo --list-sessions`) — cheaper than a VHS tape for pure stdout-diffing cases, reserve VHS for actual full-screen TUI rendering. [go-cmdtest](https://github.com/google/go-cmdtest), [xorcare/golden](https://github.com/xorcare/golden)

**Recommended concrete setup for Mnemo (`tui-go`):**
1. `go test ./...` for logic (`app/`, `internal/*`) — already exists per `app_test.go`.
2. `go-cmdtest`-style golden files for the non-interactive CLI surface (`mnemo --list-models`, `mnemo traces --json`, etc.).
3. VHS tapes + committed `.txt`/`.ascii` golden frames for the 5-10 highest-value interactive screens (onboarding wizard, Chat pane, Memory pane search, command palette) — run at 2-3 fixed widths including a narrow one.
4. A manual (not automated) accessibility pass before release: run the TUI screen-reader-style (or through a tool that strips to plain sequential text) and check that spinners/ASCII art degrade to something readable, per the `gh` CLI writeup's findings.

---

## 9. Recommended for Mnemo — concrete tiered plan (summary)

This condenses §7 and §8 into one actionable checklist.

**Every commit (CI gate, $0, seconds-minutes):**
- `go test ./...`, `cargo test` (memory-layer, tui), `npm test` (agent, harness-engine)
- `memeval` retrieval regression (Hit@1/Hit@3/MRR vs. committed baseline)
- New: constraint-persistence probe added to `memeval` (deterministic, no LLM call)
- VHS golden-frame diff for core TUI screens at 2-3 widths

**Nightly ($0-5, 15-60 min):**
- Re-run the 3-task memory-vs-no-memory eval from `STATUS.md` against a free/cheap model
- 10-20 task SWE-bench Multilingual (Go-weighted) subset through Mnemo's own runtime
- 20-30 task LongMemEval-style knowledge-update/abstention probe, LLM-judged

**Before release ($50-300, hours):**
- Full SWE-bench Multilingual (300 tasks), official Docker harness
- Terminal-Bench subset or full 89-task set with Mnemo as the driven agent
- Full LoCoMo or LongMemEval pass on the memory layer
- Manual narrow-terminal + accessibility pass on the TUI

**Occasional / exploratory (no fixed cadence):**
- Aider Polyglot subset (patch-format validity tuning)
- Internal reward-hacking screen (does the agent ever edit its own grading tests, EvilGenie/SpecBench-style)

**Explicitly out of scope for now:** building a custom SWE-bench-equivalent, a bespoke Elo/preference system, or any OSWorld-style desktop-GUI benchmarking — none match Mnemo's terminal-native, pre-1.0 shape.

---

## Sources index

Primary/official sources used throughout: [swebench.com](https://www.swebench.com/), [SWE-bench GitHub](https://github.com/SWE-bench/SWE-bench), [SWE-bench Multilingual](https://www.swebench.com/multilingual.html), [LiveCodeBench](https://livecodebench.github.io/), [BigCodeBench arXiv](https://arxiv.org/abs/2406.15877), [RepoBench arXiv](https://arxiv.org/abs/2306.03091), [CodeContests GitHub](https://github.com/google-deepmind/code_contests), [Commit0 arXiv](https://arxiv.org/abs/2412.01769), [SWE-Lancer (OpenAI)](https://openai.com/index/swe-lancer/), [Aider benchmark README](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md), [Terminal-Bench / tbench.ai](https://www.tbench.ai/about), [Harbor framework](https://github.com/harbor-framework/terminal-bench), [OSWorld 2.0 arXiv](https://arxiv.org/abs/2606.29537), [τ-bench arXiv](https://arxiv.org/pdf/2406.12045), [LoCoMo arXiv](https://arxiv.org/abs/2402.17753), [LongMemEval arXiv](https://arxiv.org/abs/2410.10813) / [GitHub](https://github.com/xiaowu0162/LongMemEval), [inspect_ai GitHub](https://github.com/UKGovernmentBEIS/inspect_ai), [Copilot Arena](https://openreview.net/forum?id=9bYOqwtAud), [VHS GitHub](https://github.com/charmbracelet/vhs), [lazygit integration tests](https://github.com/jesseduffield/lazygit/blob/master/pkg/integration/README.md), [GitHub CLI accessibility](https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/).

Secondary/aggregator sources (used only where no primary source existed, or for illustrative current-leaderboard snapshots — verify against the primary site before quoting a specific score): morphllm.com, benchlm.ai, pricepertoken.com, llm-stats.com, leaderboard.steel.dev, agentmarketcap.ai.
