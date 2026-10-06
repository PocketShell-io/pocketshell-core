import { describe, expect, it } from 'vitest';
import { USER_BIN_DIRS, USER_BIN_PATH } from '../src/userBinPath';
import { aplexerProbeCommand, pathAwareCommand } from '../src/aplexerCommands';

/**
 * The bundled-aplexer dirs. Helper 0.5.x pins aplexer as a hard dependency,
 * so a host that ran the one documented install step (`uv tool install
 * pocketshell`) carries `a` in the tool venv's bin dir — nowhere the old
 * three-dir PATH could see. These tests pin the resolution contract: the
 * probe finds the bundled copy, and a standalone install still wins.
 */
describe('USER_BIN_DIRS', () => {
  it('searches the pocketshell tool-venv bins after the standard user bins', () => {
    expect(USER_BIN_DIRS).toEqual([
      '$HOME/.local/bin',
      '$HOME/bin',
      '$HOME/.cargo/bin',
      '$HOME/.local/share/uv/tools/pocketshell/bin',
      '$HOME/.local/pipx/venvs/pocketshell/bin',
    ]);
  });

  it('puts the bundled dirs before $PATH so the probe resolves on a bare sshd PATH', () => {
    // sshd's exec PATH is `/usr/bin:/bin` — a bundled `a` is reachable only
    // because the wrapper's prefix carries the venv dir. The prefix is
    // spliced before `$PATH` at every call site, so the venv dirs must be
    // part of USER_BIN_PATH itself, not left to the caller.
    const wrapped = pathAwareCommand(aplexerProbeCommand());
    expect(wrapped).toContain(
      'PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin' +
        ':$HOME/.local/share/uv/tools/pocketshell/bin' +
        ':$HOME/.local/pipx/venvs/pocketshell/bin:$PATH"',
    );
  });

  it('keeps the bundled dirs behind the standard user bins', () => {
    // A deliberately installed standalone `a` (uv/pipx expose it through
    // `~/.local/bin`) must keep winning over the venv copy — the order is
    // the only thing that decides, since `command -v a` returns the first
    // hit.
    const uvIndex = USER_BIN_DIRS.indexOf('$HOME/.local/share/uv/tools/pocketshell/bin');
    const localBinIndex = USER_BIN_DIRS.indexOf('$HOME/.local/bin');
    expect(uvIndex).toBeGreaterThan(localBinIndex);
    expect(USER_BIN_PATH.startsWith(USER_BIN_DIRS[0]!)).toBe(true);
  });
});
