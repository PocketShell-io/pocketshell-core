import { describe, expect, it } from 'vitest';
import {
  aliasesToAutoCheck,
  assembleSyncSet,
  parseSyncPayload,
  parseSyncPayloadResult,
  serializeSyncPayload,
} from '../src/syncMerge';
import type { HostEntry } from '../src/types';
import rawSyncVectors from './fixtures/settings-sync-vectors.json';

interface SyncVectors {
  wireContract: {
    emptyPayloadPlaintext: string;
  };
  mergeCases: Array<{
    id: string;
    local: unknown[];
    remote: unknown[];
    checked: string[];
    expected: unknown[];
  }>;
  autoCheckCases: Array<{
    id: string;
    remote: unknown[];
    checked: string[];
    localAliases: string[];
    expected: string[];
  }>;
  payloadCases: Array<{
    id: string;
    plaintext: string;
    expected: unknown;
  }>;
}

const syncVectors = rawSyncVectors as unknown as SyncVectors;

function fixtureHosts(hosts: unknown[]): HostEntry[] {
  // The shared JSON vectors model each client's actual representation. In
  // particular Android local entries intentionally contain only its fields.
  return hosts as HostEntry[];
}

function host(name: string, hostname = `${name}.example.com`, port = 22): HostEntry {
  return {
    name,
    hostname,
    port,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

describe('assembleSyncSet', () => {
  it('sends only the ticked aliases — unticked hosts never leave the machine', () => {
    const out = assembleSyncSet([host('a'), host('b'), host('c')], [], ['b']);
    expect(out.map((h) => h.name)).toEqual(['b']);
  });

  it('takes a ticked alias the config lacks from the account', () => {
    const remote = [host('b', 'remote.example.com', 2222)];
    const out = assembleSyncSet([host('a')], remote, ['a', 'b']);
    expect(out).toEqual([host('a'), host('b', 'remote.example.com', 2222)]);
  });

  it('prefers the LOCAL entry when both sides have a ticked alias', () => {
    const out = assembleSyncSet(
      [host('a', 'local.example.com', 22)],
      [host('a', 'remote.example.com', 2222)],
      ['a'],
    );
    expect(out[0]!.hostname).toBe('local.example.com');
    expect(out[0]!.port).toBe(22);
  });

  it('drops a tick with no entry on either side, at no cost to the others', () => {
    expect(assembleSyncSet([], [], ['ghost'])).toEqual([]);
    expect(assembleSyncSet([host('a')], [], ['ghost', 'a']).map((h) => h.name)).toEqual(['a']);
  });

  it('ignores unticked remote hosts entirely', () => {
    const out = assembleSyncSet([host('a')], [host('r1'), host('r2')], ['a']);
    expect(out.map((h) => h.name)).toEqual(['a']);
  });

  it('honours the ticked order and tolerates duplicates', () => {
    const out = assembleSyncSet([host('a'), host('b')], [], ['b', 'a', 'b']);
    expect(out.map((h) => h.name)).toEqual(['b', 'a']);
  });

  it('is empty when nothing is ticked', () => {
    expect(assembleSyncSet([host('a')], [host('r')], [])).toEqual([]);
  });
});

describe('aliasesToAutoCheck', () => {
  it('lists account aliases the selection lacks', () => {
    expect(aliasesToAutoCheck([host('a'), host('b')], ['b'], [])).toEqual(['a']);
  });

  it('is empty when the selection already covers the account', () => {
    expect(aliasesToAutoCheck([host('a')], ['a', 'x'], [])).toEqual([]);
  });

  it('is every alias on a fresh machine', () => {
    expect(aliasesToAutoCheck([host('a'), host('b')], [], [])).toEqual(['a', 'b']);
  });

  it('never claims an alias the local config already has — an untick must stand', () => {
    // The user unticked 'dropped'; the account still holds it. Because the
    // config has the alias, the untick survives the next pull.
    expect(aliasesToAutoCheck([host('kept'), host('dropped')], ['kept'], ['kept', 'dropped'])).toEqual([]);
  });
});

describe('payload round-trip', () => {
  it('serializes and parses hosts', () => {
    const hosts = [host('a', 'a.example.com', 2222)];
    expect(parseSyncPayload(serializeSyncPayload(hosts))).toEqual(hosts);
  });

  it('parses garbage and wrong shapes to an empty list', () => {
    expect(parseSyncPayload('not json')).toEqual([]);
    expect(parseSyncPayload('{"hosts":"nope"}')).toEqual([]);
    expect(parseSyncPayload('{"other":1}')).toEqual([]);
  });

  it('drops entries without a name and hostname', () => {
    const payload = serializeSyncPayload([
      host('good'),
      { ...host('bad'), hostname: '' },
    ]);
    expect(parseSyncPayload(payload).map((h) => h.name)).toEqual(['good']);
  });
});

describe('shared cross-client sync vectors', () => {
  it('keeps the existing versionless plaintext serialization', () => {
    expect(serializeSyncPayload([])).toBe(syncVectors.wireContract.emptyPayloadPlaintext);
    expect(JSON.parse(syncVectors.wireContract.emptyPayloadPlaintext)).toEqual({ hosts: [] });
  });

  for (const vector of syncVectors.mergeCases) {
    it(vector.id, () => {
      const assembled = assembleSyncSet(
        fixtureHosts(vector.local),
        fixtureHosts(vector.remote),
        vector.checked,
      );
      expect(assembled).toEqual(vector.expected);
      expect(JSON.parse(serializeSyncPayload(assembled))).toEqual({ hosts: vector.expected });
    });
  }

  for (const vector of syncVectors.autoCheckCases) {
    it(vector.id, () => {
      expect(
        aliasesToAutoCheck(
          fixtureHosts(vector.remote),
          vector.checked,
          vector.localAliases,
        ),
      ).toEqual(vector.expected);
    });
  }

  for (const vector of syncVectors.payloadCases) {
    it(vector.id, () => {
      const parsed = parseSyncPayloadResult(vector.plaintext);
      expect(parsed).toEqual(vector.expected);
      if ((vector.expected as { kind?: string }).kind === 'invalid') {
        // Invalid plaintext has no host list that a mutating caller could
        // mistake for an explicit request to replace the account with empty.
        expect(parsed).not.toHaveProperty('hosts');
      }
    });
  }
});

describe('strict payload parsing for writes', () => {
  it('keeps an undefined local extension from erasing the account value', () => {
    const local = { ...host('a'), futureDirective: undefined } as unknown as HostEntry;
    const remote = {
      ...host('a'),
      futureDirective: { nested: ['preserved'] },
    } as unknown as HostEntry;
    const assembled = assembleSyncSet([local], [remote], ['a']);
    expect(JSON.parse(serializeSyncPayload(assembled))["hosts"][0]["futureDirective"])
      .toEqual({ nested: ['preserved'] });
  });

  it('distinguishes an explicit empty payload from malformed data', () => {
    expect(parseSyncPayloadResult('{"hosts":[]}')).toEqual({ kind: 'ok', hosts: [] });
    expect(parseSyncPayloadResult('{"hosts":')).toEqual({ kind: 'invalid', reason: 'invalid-json' });
  });

  it('refuses the whole payload when any entry is malformed', () => {
    expect(
      parseSyncPayloadResult('{"hosts":[{"name":"good","hostname":"good.example"},{"name":"bad"}]}'),
    ).toEqual({ kind: 'invalid', reason: 'invalid-host-entry', index: 1 });
  });

  it('keeps the legacy degraded parser behavior for read-only compatibility', () => {
    expect(parseSyncPayload('{"hosts":[{"name":"good","hostname":"good.example"},{"name":"bad"}]}'))
      .toEqual([{ name: 'good', hostname: 'good.example' }]);
    expect(parseSyncPayload('{"hosts":')).toEqual([]);
  });
});
