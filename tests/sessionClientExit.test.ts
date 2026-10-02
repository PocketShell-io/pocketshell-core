import { describe, expect, it } from 'vitest';
import { sessionOutlivedClient } from '../src/sessionClientExit';
import type { SessionSummary } from '../src/types';

/**
 * #3039: an aplexer pane's attach client exited. A killed session and a
 * dropped client produce the same clean exit; the verdict reads the host's
 * fresh listing and re-joins only on positive evidence the SAME session is
 * still running.
 */
function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    name: 'main', created: 1, activity: 1, attached: true, path: '/w', backend: 'aplexer',
    workspace: '/w', tag: 'main', aplexerId: 'id-1', aplexerPhase: 'running', ...patch,
  };
}

const byId = { sessionName: 'main', workspace: '/w', aplexerId: 'id-1' };
const byTag = { sessionName: 'main', workspace: '/w', aplexerId: null };

describe('sessionOutlivedClient', () => {
  it('re-joins a session the host still lists as running (the client merely dropped)', () => {
    expect(sessionOutlivedClient([summary()], byId)).toBe(true);
    expect(sessionOutlivedClient([summary({ aplexerPhase: 'starting' })], byId)).toBe(true);
    expect(sessionOutlivedClient([summary({ aplexerId: null })], byTag)).toBe(true);
  });

  it('reads an absent session as ended (killed and its record removed)', () => {
    expect(sessionOutlivedClient([], byId)).toBe(false);
    expect(sessionOutlivedClient([summary({ aplexerId: 'id-2', tag: 'other', name: 'other' })], byId)).toBe(false);
  });

  it('reads an ending phase as ended, whatever the case or padding', () => {
    for (const phase of ['exiting', 'exited', 'failed', ' Exiting ']) {
      expect(sessionOutlivedClient([summary({ aplexerPhase: phase })], byId)).toBe(false);
    }
  });

  it('never re-joins a NEW session that reuses the tag of the one whose client exited', () => {
    expect(sessionOutlivedClient([summary({ aplexerId: 'id-new' })], byId)).toBe(false);
  });

  it('without an id, matches the workspace-qualified tag only', () => {
    expect(sessionOutlivedClient([summary({ aplexerId: null, workspace: '/elsewhere' })], byTag)).toBe(false);
    expect(sessionOutlivedClient([summary({ aplexerId: null, workspace: '/elsewhere' })], { sessionName: 'main' })).toBe(true);
  });

  it('treats a host that reports no phase by presence alone (it lists live sessions only)', () => {
    expect(sessionOutlivedClient([summary({ aplexerPhase: undefined })], byId)).toBe(true);
    expect(sessionOutlivedClient([summary({ aplexerPhase: null })], byId)).toBe(true);
  });
});
