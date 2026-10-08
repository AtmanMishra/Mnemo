/**
 * The release's package manifests are generated from SHA256SUMS: every
 * platform's archive and hash must land in the right place, and a missing
 * archive must stop the release rather than ship a manifest with a hole in it.
 */
import { test, expect } from "bun:test";
import { formula, parseSums, scoop } from "../scripts/manifests.ts";

const h = (c: string) => c.repeat(64);
const SUMS = [
  `${h("a")}  mnemo-linux-x64.tar.gz`,
  `${h("b")}  mnemo-linux-arm64.tar.gz`,
  `${h("c")}  mnemo-darwin-x64.tar.gz`,
  `${h("d")}  mnemo-darwin-arm64.tar.gz`,
  `${h("e")} *mnemo-windows-x64.zip`,
  "",
].join("\n");

test("SHA256SUMS parses, binary-mode marker and blank lines included", () => {
  const sums = parseSums(SUMS);
  expect(Object.keys(sums).sort()).toEqual(["mnemo-darwin-arm64.tar.gz", "mnemo-darwin-x64.tar.gz", "mnemo-linux-arm64.tar.gz", "mnemo-linux-x64.tar.gz", "mnemo-windows-x64.zip"]);
  expect(sums["mnemo-windows-x64.zip"]).toBe(h("e"));
});

test("the Homebrew formula pins each platform's own archive and hash", () => {
  const f = formula("v0.1.0", parseSums(SUMS));
  expect(f).toContain('version "0.1.0"');
  expect(f).toContain('license "Apache-2.0"');
  // Each platform's url is followed directly by that platform's hash.
  const pair = (platform: string, c: string) => `releases/download/v0.1.0/mnemo-${platform}.tar.gz"\n      sha256 "${h(c)}"`;
  expect(f).toContain(pair("darwin-arm64", "d"));
  expect(f).toContain(pair("darwin-x64", "c"));
  expect(f).toContain(pair("linux-arm64", "b"));
  expect(f).toContain(pair("linux-x64", "a"));
  expect(f).toContain('bin.install "mnemo", "memsrv"');
});

test("the Scoop manifest carries the Windows archive, and a version Scoop can auto-update", () => {
  const m = JSON.parse(scoop("v1.2.3", parseSums(SUMS)));
  expect(m.version).toBe("1.2.3");
  expect(m.architecture["64bit"]).toEqual({ url: "https://github.com/AtmanMishra/mnemo/releases/download/v1.2.3/mnemo-windows-x64.zip", hash: h("e") });
  expect(m.autoupdate.architecture["64bit"].url).toContain("/v$version/");
  expect(m.bin).toEqual(["mnemo.exe"]);
});

test("a missing archive stops the release", () => {
  const sums = parseSums(SUMS.replace(/.*darwin-arm64.*\n/, ""));
  expect(() => formula("v0.1.0", sums)).toThrow("mnemo-darwin-arm64.tar.gz is not in SHA256SUMS");
});

test("the version bump changes the first version field and nothing else", async () => {
  const { bump, versionOf, VERSIONED } = await import("../scripts/release.ts");
  const pkg = `{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "y": "1.2.3", "version": "9" }\n}\n`;
  expect(bump(pkg, "0.2.0-rc.1", "package.json")).toBe(pkg.replace('"version": "0.1.0"', '"version": "0.2.0-rc.1"'));
  const toml = `[package]\nname = "m"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n`;
  expect(bump(toml, "0.3.0", "Cargo.toml")).toBe(toml.replace('version = "0.1.0"', 'version = "0.3.0"'));
  expect(versionOf(toml, "Cargo.toml")).toBe("0.1.0");
  expect(versionOf(pkg, "package.json")).toBe("0.1.0");
  expect(() => bump("{}", "1.0.0", "package.json")).toThrow("no version field");
  // The three files the release workflow checks are the three this bumps.
  expect(VERSIONED).toEqual(["app/package.json", "packages/memory/package.json", "memory-layer/Cargo.toml"]);
});
