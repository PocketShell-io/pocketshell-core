import { describe, expect, it } from 'vitest';
import { agentKindFromEngine } from '../src/aplexerParsers';
import { buildLaunchCommand, kindUnavailableReason, launchBlocker, supportsProfiles, supportsSkipPermissions } from '../src/agentLaunch';
import { composerAgentKind, sendRoute } from '../src/composerSend';
import { commandsFor } from '../src/agentCommands';
import { agentBadge } from '../src/sessionTreeText';
import { isAgentSession } from '../src/sessionGrouping';
import { agentMark } from '../src/shared/agentBadge';

describe('Antigravity integration', () => {
  it('recognizes the canonical engine and binary alias in session records', () => {
    for (const engine of ['antigravity', 'agy', ' AGY ']) {
      expect(agentKindFromEngine(engine)).toBe('antigravity');
    }
    expect(isAgentSession('antigravity')).toBe(true);
    expect(agentBadge('antigravity')).toBe('antigravity');
    expect(agentMark('antigravity')).toEqual({ icon: 'brand-antigravity', label: 'Antigravity' });
  });

  it('requires an advertised remote helper capability before creating a session', () => {
    const choice = { kind: 'antigravity' as const, dir: '/work/project', skipPermissions: true, profile: null };
    expect(launchBlocker(choice, { subcommands: ['claude', 'codex'] })).toContain('Antigravity');
    expect(kindUnavailableReason('antigravity', { subcommands: null })).toContain('Antigravity');
    expect(launchBlocker(choice, { subcommands: ['antigravity'] })).toBeNull();
    expect(buildLaunchCommand(choice)).toBe("pocketshell agent antigravity --dir '/work/project'");
    expect(buildLaunchCommand({ ...choice, dir: '/work/with spaces', skipPermissions: false, profile: 'ignored' })).toBe("pocketshell agent antigravity --dir '/work/with spaces' --no-skip-permissions");
    expect(supportsSkipPermissions('antigravity')).toBe(true);
    expect(supportsProfiles('antigravity')).toBe(false);
  });

  it('routes composer prompts as agent input and offers documented CLI controls', () => {
    expect(composerAgentKind('antigravity')).toBe('antigravity');
    expect(commandsFor('antigravity').map((entry) => entry.command)).toContain('/permissions');
    expect(commandsFor('antigravity').map((entry) => entry.command)).toContain('/resume');
    expect(sendRoute({ withEnter: true, liveAgent: 'antigravity', presumedAgent: null })).toBe('raw');
  });
});
