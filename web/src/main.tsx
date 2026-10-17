import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { Router } from "./Router";
import { startBoot } from "./fx/boot";
import "@fontsource/alfa-slab-one/latin-400.css";
import "@fontsource/arvo/latin-400.css";
import "@fontsource/arvo/latin-700.css";
import "@fontsource/arvo/latin-400-italic.css";
import "@fontsource/silkscreen/latin-400.css";
import "@fontsource/dm-mono/latin-400.css";
import "@fontsource/dm-mono/latin-500.css";
import "./styles.css";
import "./pages.css";
import "./landing.css";

// The loader starts before React so it can count the work from the first moment.
startBoot();

// Every page is prerendered (see scripts/prerender.mjs), so crawlers that do not run
// JavaScript get the whole thing; hydration only adds behaviour. The page is chosen by
// the path, the same way the prerender chose it.
hydrateRoot(
  document.getElementById("root")!,
  <StrictMode>
    <Router initial={window.location.pathname} />
  </StrictMode>,
);
