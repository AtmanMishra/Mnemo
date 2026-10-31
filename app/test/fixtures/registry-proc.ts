/**
 * Another Mnemo process, for the registry tests: a roster with one conversation and one running
 * sub-agent, in the registry of `MNEMO_HOME`. It prints `ready <tag>`, then one line per request
 * it carries out (`told <node> <text>`, `submit <how> <text>`, `stop <node>`, `interrupt`), and
 * exits cleanly on a line `quit` on stdin. A kill leaves its record behind, as a crash would.
 */
import * as readline from "node:readline";
import { Roster } from "../../src/runtime/roster.ts";
import { joinRegistry } from "../../src/registry/join.ts";

const home = process.env.MNEMO_HOME!;
const cwd = process.argv[2] ?? process.cwd();
const roster = new Roster();
let running = false;
const root = roster.addRoot("fixture", { deliver: () => true, stop: () => {} });
const sub = roster.addSub(root.id, { label: "researcher", task: "look around", access: "read-only" });
roster.attach(sub.id, {
  deliver: () => true,
  tell: (text) => (console.log(`told ${sub.id} ${text}`), true),
  stop: () => console.log(`stop ${sub.id}`),
});
roster.step(sub.id, "→ read(README.md)");

const joined = joinRegistry({
  home,
  kind: "interactive",
  version: "test",
  roster,
  members: () => [
    {
      node: root.id,
      cwd,
      model: () => "mnemo-demo/demo-model",
      mode: () => "default",
      control: {
        running: () => running,
        submit: (text, how) => {
          console.log(`submit ${how} ${text}`);
          running = true;
        },
        interrupt: () => {
          console.log("interrupt");
          running = false;
        },
      },
    },
  ],
});
if (!joined) {
  console.log("not joined");
  process.exit(1);
}
// Faster than a terminal's second, so the tests are quick.
setInterval(() => void joined.inbox.tick(), 50);
console.log(`ready ${joined.tag}`);
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  if (l.trim() === "quit") {
    joined.close();
    process.exit(0);
  }
});
