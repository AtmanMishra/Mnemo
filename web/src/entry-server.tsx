import { renderToString } from "react-dom/server";
import { App } from "./App";
import { jsonLd } from "./jsonld";
import { ROUTES } from "./routes";
import { RELEASES } from "./content/changelog";
import { GROUPS } from "./content/commands";

export function render(path: string) {
  return { html: renderToString(<App path={path} />), jsonLd: jsonLd(path) };
}

// What the prerender needs to write the sitemap, the feed and the Markdown copy of the
// commands without importing the content by path.
export const data = { routes: ROUTES, releases: RELEASES, groups: GROUPS };
