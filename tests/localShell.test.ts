import { describe, expect, it } from 'vitest';
import {
  LOCAL_SHELL_DEFAULT,
  LOCAL_SHELL_OPTIONS,
  isLocalShellChoice,
  parseLocalShell,
  resolveLocalShell,
} from '../src/localShell';

describe('localShell — the interactive shell of a local terminal', () => {
  it('parses the offered choices and reads anything else as unset', () => {
    expect(parseLocalShell('')).toBe('');
    expect(parseLocalShell('powershell')).toBe('powershell');
    expect(parseLocalShell('pwsh')).toBe('pwsh');
    expect(parseLocalShell('cmd')).toBe('cmd');
    // Not a choice: the settings store reads undefined as "use the default".
    expect(parseLocalShell('fish')).toBeUndefined();
    expect(parseLocalShell(42)).toBeUndefined();
    expect(parseLocalShell(null)).toBeUndefined();
    expect(LOCAL_SHELL_DEFAULT).toBe('');
  });

  it('offers auto first, and every id is a choice', () => {
    expect(LOCAL_SHELL_OPTIONS[0]?.id).toBe('');
    for (const option of LOCAL_SHELL_OPTIONS) {
      expect(isLocalShellChoice(option.id)).toBe(true);
    }
  });

  it('auto resolves to null — the caller keeps its own bash discovery', () => {
    expect(resolveLocalShell('')).toBeNull();
    expect(resolveLocalShell('bogus')).toBeNull();
  });

  it('resolves the Windows shells against the Windows layout', () => {
    const ps = resolveLocalShell('powershell', { systemRoot: 'C:\\WINDOWS' });
    expect(ps).toEqual({
      file: 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoLogo'],
    });
    const cmd = resolveLocalShell('cmd', { systemRoot: 'C:\\WINDOWS' });
    expect(cmd?.file.endsWith('System32\\cmd.exe')).toBe(true);
    expect(cmd?.args).toEqual([]);
  });

  it('resolves pwsh against PATH, with the banner suppressed like the rest', () => {
    expect(resolveLocalShell('pwsh')).toEqual({ file: 'pwsh.exe', args: ['-NoLogo'] });
  });
});
