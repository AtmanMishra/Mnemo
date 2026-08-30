/**
 * 4.2: web_fetch / web_search. No test here touches the network — fetch is
 * injected, so a broken build never turns into a flaky suite or a surprise
 * outbound request from CI.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  NO_SEARCH_KEY_MESSAGE, assertFetchableUrl, fetchUrl, formatHits, htmlToText,
  pickSearchProvider, search, truncate, webSearchTool, type FetchLike,
} from "../src/tools/web.ts";
import { textOf } from "../src/tools/types.ts";

function reply(body: string, contentType = "text/html", ok = true, status = 200) {
  return {
    ok, status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
function fakeFetch(res: any, seen?: { url?: string; init?: any }): FetchLike {
  return async (url, init) => {
    if (seen) { seen.url = url; seen.init = init; }
    return res;
  };
}

test("html is reduced to readable text", () => {
  const html = `
    <html><head><style>.a{color:red}</style><script>var x = "<p>not text</p>";</script></head>
    <body><h1>Title</h1><p>First para</p><p>Second &amp; last</p>
    <ul><li>one</li><li>two</li></ul></body></html>`;
  const text = htmlToText(html);
  assert.match(text, /Title/);
  assert.match(text, /First para/);
  assert.match(text, /Second & last/, "entities are decoded");
  assert.doesNotMatch(text, /not text/, "script bodies must not become content");
  assert.doesNotMatch(text, /color:red/, "style bodies must not become content");
  assert.doesNotMatch(text, /<[a-z]/i, "no tags survive");
  // block elements become line breaks so the text is not one long run
  assert.ok(text.split("\n").length >= 4, text);
});

test("entity decoding handles numeric and unknown forms", () => {
  assert.equal(htmlToText("a &#65; b"), "a A b");
  assert.equal(htmlToText("a &#x41; b"), "a A b");
  assert.equal(htmlToText("100 &unknownentity; x"), "100 &unknownentity; x");
  assert.equal(htmlToText("&#x110000;"), "&#x110000;", "out-of-range code points stay literal");
});

test("only http and https are fetchable", () => {
  assert.equal(assertFetchableUrl("https://example.com/a").protocol, "https:");
  assert.equal(assertFetchableUrl("http://example.com").protocol, "http:");
  // file:// would be read_file wearing a hat, and it would dodge the workspace root
  assert.throws(() => assertFetchableUrl("file:///etc/passwd"), /only http and https/);
  assert.throws(() => assertFetchableUrl("data:text/html,<b>x</b>"), /only http and https/);
  assert.throws(() => assertFetchableUrl("not a url"), /not a valid URL/);
});

test("fetch returns text, and non-html is left alone", async () => {
  const html = await fetchUrl("https://example.com", 1000, fakeFetch(reply("<p>hello</p>")));
  assert.equal(html, "hello");

  const json = await fetchUrl("https://example.com/a.json", 1000,
    fakeFetch(reply('{"a": 1}', "application/json")));
  assert.equal(json, '{"a": 1}', "non-html must not be run through the tag stripper");
});

test("an http error is an error, not an empty page", async () => {
  await assert.rejects(
    () => fetchUrl("https://example.com", 1000, fakeFetch(reply("nope", "text/html", false, 404))),
    /HTTP 404/,
  );
});

test("long pages are truncated with a visible marker", async () => {
  const long = "x".repeat(5000);
  const out = await fetchUrl("https://example.com", 100, fakeFetch(reply(long, "text/plain")));
  assert.ok(out.length < 300, `expected truncation, got ${out.length} chars`);
  assert.match(out, /truncated 4900 more characters/);
  assert.equal(truncate("short", 100), "short", "short text is untouched");
});

test("provider selection prefers brave and reports when unset", () => {
  assert.equal(pickSearchProvider({ BRAVE_API_KEY: "k" } as NodeJS.ProcessEnv), "brave");
  assert.equal(pickSearchProvider({ TAVILY_API_KEY: "k" } as NodeJS.ProcessEnv), "tavily");
  assert.equal(
    pickSearchProvider({ BRAVE_API_KEY: "k", TAVILY_API_KEY: "k" } as NodeJS.ProcessEnv),
    "brave",
  );
  assert.equal(pickSearchProvider({} as NodeJS.ProcessEnv), null);
});

test("brave results are normalised to title/url/snippet", async () => {
  const seen: { url?: string; init?: any } = {};
  const body = JSON.stringify({
    web: { results: [
      { title: "One", url: "https://a", description: "first &amp; best" },
      { title: "Two", url: "https://b", description: "second" },
      { title: "Three", url: "https://c", description: "third" },
    ] },
  });
  const hits = await search("helm rollback", 2,
    { BRAVE_API_KEY: "secret" } as NodeJS.ProcessEnv,
    fakeFetch(reply(body, "application/json"), seen));

  assert.equal(hits.length, 2, "count is respected");
  assert.deepEqual(hits[0], { title: "One", url: "https://a", snippet: "first & best" });
  assert.match(seen.url ?? "", /q=helm%20rollback/, "the query is url-encoded");
  assert.equal(seen.init?.headers?.["X-Subscription-Token"], "secret");
});

test("tavily results are normalised the same way", async () => {
  const seen: { url?: string; init?: any } = {};
  const body = JSON.stringify({ results: [{ title: "T", url: "https://t", content: "snip" }] });
  const hits = await search("q", 5, { TAVILY_API_KEY: "tk" } as NodeJS.ProcessEnv,
    fakeFetch(reply(body, "application/json"), seen));
  assert.deepEqual(hits, [{ title: "T", url: "https://t", snippet: "snip" }]);
  assert.equal(seen.init?.method, "POST");
  assert.match(String(seen.init?.body), /"query":"q"/);
});

test("search without a key explains what to set instead of throwing at the model", async () => {
  await assert.rejects(() => search("q", 5, {} as NodeJS.ProcessEnv, fakeFetch(reply("{}"))),
    /BRAVE_API_KEY or TAVILY_API_KEY/);

  // the tool itself answers rather than failing, so the model can adapt
  const saved = { b: process.env.BRAVE_API_KEY, t: process.env.TAVILY_API_KEY };
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    const res = await webSearchTool.execute("id", { query: "anything" });
    assert.equal(textOf(res), NO_SEARCH_KEY_MESSAGE);
  } finally {
    if (saved.b) process.env.BRAVE_API_KEY = saved.b;
    if (saved.t) process.env.TAVILY_API_KEY = saved.t;
  }
});

test("hits render as a numbered list a model can act on", () => {
  const out = formatHits([{ title: "One", url: "https://a", snippet: "s" }]);
  assert.match(out, /1\. One/);
  assert.match(out, /https:\/\/a/, "the url must be there to feed web_fetch");
  assert.equal(formatHits([]), "no results");
});
