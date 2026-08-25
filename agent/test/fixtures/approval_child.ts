/**
 * Test fixture: run approve() in a fresh child process with piped (non-TTY)
 * stdio. Prints {"approved": <bool>} so the parent test can assert behavior.
 */
import { approve } from "../../src/approval.ts";

const tool = process.argv[2] ?? "bash_exec";
const summary = process.argv[3] ?? "$ echo hi";
const ok = await approve({ tool, summary });
console.log(JSON.stringify({ approved: ok }));
