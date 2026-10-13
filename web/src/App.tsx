import type { ComponentType } from "react";
import { Shell } from "./Shell";
import { Home } from "./pages/Home";
import { Download } from "./pages/Download";
import { Docs } from "./pages/Docs";
import { Shortcuts } from "./pages/Shortcuts";
import { Changelog } from "./pages/Changelog";
import { Roadmap } from "./pages/Roadmap";
import { Security } from "./pages/Security";
import { Privacy } from "./pages/Privacy";
import { Terms } from "./pages/Terms";
import { NotFound } from "./pages/NotFound";
import { normalize } from "./routes";

const PAGES: Record<string, ComponentType> = {
  "/": Home,
  "/download": Download,
  "/docs": Docs,
  "/shortcuts": Shortcuts,
  "/changelog": Changelog,
  "/roadmap": Roadmap,
  "/security": Security,
  "/privacy": Privacy,
  "/terms": Terms,
};

export function App({ path }: { path: string }) {
  const here = normalize(path);
  const Page = PAGES[here] ?? NotFound;
  return (
    <Shell path={here}>
      <Page />
    </Shell>
  );
}
