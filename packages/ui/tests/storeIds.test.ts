import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Pinia keys stores by id within one app, and every client mounts this shared
 * UI into an app that has its own stores. A shared store whose id a client
 * already uses is silently merged with it: both callers get whichever was
 * created first, and each loses its API (#2924: the web's 'hosts' store
 * crashed the signed-in web home once a shared 'hosts' store existed).
 *
 * This is the list of ids the clients define themselves. Update it when a
 * client adds a store; a shared store must never take one of these ids.
 */
const CLIENT_STORE_IDS: Record<string, readonly string[]> = {
  // pocketshell-web src/stores/*.ts
  web: ['auth', 'hostPins', 'hosts', 'host-warnings'],
  // pocketshell (Android JS app) src/**
  android: ['appSettings', 'composerDrafts', 'diagnostics', 'navigation'],
  // pocketshell-desktop defines no stores of its own; it uses these.
  desktop: [],
};

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

function sharedStoreIds(): string[] {
  return sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/defineStore\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!),
  );
}

describe('shared Pinia store ids', () => {
  it('finds the shared stores it is guarding', () => {
    const ids = sharedStoreIds();
    expect(ids).toContain('connection');
    expect(ids).toContain('sharedHosts');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never reuses an id a client defines for its own store', () => {
    const shared = new Set(sharedStoreIds());
    const clashes = Object.entries(CLIENT_STORE_IDS).flatMap(([client, ids]) =>
      ids.filter((id) => shared.has(id)).map((id) => `${client}:${id}`),
    );
    expect(clashes).toEqual([]);
  });
});
