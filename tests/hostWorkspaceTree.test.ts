import { describe, expect, it } from 'vitest';
import type { SessionRow } from '../src/hostCliSessions';
import type { WorkspaceMembership } from '../src/hostCliWorkspaces';
import { OTHER_ROOT } from '../src/sessionRoots';
import {
  WorkspacePreferencesError,
  emptyWorkspacePreferences,
  homeFromWorkspaceMemberships,
  hostWorkspacePreferences,
  moveWorkspaceRoot,
  orderWorkspaceMemberships,
  parseWorkspacePreferences,
  projectWorkspaceRoots,
  seedHostWorkspacePreferences,
  serializeWorkspacePreferences,
  sessionSummaryFromHostRow,
  validateWorkspaceRootInput,
  withHostWorkspacePreferences,
} from '../src/hostWorkspaceTree';

function row(name: string, workspace: string | null, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    name,
    id: `${name}-id`,
    workspace,
    tag: name,
    engine: null,
    profile: null,
    agent: null,
    agentState: null,
    agentStateSource: null,
    attached: false,
    createdEpoch: 100,
    activityEpoch: 200,
    ...extra,
  };
}

function membership(path: string, displayPath = path): WorkspaceMembership {
  return { path, displayPath };
}

const HOME = '/home/me';
const GIT = membership('/home/me/git', '~/git');
const TMP = membership('/home/me/tmp', '~/tmp');
const summaries = (...rows: SessionRow[]) => rows.map(sessionSummaryFromHostRow);

