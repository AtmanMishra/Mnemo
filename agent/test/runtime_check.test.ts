/** 6.2: the Node version guard. */
import { test } from "node:test";
import assert from "node:assert";
import {
  MIN_NODE, checkNodeVersion, isSupportedNode, parseNodeVersion, unsupportedNodeMessage,
} from "../src/runtime_check.ts";

test("versions parse from the shapes node actually reports", () => {
  assert.deepEqual(parseNodeVersion("v22.6.0"), { major: 22, minor: 6 });
  assert.deepEqual(parseNodeVersion("26.7.0"), { major: 26, minor: 7 });
  assert.deepEqual(parseNodeVersion("v23.0.0-nightly"), { major: 23, minor: 0 });
  assert.equal(parseNodeVersion("not a version"), null);
});

test("the boundary is 22.6, not 'anything 22'", () => {
  assert.equal(isSupportedNode("v22.6.0"), true, "the minimum itself is supported");
  assert.equal(isSupportedNode("v22.5.9"), false, "22.5 has no type stripping");
  assert.equal(isSupportedNode("v22.11.0"), true);
  assert.equal(isSupportedNode("v23.0.0"), true);
  assert.equal(isSupportedNode("v20.19.0"), false);
  assert.equal(isSupportedNode("v18.0.0"), false);
});

test("an unreadable version is not treated as an old one", () => {
  // refusing to start over a version string we failed to parse would be worse
  // than trying and failing with the real error
  assert.equal(isSupportedNode("weird-custom-build"), true);
  assert.equal(checkNodeVersion("weird-custom-build"), null);
});

test("the message says what to do, not just what is wrong", () => {
  const msg = unsupportedNodeMessage("v20.11.0");
  assert.match(msg, /v20\.11\.0/, "it names the version actually running");
  assert.match(msg, new RegExp(`${MIN_NODE.major}\\.${MIN_NODE.minor}`));
  assert.match(msg, /nvm install/, "it gives a command to run");
  assert.match(msg, /type stripping/, "it explains why the floor exists");
});

test("the check passes on the node running these tests", () => {
  assert.equal(checkNodeVersion(), null, `this suite runs on ${process.version}`);
});
