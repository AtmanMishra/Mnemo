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

export async function fetchUrl(
  url: string,
  maxChars = DEFAULT_MAX_CHARS,
  doFetch: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const parsed = assertFetchableUrl(url);
  const res = await doFetch(parsed.href, { redirect: "follow" });
  if (!res.ok) throw new Error(`web_fetch: ${parsed.href} returned HTTP ${res.status}`);
  const body = await res.text();
  const type = res.headers.get("content-type") ?? "";
  const text = /html/i.test(type) ? htmlToText(body) : body;
  return truncate(text, maxChars);
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
