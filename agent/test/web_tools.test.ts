/**
 * 4.2: web_fetch / web_search. No test here touches the network — fetch is
 * injected, so a broken build never turns into a flaky suite or a surprise
 * outbound request from CI.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  NO_SEARCH_KEY_MESSAGE, assertFetchableUrl, assertSsrfSafeUrl, fetchUrl, formatHits,
  htmlToText, isBlockedAddress, pickSearchProvider, search, truncate, webSearchTool,
  type FetchLike, type HostResolver,
} from "../src/tools/web.ts";
import { textOf } from "../src/tools/types.ts";

/** Public resolver: no test in this file touches DNS or the network. */
const pub: HostResolver = async () => ["93.184.216.34"];

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
  const html = await fetchUrl("https://example.com", 1000, fakeFetch(reply("<p>hello</p>")), pub);
  assert.equal(html, "hello");

  const json = await fetchUrl("https://example.com/a.json", 1000,
    fakeFetch(reply('{"a": 1}', "application/json")), pub);
  assert.equal(json, '{"a": 1}', "non-html must not be run through the tag stripper");
});

test("an http error is an error, not an empty page", async () => {
  await assert.rejects(
    () => fetchUrl("https://example.com", 1000, fakeFetch(reply("nope", "text/html", false, 404)), pub),
    /HTTP 404/,
  );
});

test("long pages are truncated with a visible marker", async () => {
  const long = "x".repeat(5000);
  const out = await fetchUrl("https://example.com", 100, fakeFetch(reply(long, "text/plain")), pub);
  assert.ok(out.length < 300, `expected truncation, got ${out.length} chars`);
  assert.match(out, /truncated 4900 more characters/);
  assert.equal(truncate("short", 100), "short", "short text is untouched");
});

// --- 12.4 (3927a1ac): SSRF filter ------------------------------------------

test("private, loopback and reserved addresses are blocked", () => {
  for (const a of [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0",
    "100.64.0.1", "::1", "::", "fc00::1", "fdab::", "fe80::1", "febf::1", "::ffff:127.0.0.1",
    "[::1]",
  ]) {
    assert.ok(isBlockedAddress(a), `${a} must be blocked`);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:2800::1", "example.com"]) {
    assert.equal(isBlockedAddress(a), false, `${a} is public`);
  }
});

test("localhost and metadata URLs are rejected before any fetch", async () => {
  let fetched = 0;
  const never: FetchLike = async () => { fetched += 1; throw new Error("must not be called"); };
  for (const url of [
    "http://localhost:8080/admin",
    "http://127.0.0.1:3000/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/internal",
    "http://[::1]/",
    "http://[fc00::5]/x",
  ]) {
    await assert.rejects(() => fetchUrl(url, 1000, never, pub), /SSRF filter/);
  }
  assert.equal(fetched, 0, "a blocked URL must never reach the network");
});

test("a DNS name that resolves private is rejected (the classic SSRF bounce)", async () => {
  const evil: HostResolver = async () => ["10.0.0.5"];
  await assert.rejects(
    () => fetchUrl("http://innocent.example.com/", 1000, fakeFetch(reply("x")), evil),
    /resolves to private\/reserved 10\.0\.0\.5/,
  );
  // any one private address among several is enough to block
  const mixed: HostResolver = async () => ["93.184.216.34", "169.254.169.254"];
  await assert.rejects(
    () => fetchUrl("http://innocent.example.com/", 1000, fakeFetch(reply("x")), mixed),
    /SSRF filter/,
  );
});

test("every redirect hop is re-validated: a bounce to internal is stopped", async () => {
  const hops: string[] = [];
  const redirecting: FetchLike = async (url) => {
    hops.push(String(url));
    if (String(url).includes("public.example.com")) {
      return {
        ok: false, status: 302,
        headers: { get: (n: string) => (n.toLowerCase() === "location" ? "http://169.254.169.254/steal" : null) },
        text: async () => "",
        json: async () => ({}),
      };
    }
    return reply("should never be read");
  };
  await assert.rejects(
    () => fetchUrl("http://public.example.com/a", 1000, redirecting, pub),
    /SSRF filter/,
  );
  assert.equal(hops.length, 1, "the internal hop must be blocked before fetching it");
});

test("benign redirects are followed, including relative ones", async () => {
  const seen: string[] = [];
  const redirecting: FetchLike = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith("/a")) {
      return {
        ok: false, status: 301,
        headers: { get: (n: string) => (n.toLowerCase() === "location" ? "./final" : null) },
        text: async () => "",
        json: async () => ({}),
      };
    }
    return reply("<p>landed</p>");
  };
  const out = await fetchUrl("http://ok.example.com/a", 1000, redirecting, pub);
  assert.equal(out, "landed");
  assert.deepEqual(seen, ["http://ok.example.com/a", "http://ok.example.com/final"],
    "a relative Location resolves against the hop that issued it");
});

test("redirect chains have a hard cap", async () => {
  const loop: FetchLike = async () => ({
    ok: false, status: 302,
    headers: { get: (n: string) => (n.toLowerCase() === "location" ? "http://ok.example.com/next" : null) },
    text: async () => "",
    json: async () => ({}),
  });
  await assert.rejects(
    () => fetchUrl("http://ok.example.com/start", 1000, loop, pub),
    /too many redirects/,
  );
});

test("assertSsrfSafeUrl returns the parsed URL for a safe target", async () => {
  const u = await assertSsrfSafeUrl("https://example.com/a?b=c", pub);
  assert.equal(u.hostname, "example.com");
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
