/**
 * Automatic recall: memory retrieved for the user's message and injected into
 * the system prompt, instead of asking the model to go and fetch it.
 *
 * Every test drives a fake client, so no memsrv, no journal and no embeddings
 * are involved — what is under test is the selection and the rendering.
 */
import { test } from "node:test";
import assert from "node:assert";
import { recallFor, selectRecall, summariseState, MEMORY_DIRECTIVE,
         type Recalled, type MemResult } from "../extensions/memory-layer.ts";

function hit(label: string, score: number, state = `[Aspect] ${label}\nfacts:\n  - k: v`): Recalled {
  return { kind: "Aspect", label, node: 1, score, state };
}

function client(results: Recalled[] | Error): { request: (m: string, p?: any) => Promise<MemResult> } {
  return {
    request: async () => {
      if (results instanceof Error) throw results;
      return { ok: true, result: { results } };
    },
  };
}

test("a real question pulls its memory into the prompt", async () => {
  const out = await recallFor(client([hit("deploy-window", 0.5)]), "when is the deploy window");
  assert.match(out, /Recalled from memory/);
  assert.match(out, /deploy-window/);
  assert.match(out, /candidates, not established/, "retrieval is a guess and must say so");
});

test("a greeting searches for nothing", async () => {
  // searching on "hi" returns whatever is nearest to noise, which is worse
  // than returning nothing: it puts an irrelevant fact in front of the model
  let called = false;
  const c = { request: async () => { called = true; return { ok: true, result: { results: [] } }; } };
  for (const short of ["hi", "ok thanks", "  ", "yes"]) {
    assert.equal(await recallFor(c, short), "");
  }
  assert.equal(called, false, "not even a search is issued");
});

test("nothing found means nothing injected", async () => {
  assert.equal(await recallFor(client([]), "what is the deploy window"), "");
});

test("a broken sidecar costs the turn nothing", async () => {
  // memory is a convenience here; a dead memsrv must not fail the message
  assert.equal(await recallFor(client(new Error("memsrv exited")), "what is the deploy window"), "");
  const notOk = { request: async () => ({ ok: false, error: "no such method" }) };
  assert.equal(await recallFor(notOk, "what is the deploy window"), "");
});

test("the long tail is dropped relative to the best hit, not by a tuned constant", () => {
  // the score scale depends on the embedding backend, so an absolute floor
  // would be tuned to whichever one happened to be configured
  const picked = selectRecall([hit("a", 0.50), hit("b", 0.42), hit("c", 0.11), hit("d", 0.02)]);
  assert.deepEqual(picked.map((h) => h.label), ["a", "b"]);

  // the same shape an order of magnitude down behaves identically
  const small = selectRecall([hit("a", 0.050), hit("b", 0.042), hit("c", 0.011)]);
  assert.deepEqual(small.map((h) => h.label), ["a", "b"]);

  // and k still caps a flat field of equally good hits
  const flat = selectRecall([hit("a", 0.5), hit("b", 0.5), hit("c", 0.5), hit("d", 0.5)]);
  assert.equal(flat.length, 3);
});

test("hits are ranked before they are cut", () => {
  const picked = selectRecall([hit("low", 0.1), hit("best", 0.9), hit("mid", 0.7)]);
  assert.deepEqual(picked.map((h) => h.label), ["best", "mid"]);
});

test("one fat node cannot eat the context window", () => {
  const huge = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const out = summariseState(huge);
  assert.ok(out.length <= 402, `budgeted, got ${out.length}`);
  assert.ok(out.endsWith("…"), "and says it was cut");
  // blank lines are noise, not content
  assert.equal(summariseState("a\n\n\nb"), "a\nb");
});

test("the directive no longer demands a search that already happened", () => {
  // it used to say ALWAYS call memory_search before answering: a whole extra
  // round trip on every single turn, for something now already in the prompt
  assert.doesNotMatch(MEMORY_DIRECTIVE, /ALWAYS call memory_search BEFORE/);
  assert.match(MEMORY_DIRECTIVE, /memory_search/, "it is still available on demand");
  assert.match(MEMORY_DIRECTIVE, /never claim you lack information without searching/i);
});

/**
 * Retrieval is only exposure. The lifecycle hook can credit later use, but
 * recall itself must not train the ranking on its own choices.
 */
function hitNode(label: string, score: number, node: number): Recalled {
  return { kind: "Aspect", label, node, score, state: `[Aspect] ${label}\nfacts:\n  - k: v` };
}

test("retrieval alone never earns usefulness votes", async () => {
  const votes: Array<[string, any]> = [];
  const c = {
    request: async (m: string, p?: any) => {
      if (m === "search") {
        return { ok: true, result: { results: [hitNode("a", 0.5, 11), hitNode("b", 0.4, 22), hitNode("c", 0.2, 33)] } };
      }
      votes.push([m, p]);
      return { ok: true, result: {} };
    },
  };
  const out = await recallFor(c, "when is the deploy window");
  assert.match(out, /Recalled from memory/);
  assert.deepEqual(votes, []);
});

test("a failing vote never breaks the recall path", async () => {
  const c = {
    request: async (m: string) => {
      if (m === "search") return { ok: true, result: { results: [hit("a", 0.5), hit("b", 0.4)] } };
      throw new Error("sidecar died mid-vote");
    },
  };
  const out = await recallFor(c, "when is the deploy window");
  assert.match(out, /Recalled from memory/, "votes must be fire-and-forget");
});
