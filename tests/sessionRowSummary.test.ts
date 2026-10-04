import { describe, expect, it } from 'vitest';
import { findSessionRow, sessionRowToSummary } from '../src/sessionRowSummary';
import type { SessionRow } from '../src/hostCliSessions';

function row(patch: Partial<SessionRow>): SessionRow {
  return {
    name: 'demo', id: null, workspace: null, tag: null, engine: null, profile: null,
    agent: null, agentState: null, agentStateSource: null, attached: false,
    createdEpoch: null, activityEpoch: null, ...patch,
  };
}

describe('sessionRowToSummary', () => {
  it('projects a host-CLI row the way an aplexer snapshot row is projected', () => {
    expect(sessionRowToSummary(row({
      name: 'git-demo-main', id: 'uuid-1', workspace: '/home/u/git/demo', tag: 'main',
      engine: 'shell', agent: 'claude', profile: 'fast', attached: true, createdEpoch: 10, activityEpoch: 20,
    }))).toEqual({
      name: 'main', created: 10, activity: 20, attached: true, path: '/home/u/git/demo',
      agentKind: 'claude', backend: 'aplexer', workspace: '/home/u/git/demo', tag: 'main',
      aplexerId: 'uuid-1', profile: 'fast',
    });
  });

  it('falls back to the name and creation time when the host omits tag and activity', () => {
    const summary = sessionRowToSummary(row({ name: 'solo', createdEpoch: 5 }));
    expect(summary).toMatchObject({ name: 'solo', tag: 'solo', activity: 5, agentKind: null, path: null });
  });
});

describe('sessionRowToSummary phase (#3039)', () => {
  it('carries the host-reported aplexer phase, and omits it when the host gave none', () => {
    expect(sessionRowToSummary(row({ name: 'w:a', phase: 'exiting' })).aplexerPhase).toBe('exiting');
    expect('aplexerPhase' in sessionRowToSummary(row({ name: 'w:b' }))).toBe(false);
  });
});

describe('findSessionRow', () => {
  const rows = [
    row({ name: 'a-main', id: 'id-a', workspace: '/w/a', tag: 'main' }),
    row({ name: 'b-main', id: 'id-b', workspace: '/w/b', tag: 'main' }),
  ];

  it('prefers the aplexer id, then the workspace-qualified tag', () => {
    expect(findSessionRow(rows, { sessionName: 'main', aplexerId: 'id-b' })?.name).toBe('b-main');
    expect(findSessionRow(rows, { sessionName: 'main', workspace: '/w/b' })?.name).toBe('b-main');
    expect(findSessionRow(rows, { sessionName: 'a-main' })?.name).toBe('a-main');
    expect(findSessionRow(rows, { sessionName: 'gone' })).toBeNull();
  });
});
