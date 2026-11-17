import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingHostTools, missingHostToolsText, runHostBootstrap } from '../src/hostBootstrap';
import type { BootstrapResult } from '../src/types';
import type { ExecResult } from '../src/types';

/**
 * A real POSIX shell over a throwaway HOME whose ~/.local/bin holds stub
 * binaries: the probe script is executed, not pattern-matched, so a quoting
 * or `command -v` mistake in it fails here.
 */
function hostWith(
  binaries: Record<string, { version?: string | null; script?: string }>,
  uname = 'Linux',
) {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, spec] of Object.entries(binaries)) {
    const body = spec.script ?? (spec.version === null ? 'exit 3' : `echo "${name} ${spec.version ?? '1.2.3'}"; echo extra`);
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  // Hermetic PATH: only the utilities the probe script needs, so the dev
  // box's own pocketshell/a/tmux/systemctl can never leak into a result.
  const sys = join(home, 'sys');
  mkdirSync(sys);
  for (const util of ['sed', 'id']) symlinkSync(execFileSync('which', [util], { encoding: 'utf8' }).trim(), join(sys, util));
  const commands: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    if (command === 'uname -s') return { exitCode: 0, stdout: `${uname}\n`, stderr: '' };
    // `-lc` would source /etc/profile and re-add the real /usr/bin.
    const r = spawnSync('/bin/sh', ['-c', command.replace(/^\/bin\/sh -lc /, '/bin/sh -c ')], { env: { HOME: home, PATH: sys }, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return { exec, commands, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const probeExecs = (commands: string[]) => commands.filter((c) => c !== 'uname -s');

describe('runHostBootstrap', () => {
  it('reports each tool, the installer and the daemon state from ONE exec', async () => {
    const host = hostWith({ pocketshell: {}, a: {}, uv: {}, systemctl: { script: 'exit 3' } });
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.pocketshell.installed).toBe(true);
    expect(result.pocketshell.path).toMatch(/\.local\/bin\/pocketshell$/);
    expect(result.pocketshell.version).toBe('pocketshell 1.2.3');
    expect(result.aplexer.installed).toBe(true);
    expect(result.tmux).toEqual({ installed: false, path: null, version: null });
    expect(result.installer).toBe('uv');
    expect(result.daemonRunning).toBe(false);
    expect(result.daemonEnabled).toBe(false);
    expect(probeExecs(host.commands)).toHaveLength(1);
  });

  it('prefers uv over pipx, falls back to pipx, and reports none', async () => {
    const both = hostWith({ uv: {}, pipx: {} });
    expect((await runHostBootstrap(both.exec)).installer).toBe('uv');
    both.cleanup();
    const pipx = hostWith({ pipx: {} });
    expect((await runHostBootstrap(pipx.exec)).installer).toBe('pipx');
    pipx.cleanup();
    const none = hostWith({});
    expect((await runHostBootstrap(none.exec)).installer).toBeNull();
    none.cleanup();
  });

  it('keeps a tool installed with a null version when --version fails', async () => {
    const host = hostWith({ pocketshell: { version: null } });
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.pocketshell.installed).toBe(true);
    expect(result.pocketshell.version).toBeNull();
  });

  it('skips the daemon probe on a host without the helper', async () => {
    const host = hostWith({ tmux: {}, systemctl: { script: 'exit 0' } });
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.pocketshell.installed).toBe(false);
    expect(result.tmux.installed).toBe(true);
    expect(result.daemonRunning).toBeNull();
    expect(result.daemonEnabled).toBeNull();
  });

  it('reads daemon state from systemctl exit codes', async () => {
    const host = hostWith({
      pocketshell: {},
      systemctl: { script: 'case "$2" in is-active) exit 0;; *) exit 1;; esac' },
    });
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.daemonRunning).toBe(true);
    expect(result.daemonEnabled).toBe(false);
  });

  it('fails loudly when the probe did not run to completion', async () => {
    await expect(runHostBootstrap(async () => ({ exitCode: 127, stdout: '', stderr: 'sh: not found' }), { platform: 'posix' }))
      .rejects.toThrow(/host probe failed/);
  });
});

describe('runHostBootstrap on a Windows host', () => {
  it('reports the platform and answers the POSIX-only tools without probing them', async () => {
    const host = hostWith({ a: {}, pocketshell: {}, tmux: {} }, 'MINGW64_NT-10.0-19045');
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.platform).toBe('windows');
    expect(result.pocketshell).toEqual({ installed: false, path: null, version: null });
    expect(result.tmuxctl).toEqual({ installed: false, path: null, version: null });
    expect(result.tmux).toEqual({ installed: false, path: null, version: null });
    expect(result.aplexer.installed).toBe(true);
    expect(result.daemonRunning).toBeNull();
    const script = probeExecs(host.commands).join('\n');
    expect(script).not.toMatch(/command -v (pocketshell|tmuxctl|tmux)\)/);
    expect(script).toContain('command -v a)');
  });

  it('honours a pre-detected platform and skips the uname exec', async () => {
    const host = hostWith({ a: {} });
    const result = await runHostBootstrap(host.exec, { platform: 'windows' });
    host.cleanup();
    expect(result.platform).toBe('windows');
    expect(host.commands.some((c) => c === 'uname -s')).toBe(false);
  });

  it('keeps probing every tool on a POSIX host', async () => {
    const host = hostWith({ tmux: {} });
    const result = await runHostBootstrap(host.exec);
    host.cleanup();
    expect(result.platform).toBe('posix');
    expect(result.tmux.installed).toBe(true);
    expect(result.aplexer.installed).toBe(false);
  });
});

describe('missingHostTools', () => {
  function bootstrapWith(pocketshell: boolean, platform: 'posix' | 'windows' = 'posix'): BootstrapResult {
    const installed = { installed: true, path: '/usr/bin/x', version: null };
    const absent = { installed: false, path: null, version: null };
    return {
      platform,
      pocketshell: pocketshell ? installed : absent,
      tmuxctl: absent,
      tmux: absent,
      aplexer: installed,
      installer: 'uv',
      daemonRunning: null,
      daemonEnabled: null,
    };
  }

  it('names pocketshell alone — a current helper carries aplexer and needs neither tmuxctl nor tmux', () => {
    // The host the strip used to call broken: pocketshell installed, every
    // other tool absent. That is the documented install, and every session
    // path (list, create, join, stop, rename) rides the bundled aplexer.
    const b = bootstrapWith(true);
    expect(b.tmuxctl.installed).toBe(false);
    expect(b.tmux.installed).toBe(false);
    expect(missingHostTools(b)).toEqual([]);
  });

  it('names pocketshell when the helper is absent, and nothing else', () => {
    expect(missingHostTools(bootstrapWith(false))).toEqual(['pocketshell']);
  });

  it('stays quiet before the probe lands and on windows hosts', () => {
    expect(missingHostTools(null)).toEqual([]);
    expect(missingHostTools(bootstrapWith(false, 'windows'))).toEqual([]);
  });

  it('joins the text the strip renders', () => {
    expect(missingHostToolsText([])).toBe('');
    expect(missingHostToolsText(['pocketshell'])).toBe('pocketshell');
    expect(missingHostToolsText(['pocketshell', 'tmuxctl'])).toBe('pocketshell and tmuxctl');
  });
});