describe('host workspace root projection', () => {
  it('maps a host CLI row onto the grouping model', () => {
    const source = row('api', '/home/me/git/api', { attached: true, createdEpoch: 5, activityEpoch: null });
    expect(sessionSummaryFromHostRow(source)).toEqual({
      name: 'api',
      created: 5,
      activity: 5,
      attached: true,
      path: '/home/me/git/api',
      backend: 'aplexer',
      workspace: '/home/me/git/api',
      tag: 'api',
      aplexerId: 'api-id',
      profile: null,
    });
  });

  it('groups registered roots into root -> folder -> session with other last', () => {
    const projection = projectWorkspaceRoots({
      sessions: summaries(
        row('one', '/home/me/git/api/service'),
        row('two', '/home/me/git/api/service'),
        row('three', '/home/me/git/web'),
        row('stray', '/srv/elsewhere'),
      ),
      workspaces: [GIT, TMP],
    });
    expect(projection.home).toBe(HOME);
    expect(projection.roots.map((root) => [root.key, root.configured])).toEqual([
      ['~/git', true],
      ['~/tmp', true],
      [OTHER_ROOT, false],
    ]);
    expect(projection.roots[0].directories.map((dir) => [dir.label, dir.rows.map((r) => r.session.name)])).toEqual([
      ['service', ['one', 'two']],
      ['web', ['three']],
    ]);
    // A registered root nothing runs in still renders, empty.
    expect(projection.roots[1]).toMatchObject({ sessionCount: 0, directories: [] });
    expect(projection.roots[2].directories[0].rows[0].session.name).toBe('stray');
  });

  it('derives roots from $HOME when the host has no registrations', () => {
    const projection = projectWorkspaceRoots({
      sessions: summaries(row('a', '/home/me/git/a'), row('b', '/home/me/tmp/b')),
      workspaces: [],
    });
    expect(projection.roots.map((root) => [root.key, root.configured])).toEqual([
      ['~/git', false],
      ['~/tmp', false],
    ]);
  });

  it('orders roots by the saved order in any spelling and appends new registrations', () => {
    const extra = membership('/home/me/zeta', '~/zeta');
    expect(orderWorkspaceMemberships([GIT, TMP, extra], ['/home/me/tmp', '/gone']).map((w) => w.path)).toEqual([
      '/home/me/tmp',
      '/home/me/git',
      '/home/me/zeta',
    ]);
    expect(orderWorkspaceMemberships([GIT, TMP], ['~/tmp'], HOME).map((w) => w.path)).toEqual([
      '/home/me/tmp',
      '/home/me/git',
    ]);
    const projection = projectWorkspaceRoots({ sessions: [], workspaces: [GIT, TMP], rootOrder: ['~/tmp'] });
    expect(projection.roots.map((root) => root.key)).toEqual(['~/tmp', '~/git']);
    expect(moveWorkspaceRoot(projection.registered, '/home/me/git', -1)).toEqual(['/home/me/git', '/home/me/tmp']);
    expect(moveWorkspaceRoot(projection.registered, '/home/me/tmp', -1)).toBeNull();
    expect(moveWorkspaceRoot(projection.registered, '/nope', 1)).toBeNull();
  });

  it('reads $HOME from a home-relative registration before guessing', () => {
    expect(homeFromWorkspaceMemberships([membership('/srv/a'), membership('/data/users/me/git', '~/git')])).toBe(
      '/data/users/me',
    );
    expect(homeFromWorkspaceMemberships([membership('/data/users/me', '~')])).toBe('/data/users/me');
    expect(homeFromWorkspaceMemberships([membership('/srv/a')])).toBeNull();
    const projection = projectWorkspaceRoots({ sessions: [], workspaces: [membership('/data/users/me/git', '~/git')] });
    expect(projection.roots.map((root) => root.key)).toEqual(['~/git']);
  });

  it('projects the same registered path on two hosts independently', () => {
    const shared = [GIT, TMP];
    const hostA = projectWorkspaceRoots({
      sessions: summaries(row('a', '/home/me/git/alpha')),
      workspaces: shared,
      rootOrder: ['/home/me/tmp'],
    });
    const hostB = projectWorkspaceRoots({
      sessions: summaries(row('b', '/home/me/tmp/beta')),
      workspaces: shared,
      rootOrder: ['/home/me/git'],
    });
    expect(hostA.roots.map((root) => [root.key, root.sessionCount])).toEqual([['~/tmp', 0], ['~/git', 1]]);
    expect(hostB.roots.map((root) => [root.key, root.sessionCount])).toEqual([['~/git', 0], ['~/tmp', 1]]);
  });

  it('validates a typed root before it reaches the host', () => {
    expect(validateWorkspaceRootInput('  ~/src/ ', [GIT], HOME)).toEqual({ ok: true, path: '~/src' });
    expect(validateWorkspaceRootInput('/srv/apps', [], null)).toEqual({ ok: true, path: '/srv/apps' });
    for (const bad of ['', 'git', '~/git/../etc', '/tmp/a\nb', 'relative/path']) {
      expect(validateWorkspaceRootInput(bad, [], HOME).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateWorkspaceRootInput('~/git', [GIT], HOME)).toEqual({
      ok: false,
      message: '~/git is already a workspace root.',
    });
    const many = Array.from({ length: 32 }, (_, index) => membership(`/r/${index}`));
    expect(validateWorkspaceRootInput('/r/new', many, HOME).ok).toBe(false);
  });
});

describe('per-host workspace root order', () => {
  it('keeps same-path roots on two hosts independent across a round trip', () => {
    let document = emptyWorkspacePreferences();
    document = withHostWorkspacePreferences(document, 'host-a', { rootOrder: ['/home/me/tmp', '/home/me/git'] });
    document = withHostWorkspacePreferences(document, 'host-b', { rootOrder: ['/home/me/git', '/home/me/tmp'] });
    const restored = parseWorkspacePreferences(serializeWorkspacePreferences(document));
    expect(hostWorkspacePreferences(restored, 'host-a').rootOrder).toEqual(['/home/me/tmp', '/home/me/git']);
    expect(hostWorkspacePreferences(restored, 'host-b').rootOrder).toEqual(['/home/me/git', '/home/me/tmp']);
    expect(hostWorkspacePreferences(restored, 'host-c').rootOrder).toEqual([]);
  });

  it('seeds an older client order without overwriting a newer one', () => {
    let document = withHostWorkspacePreferences(emptyWorkspacePreferences(), 'host-a', { rootOrder: ['/new'] });
    document = seedHostWorkspacePreferences(document, 'host-a', { rootOrder: ['/old'] });
    document = seedHostWorkspacePreferences(document, 'host-b', { rootOrder: ['/old'] });
    expect(document.hosts['host-a']).toEqual({ rootOrder: ['/new'] });
    expect(document.hosts['host-b']).toEqual({ rootOrder: ['/old'] });
  });

  it('refuses malformed stored order instead of resetting it', () => {
    expect(parseWorkspacePreferences(null)).toEqual(emptyWorkspacePreferences());
    for (const raw of [
      '{',
      '[]',
      '{"schemaVersion":2,"hosts":{}}',
      '{"schemaVersion":1,"hosts":{"a":{"rootOrder":"x"}}}',
      '{"schemaVersion":1,"hosts":{"a":{"rootOrder":["/a","/a"]}}}',
      '{"schemaVersion":1,"hosts":{"a":{"rootOrder":[7]}}}',
      '{"schemaVersion":1,"hosts":{"":{"rootOrder":[]}}}',
    ]) {
      expect(() => parseWorkspacePreferences(raw), raw).toThrow(WorkspacePreferencesError);
    }
    expect(() => withHostWorkspacePreferences(emptyWorkspacePreferences(), ' ', { rootOrder: [] }))
      .toThrow(WorkspacePreferencesError);
  });
});
