/**
 * 4.2 web_fetch / web_search.
 *
 * web_fetch works with no configuration at all — Node has fetch built in and
 * HTML is reduced to text here rather than by a dependency.
 *
 * web_search needs a provider key (BRAVE_API_KEY or TAVILY_API_KEY). Without
 * one the tool still registers and returns a message saying exactly what to
 * set, which is more useful to the model than the tool not existing.
 */
import { Type } from "typebox";
import { lookup as dnsLookup } from "node:dns";
import { textResult, type SeaTool } from "./types.ts";

/** Injectable so tests never touch the network. */
export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}>;

const DEFAULT_MAX_CHARS = 20_000;

/** Strip tags, scripts and entities. Not a parser — enough to read a page. */
export function htmlToText(html: string): string {
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const spaced = noScript
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(spaced)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const key = body.toLowerCase();
    if (named[key] !== undefined) return named[key]!;
    if (key.startsWith("#x")) return safeCodePoint(parseInt(key.slice(2), 16), whole);
    if (key.startsWith("#")) return safeCodePoint(parseInt(key.slice(1), 10), whole);
    return whole;
  });
}

function safeCodePoint(n: number, fallback: string): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

export function truncate(text: string, max = DEFAULT_MAX_CHARS): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n\n[truncated ${text.length - max} more characters]`;
}

/** http(s) only: file:// and friends would be a local-file read in disguise. */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`web_fetch: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`web_fetch: only http and https are allowed, got "${parsed.protocol}"`);
  }
  return parsed;
}

// --- 12.4: SSRF filter (audit 3927a1ac) ------------------------------------

/** Resolves a hostname to its addresses; injectable so tests never hit DNS. */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolveHost: HostResolver = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addrs) =>
      err ? reject(err) : resolve((addrs ?? []).map((a: { address: string }) => a.address)));
  });

function isBlockedIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  const o = parts.map(Number);
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number];
  return (
    a === 0 ||                                   // "this" network
    a === 10 ||                                  // 10/8 private
    a === 127 ||                                 // 127/8 loopback
    (a === 172 && b >= 16 && b <= 31) ||         // 172.16/12 private
    (a === 192 && b === 168) ||                  // 192.168/16 private
    (a === 169 && b === 254) ||                  // 169.254/16 link-local (cloud metadata)
    (a === 100 && b >= 64 && b <= 127)           // 100.64/10 CGNAT (tailscale/docker)
  );
}

/** True for loopback/private/reserved targets a fetched URL must never hit. */
export function isBlockedAddress(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) return isBlockedIpv4(a);
  if (a === "" || a === "::" || a === "::1") return true;    // unspecified / loopback
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); // IPv4-mapped IPv6
  if (mapped) return isBlockedIpv4(mapped[1]!);
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;             // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;             // fe80::/10 link-local
  return false;
}

function isBlockedName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || isBlockedAddress(h);
}

/**
 * Scheme + SSRF validation for one hop. A hostname that is not a literal IP
 * is RESOLVED and every address it maps to must be public — a DNS name that
 * points inside the network is the classic SSRF bounce. Throws on any
 * blocked target; returns the parsed URL otherwise.
 */
