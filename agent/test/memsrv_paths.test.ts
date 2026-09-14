/**
 * B2: the sidecar and journal defaults resolve against the Mnemo home, with
 * the checkout kept only as a development fallback — an installed build (npm
 * global, release tarball) has no memory-layer/target/debug under its install
 * directory, so checkout-relative defaults left every memory call reporting a
 * missing sidecar while the package was fine.
 *
 * resolveMemsrvPaths is injectable (env/home/repoRoot/exists) exactly so this
 * can be tested without touching a real home or a real checkout.
 */
import { test } from "node:test";
import assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { MEMSRV_NAME, mnemoHome, resolveMemsrvPaths } from "../src/hooks/memory.ts";

const HOME = path.join("fake", "home", ".mnemo");
const REPO = path.join("fake", "checkout");

const homeBinary = path.join(HOME, MEMSRV_NAME);
const homeJournal = path.join(HOME, "journal.jsonl");
const devBinary = path.join(REPO, "memory-layer", "target", "debug", MEMSRV_NAME);
const devJournal = path.join(REPO, "memory-layer", "data", "sea-agent-journal.jsonl");

const nothing = () => false;

test("an installed build gets its sidecar and journal under the home", () => {
  // Nothing in the checkout: exactly the npm-global / tarball situation.
  const got = resolveMemsrvPaths({ env: {}, home: HOME, repoRoot: REPO, exists: nothing });
  assert.deepEqual(got, { binary: homeBinary, journal: homeJournal });
});

test("the checkout is a development fallback, used only when the file exists", () => {
  const devOnly = (p: string) => p === devBinary || p === devJournal;
  const got = resolveMemsrvPaths({ env: {}, home: HOME, repoRoot: REPO, exists: devOnly });
  assert.deepEqual(got, { binary: devBinary, journal: devJournal });
});

test("a home path that exists wins over the dev checkout", () => {
  const got = resolveMemsrvPaths({ env: {}, home: HOME, repoRoot: REPO, exists: () => true });
  assert.deepEqual(got, { binary: homeBinary, journal: homeJournal });
});

test("MNEMO_MEMSRV_BIN / MNEMO_MEMORY_JOURNAL still override everything", () => {
  const env = { MNEMO_MEMSRV_BIN: "/opt/memsrv", MNEMO_MEMORY_JOURNAL: "/var/journal.jsonl" };
  const got = resolveMemsrvPaths({ env, home: HOME, repoRoot: REPO, exists: () => true });
  assert.deepEqual(got, { binary: "/opt/memsrv", journal: "/var/journal.jsonl" });
});

test("the legacy SEA_ overrides still work when the MNEMO_ ones are unset", () => {
  const env = { SEA_MEMSRV_BIN: "/legacy/memsrv", SEA_MEMORY_JOURNAL: "/legacy/journal.jsonl" };
  const got = resolveMemsrvPaths({ env, home: HOME, repoRoot: REPO, exists: nothing });
  assert.deepEqual(got, { binary: "/legacy/memsrv", journal: "/legacy/journal.jsonl" });
});

test("mnemoHome is ~/.mnemo unless MNEMO_HOME says otherwise", () => {
  assert.equal(mnemoHome({}), path.join(os.homedir(), ".mnemo"));
  assert.equal(mnemoHome({ MNEMO_HOME: "   " }), path.join(os.homedir(), ".mnemo"));
  assert.equal(mnemoHome({ MNEMO_HOME: path.join("custom", "place") }), path.join("custom", "place"));
});
