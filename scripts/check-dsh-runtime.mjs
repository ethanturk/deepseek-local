#!/usr/bin/env node

import { execFileSync } from "node:child_process";

import { MINIMUM_DSH_VERSION, isSupportedDshVersion } from "./dsh-runtime-version.mjs";

const command = process.env.DSH_BIN || "dsh";

try {
  const version = execFileSync(command, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  }).trim();
  if (!isSupportedDshVersion(version)) {
    console.error(`Unsupported DSH ${version}; install ${MINIMUM_DSH_VERSION} or newer.`);
    process.exitCode = 1;
  } else {
    console.log(`DSH ${version} supports resilient frontend event delivery.`);
  }
} catch (error) {
  console.error(`Unable to verify DSH runtime: ${error.message}`);
  process.exitCode = 1;
}
