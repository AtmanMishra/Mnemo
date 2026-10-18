// A stand-in for `mnemo --rpc`: echoes a ready event, answers requests, exits on quit.
const lines = require("node:readline").createInterface({ input: process.stdin });
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
out({ type: "ready", protocol: 1, version: "fake", cwd: process.cwd(), hasModel: true, commands: [] });
process.stdout.write("not json\n");
lines.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "quit") process.exit(0);
  if (m.type === "crash") process.exit(3);
  out({ type: "result", id: m.id, ok: true, value: m });
});
