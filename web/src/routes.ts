// Every page of the site. The prerender writes one HTML file per route, the sitemap lists
// them, and the client picks its page from the same table, so a page cannot be in one and
// missing from another (scripts/check.mjs fails the build if it is).

export interface Route {
  path: string;
  /** Page title without the site name; the home page uses the long form. */
  title: string;
  description: string;
  /** In the sitemap's priority, 0 to 1. */
  priority: number;
  /** For the footer and breadcrumbs. */
  label: string;
}

export const ROUTES: Route[] = [
  { path: "/", label: "Home", title: "Mnemo: a terminal coding agent that remembers your project", description: "Open-source terminal coding agent for macOS, Linux and Windows that remembers your project, keeps the fix when something fails and writes its own skills.", priority: 1 },
  { path: "/features", label: "Features", title: "Features: memory, skills and checks", description: "What Mnemo does, each with a working demo: project memory, lessons kept from failures, skills it writes, checked work, permission modes, tools and agents.", priority: 0.9 },
  { path: "/how-it-works", label: "How it works", title: "How it works: a memory graph for a coding agent", description: "How Mnemo remembers: a graph with typed edges in six areas, an append-only journal on your machine, recall before each message and reflection after each run.", priority: 0.9 },
  { path: "/download", label: "Download", title: "Download Mnemo for macOS, Linux and Windows", description: "Download Mnemo for macOS, Linux or Windows: a one-click archive for your system, a one-line installer, checksums, and how to verify them.", priority: 0.9 },
  { path: "/docs", label: "Docs", title: "Documentation: install, first run and memory", description: "Get started with Mnemo: install, first run, permission modes, memory, updating and uninstalling, where files live, and fixing problems.", priority: 0.9 },
  { path: "/shortcuts", label: "Commands and shortcuts", title: "Commands and shortcuts", description: "Every Mnemo slash command, keyboard shortcut, command-line option and environment variable, searchable, with a printable and downloadable copy.", priority: 0.8 },
  { path: "/changelog", label: "Changelog", title: "Changelog: what changed in each release", description: "What changed in each Mnemo release: features, changes, fixes and security fixes, with the problems known at the time.", priority: 0.8 },
  { path: "/roadmap", label: "Roadmap", title: "Roadmap: what Mnemo builds next", description: "What Mnemo is building now, what comes next, what is shipped, and what is not planned.", priority: 0.7 },
  { path: "/security", label: "Security", title: "Security: permissions, credentials and reporting", description: "What Mnemo is allowed to do, what leaves your machine, how credentials are handled, how to verify a download, and how to report a vulnerability.", priority: 0.7 },
  { path: "/privacy", label: "Privacy policy", title: "Privacy policy", description: "What data Mnemo and this website collect: none by Mnemo, and only standard hosting logs on the site.", priority: 0.4 },
  { path: "/terms", label: "Terms of use", title: "Terms of use", description: "The terms for using the Mnemo software (Apache-2.0) and this website.", priority: 0.4 },
];

export const routeFor = (path: string): Route | undefined => ROUTES.find((r) => r.path === path);

/** "/changelog/" and "/changelog.html" both mean "/changelog". */
export function normalize(path: string): string {
  const clean = path.replace(/[?#].*$/, "").replace(/\.html$/, "").replace(/\/index$/, "");
  return clean.length > 1 ? clean.replace(/\/+$/, "") : "/";
}
