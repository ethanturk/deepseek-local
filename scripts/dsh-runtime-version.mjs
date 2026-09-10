export const MINIMUM_DSH_VERSION = "0.1.5-rc.1";

export function parseDshVersion(value) {
  const match = String(value).match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) throw new Error(`Could not parse DSH version from: ${String(value).trim()}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
}

function compareIdentifiers(left, right) {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (typeof left === "number" && typeof right === "string") return -1;
  if (typeof left === "string" && typeof right === "number") return 1;
  return left < right ? -1 : 1;
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const result = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (result !== 0) return result;
  }
  return 0;
}

export function isSupportedDshVersion(value) {
  return compareVersions(parseDshVersion(value), parseDshVersion(MINIMUM_DSH_VERSION)) >= 0;
}