export async function assertSsrfSafeUrl(
  url: string,
  resolveHost: HostResolver = defaultResolveHost,
): Promise<URL> {
  const parsed = assertFetchableUrl(url);
  const host = parsed.hostname.toLowerCase();
  if (isBlockedName(host)) {
    throw new Error(`web_fetch: ${parsed.hostname} is loopback/private/reserved and is not allowed (SSRF filter)`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return parsed; // an IP literal: the range check above already decided
  }
  let addrs: string[];
  try {
    addrs = await resolveHost(host);
  } catch {
    throw new Error(`web_fetch: cannot resolve "${host}"`);
  }
  for (const addr of addrs) {
    if (isBlockedAddress(addr)) {
      throw new Error(`web_fetch: "${host}" resolves to private/reserved ${addr} (SSRF filter)`);
    }
  }
  return parsed;
}

const MAX_REDIRECTS = 5;

export async function fetchUrl(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
  doFetch: FetchLike = fetch as unknown as FetchLike,
  resolveHost: HostResolver = defaultResolveHost,
): Promise<string> {
  // redirect: "manual" + re-validating EVERY hop: with "follow" an
  // allowed-looking external URL could bounce to an internal target the
  // filter never saw (3927a1ac)
  let current = url;
  for (let hop = 0; ; hop++) {
    const parsed = await assertSsrfSafeUrl(current, resolveHost);
    const res = await doFetch(parsed.href, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`web_fetch: ${parsed.href} returned HTTP ${res.status} with no Location header`);
      if (hop >= MAX_REDIRECTS) throw new Error(`web_fetch: too many redirects (max ${MAX_REDIRECTS})`);
      current = new URL(loc, parsed.href).href; // relative Locations resolve against this hop
      continue;
    }
    if (!res.ok) throw new Error(`web_fetch: ${parsed.href} returned HTTP ${res.status}`);
    const body = await res.text();
    const type = res.headers.get("content-type") ?? "";
    const text = /html/i.test(type) ? htmlToText(body) : body;
    return truncate(text, maxChars);
  }
}

export const webFetchTool: SeaTool = {
  name: "web_fetch",
  label: "Fetch URL",
  description: "Fetch an http(s) URL and return its text (HTML is reduced to readable text).",
  parameters: Type.Object({
    url: Type.String({ description: "Absolute http:// or https:// URL." }),
    max_chars: Type.Optional(Type.Number({ description: "Truncate the text at this many characters.", minimum: 200 })),
  }),
  async execute(_id, params) {
    return textResult(await fetchUrl(params.url, params.max_chars ?? DEFAULT_MAX_CHARS));
  },
};

// --- search ---------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = "brave" | "tavily";

export function pickSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider | null {
  if (env.BRAVE_API_KEY) return "brave";
  if (env.TAVILY_API_KEY) return "tavily";
  return null;
}

export const NO_SEARCH_KEY_MESSAGE =
  "web_search is not configured. Set BRAVE_API_KEY or TAVILY_API_KEY in the " +
  "environment to enable it. web_fetch works without a key if you already have a URL.";

export async function search(
  query: string,
  count: number,
  env: NodeJS.ProcessEnv = process.env,
  doFetch: FetchLike = fetch as unknown as FetchLike,
): Promise<SearchHit[]> {
  const provider = pickSearchProvider(env);
  if (!provider) throw new Error(NO_SEARCH_KEY_MESSAGE);

  if (provider === "brave") {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await doFetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY! },
    });
    if (!res.ok) throw new Error(`web_search: brave returned HTTP ${res.status}`);
    const body = await res.json();
    return (body?.web?.results ?? []).slice(0, count).map((r: any) => ({
      title: String(r?.title ?? ""),
      url: String(r?.url ?? ""),
      snippet: htmlToText(String(r?.description ?? "")),
    }));
  }

  const res = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: count }),
  });
  if (!res.ok) throw new Error(`web_search: tavily returned HTTP ${res.status}`);
  const body = await res.json();
  return (body?.results ?? []).slice(0, count).map((r: any) => ({
    title: String(r?.title ?? ""),
    url: String(r?.url ?? ""),
    snippet: String(r?.content ?? ""),
  }));
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "no results";
  return hits
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
    .join("\n");
}

export const webSearchTool: SeaTool = {
  name: "web_search",
  label: "Web search",
  description:
    "Search the web and return titles, URLs and snippets. Requires BRAVE_API_KEY or TAVILY_API_KEY.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query." }),
    count: Type.Optional(Type.Number({ description: "How many results to return.", minimum: 1, maximum: 20 })),
  }),
  async execute(_id, params) {
    // an unconfigured search is a normal answer, not a crash: the model can
    // read the message and fall back to web_fetch
    if (!pickSearchProvider()) return textResult(NO_SEARCH_KEY_MESSAGE);
    return textResult(formatHits(await search(params.query, params.count ?? 5)));
  },
};
