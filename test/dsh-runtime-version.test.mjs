import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_DSH_VERSION,
  isSupportedDshVersion,
  parseDshVersion,
} from "../scripts/dsh-runtime-version.mjs";

test("rejects the WebSocket-only DSH runtime", () => {
  assert.equal(MINIMUM_DSH_VERSION, "0.1.5-rc.1");
  assert.equal(isSupportedDshVersion("0.1.1-rc.2"), false);
});

test("accepts the minimum and newer runtimes", () => {
  assert.equal(isSupportedDshVersion("0.1.5-rc.1"), true);
  assert.equal(isSupportedDshVersion("dsh 0.1.5-rc.2"), true);
  assert.equal(isSupportedDshVersion("0.1.5"), true);
  assert.equal(isSupportedDshVersion("0.2.0-alpha.1"), true);
});

test("parses CLI output and rejects malformed versions", () => {
  assert.deepEqual(parseDshVersion("dsh 0.1.5-rc.1\n"), {
    major: 0,
    minor: 1,
    patch: 5,
    prerelease: ["rc", 1],
  });
  assert.throws(() => parseDshVersion("unknown"), /Could not parse DSH version/);
});
