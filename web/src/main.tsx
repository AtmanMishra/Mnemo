import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./pages.css";

// Every page is prerendered (see scripts/prerender.mjs), so crawlers that do not run
// JavaScript get the whole thing; hydration only adds behaviour. The page is chosen by
// the path, the same way the prerender chose it.
hydrateRoot(
  document.getElementById("root")!,
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>,
);
