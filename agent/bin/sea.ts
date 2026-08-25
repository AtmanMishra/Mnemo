#!/usr/bin/env node
// sea-agent CLI entry.
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { runCliIfMain, SEA_CLI_FORCE } from "../src/cli.ts";

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly || process.env.SEA_CLI_FORCE === "1") {
  runCliIfMain();
}
