import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/types';
import {
  HOST_PLATFORM_UNAME_PROBE,
  HOST_PLATFORM_VER_PROBE,
  detectHostPlatform,
  hostPlatformFromUname,
  hostPlatformFromVer,
} from '../src/hostPlatform';

describe('hostPlatformFromUname', () => {
  it('classifies the Windows bash kernels as windows', () => {
    expect(hostPlatformFromUname('MINGW64_NT-10.0-19045\n')).toBe('windows');
    expect(hostPlatformFromUname('MSYS_NT-10.0-26200\n')).toBe('windows');
    expect(hostPlatformFromUname('CYGWIN_NT-10.0-19045\n')).toBe('windows');
  });

  it('classifies WSL and every other kernel name as posix', () => {
    expect(hostPlatformFromUname('Linux\n')).toBe('posix');
    expect(hostPlatformFromUname('Darwin\n')).toBe('posix');
    expect(hostPlatformFromUname('FreeBSD\n')).toBe('posix');
  });

  it('answers null for empty output so the caller tries the next probe', () => {
    expect(hostPlatformFromUname('')).toBeNull();
    expect(hostPlatformFromUname('\n')).toBeNull();
  });
});

describe('hostPlatformFromVer', () => {
  it('reads the cmd banner as windows', () => {
    expect(hostPlatformFromVer('Microsoft Windows [Version 10.0.26200.6901]\r\n')).toBe('windows');
  });

  it('reads anything else as posix by elimination', () => {
    expect(hostPlatformFromVer('')).toBe('posix');
    expect(hostPlatformFromVer('bash: cmd: command not found\n')).toBe('posix');
  });
});

describe('detectHostPlatform', () => {
  const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });

  it('answers from uname alone on a Git-for-Windows host', async () => {
    const commands: string[] = [];
    const platform = await detectHostPlatform(async (command) => {
      commands.push(command);
      return command === HOST_PLATFORM_UNAME_PROBE ? ok('MINGW64_NT-10.0-19045\n') : ok('');
    });
    expect(platform).toBe('windows');
    expect(commands).toEqual([HOST_PLATFORM_UNAME_PROBE]);
  });

  it('falls through to the cmd banner when uname does not answer', async () => {
    const commands: string[] = [];
    const platform = await detectHostPlatform(async (command) => {
      commands.push(command);
      return command === HOST_PLATFORM_UNAME_PROBE
        ? { exitCode: 1, stdout: '', stderr: 'uname: not found' }
        : ok('Microsoft Windows [Version 10.0.19045.3803]\r\n');
    });
    expect(platform).toBe('windows');
    expect(commands).toEqual([HOST_PLATFORM_UNAME_PROBE, HOST_PLATFORM_VER_PROBE]);
  });

  it('declares posix when uname answers with a POSIX kernel', async () => {
    const platform = await detectHostPlatform(async (command) =>
      command === HOST_PLATFORM_UNAME_PROBE ? ok('Linux\n') : ok(''),
    );
    expect(platform).toBe('posix');
  });

  it('declares posix, without throwing, when both probes fail', async () => {
    const platform = await detectHostPlatform(async () => {
      throw new Error('channel died');
    });
    expect(platform).toBe('posix');
  });
});
