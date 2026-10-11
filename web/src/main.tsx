import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// The page is prerendered (see scripts/prerender.mjs), so crawlers that do not run
// JavaScript get the whole thing; hydration only adds behaviour.
hydrateRoot(
  document.getElementById("root")!,
  <StrictMode>
    <App />
  </StrictMode>,
);
