import { renderToString } from "react-dom/server";
import { App } from "./App";
import { jsonLd } from "./jsonld";

export function render() {
  return { html: renderToString(<App />), jsonLd: jsonLd() };
}
