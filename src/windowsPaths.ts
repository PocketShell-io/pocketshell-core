/**
 * The three spellings one Windows directory carries, and the two forms the
 * app's consumers actually accept.
 *
 * On a Git-for-Windows host the same directory arrives as `C:\Users\u\git`
 * (aplexer records, Windows-native tools), `C:/Users/u/git` (what we send
 * `a`), `/c/Users/u/git` (MSYS `$HOME`, `pwd -P`, bash) and
 * `/C:/Users/u/git` (the SFTP server). The transports are strict in opposite
 * directions — the SFTP server only accepts the `/X:/` form, bash refuses it
 * — so every boundary converts through here rather than each caller
 * re-deriving the rules. Pure string work; a colon is not legal in a POSIX
 * path component, so the drive shape is an unambiguous discriminator and
 * POSIX paths pass through every form function untouched.
 */
import { normaliseWindowsPath, msysToDrivePath } from './sessionGrouping';

/**
 * The spelling bash on a Git-for-Windows host accepts: `C:/...` (drive,
 * forward slashes) or `/c/...` (MSYS) — never the SFTP `/C:/...` form, whose
 * `cd` fails. POSIX paths are returned unchanged.
 */
export function bashPathForm(value: string): string {
  return normaliseWindowsPath(value) ?? value;
}

/**
 * The drive spelling (`C:/...`) aplexer records and compares workspaces in,
 * from any of the Windows spellings. The canonical form for everything the
 * app SENDS to or READS from `a`: `a start` accepts any spelling but the
 * record comes back normalised, so reuse checks must compare like with like.
 * POSIX paths are returned unchanged.
 */
export function windowsWorkspaceForm(value: string): string {
  return normaliseWindowsPath(value) ?? msysToDrivePath(value) ?? value;
}
