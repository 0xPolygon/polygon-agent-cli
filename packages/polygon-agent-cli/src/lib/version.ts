// The installed CLI version, and the latest one on npm (cached in config.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { readConfig, updateConfig } from './config.ts';

export const PACKAGE_NAME = '@polygonlabs/agent-cli';

const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 3000;
export const LATEST_VERSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PackageJson = z.object({ name: z.string(), version: z.string() });
const RegistryLatest = z.object({ version: z.string() });
const LatestVersionCache = z.object({ version: z.string(), checkedAt: z.number() });

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// The CLI's package folder. The bundle runs from dist/, development from src/lib/.
export function cliPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const pkg = PackageJson.safeParse(readJson(path.join(dir, 'package.json')));
    if (pkg.success && pkg.data.name === PACKAGE_NAME) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not find the ${PACKAGE_NAME} package folder`);
}

export function cliVersion(): string {
  return PackageJson.parse(readJson(path.join(cliPackageRoot(), 'package.json'))).version;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// True when `candidate` is a later release than `current`. Unparsable versions
// are never newer.
export function isNewerVersion(params: { candidate: string; current: string }): boolean {
  const a = SEMVER.exec(params.candidate);
  const b = SEMVER.exec(params.current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  // Same x.y.z: a release beats a prerelease; two prereleases compare as strings.
  if (a[4] === b[4]) return false;
  if (a[4] === undefined) return true;
  if (b[4] === undefined) return false;
  return a[4] > b[4];
}

// The latest published version, from the cache when it's younger than maxAgeMs.
// Returns the cached value (or null) when the registry can't be reached.
export async function getLatestVersion(params: { maxAgeMs?: number } = {}): Promise<string | null> {
  const maxAgeMs = params.maxAgeMs ?? LATEST_VERSION_MAX_AGE_MS;
  const cached = LatestVersionCache.safeParse(readConfig().latestVersion);
  if (cached.success && Date.now() - cached.data.checkedAt < maxAgeMs) {
    return cached.data.version;
  }
  try {
    const res = await fetch(REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
    const { version } = RegistryLatest.parse(await res.json());
    updateConfig({ latestVersion: { version, checkedAt: Date.now() } });
    return version;
  } catch {
    return cached.success ? cached.data.version : null;
  }
}
