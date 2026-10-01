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
