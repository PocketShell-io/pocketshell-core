import { describe, expect, it } from 'vitest';
import { runHostBootstrap } from '../src/hostBootstrap';
import type { ExecResult } from '../src/types';

function hostWith(binaries: Record<string, string>) {
  const commands: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    const probe = /command -v (\S+)$/.exec(command.replace(/'$/, ''));
    if (probe) {
      const path = binaries[probe[1]!];
      return path ? { exitCode: 0, stdout: `${path}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' };
    }
    const version = /(\S+) --version/.exec(command);
    if (version && binaries[version[1]!]) return { exitCode: 0, stdout: `${version[1]} 1.2.3\n`, stderr: '' };
    return { exitCode: 3, stdout: '', stderr: '' };
  };
  return { exec, commands };
}

describe('runHostBootstrap', () => {
  it('reports each tool, the installer and the daemon state from one exec effect', async () => {
    const host = hostWith({ pocketshell: '/home/u/.local/bin/pocketshell', a: '/home/u/.local/bin/a', uv: '/usr/bin/uv', systemctl: '/usr/bin/systemctl' });
    const result = await runHostBootstrap(host.exec);
    expect(result.pocketshell).toEqual({ installed: true, path: '/home/u/.local/bin/pocketshell', version: 'pocketshell 1.2.3' });
    expect(result.aplexer.installed).toBe(true);
    expect(result.tmux).toEqual({ installed: false, path: null, version: null });
    expect(result.installer).toBe('uv');
    expect(result.daemonRunning).toBe(false);
    expect(result.daemonEnabled).toBe(false);
  });

  it('skips the daemon probe on a host without the helper', async () => {
    const host = hostWith({ tmux: '/usr/bin/tmux' });
    const result = await runHostBootstrap(host.exec);
    expect(result.pocketshell.installed).toBe(false);
    expect(result.daemonRunning).toBeNull();
    expect(host.commands.some((command) => command.includes('systemctl --user'))).toBe(false);
  });
});

describe('runHostBootstrap on a Windows host', () => {
  function windowsHostWith(binaries: Record<string, string>) {
    const commands: string[] = [];
    const exec = async (command: string): Promise<ExecResult> => {
      commands.push(command);
      if (command === 'uname -s') return { exitCode: 0, stdout: 'MINGW64_NT-10.0-19045\n', stderr: '' };
      const probe = /command -v (\S+)$/.exec(command.replace(/'$/, ''));
      if (probe) {
        const path = binaries[probe[1]!];
        return path ? { exitCode: 0, stdout: `${path}\n`, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' };
      }
      return { exitCode: 3, stdout: '', stderr: '' };
    };
    return { exec, commands };
  }

  it('reports the platform and answers the POSIX-only tools without probing them', async () => {
    const host = windowsHostWith({ a: 'C:/Users/u/bin/a' });
    const result = await runHostBootstrap(host.exec);
    expect(result.platform).toBe('windows');
    expect(result.pocketshell).toEqual({ installed: false, path: null, version: null });
    expect(result.tmuxctl).toEqual({ installed: false, path: null, version: null });
    expect(result.tmux).toEqual({ installed: false, path: null, version: null });
    expect(result.aplexer.installed).toBe(true);
    expect(result.daemonRunning).toBeNull();
    const probed = host.commands.filter((c) => /command -v/.test(c));
    expect(probed.some((c) => c.includes('pocketshell'))).toBe(false);
    expect(probed.some((c) => c.includes('tmuxctl'))).toBe(false);
    expect(probed.some((c) => c.includes("'tmux'"))).toBe(false);
    expect(probed.some((c) => /command -v a$/.test(c.replace(/'$/, '')))).toBe(true);
  });

  it('honours a pre-detected platform and skips the uname exec', async () => {
    const host = windowsHostWith({ a: 'C:/Users/u/bin/a' });
    const result = await runHostBootstrap(host.exec, { platform: 'windows' });
    expect(result.platform).toBe('windows');
    expect(host.commands.some((c) => c === 'uname -s')).toBe(false);
  });

  it('keeps probing every tool on a POSIX host', async () => {
    const host = windowsHostWith({ tmux: '/usr/bin/tmux' });
    // Force the platform answer to posix by swapping the uname output.
    const posixHost = {
      exec: async (command: string): Promise<ExecResult> => {
        if (command === 'uname -s') return { exitCode: 0, stdout: 'Linux\n', stderr: '' };
        return host.exec(command);
      },
      commands: host.commands,
    };
    const result = await runHostBootstrap(posixHost.exec);
    expect(result.platform).toBe('posix');
    expect(result.tmux.installed).toBe(true);
    expect(result.aplexer.installed).toBe(false);
  });
});
