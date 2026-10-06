/**
 * Which kind of machine is on the far end of the SSH connection.
 *
 * The remote fleet is not only POSIX boxes. OpenSSH for Windows accepts a
 * configured `DefaultShell`, and on dev boxes that shell is often bash (Git
 * for Windows / MSYS2) — so every `pathAwareCommand` exec already works, while
 * everything that assumes tmux, the helper, or /proc does not. Detecting the
 * platform once per connection lets the clients skip the POSIX-only probes
 * instead of running them into the ground and reporting the wreckage.
 *
 * Pure string work plus one probe effect, so desktop main, the web transport
 * and the Android adapter all classify a host the same way.
 */
import type { ExecResult, HostPlatform } from './types';

/**
 * First probe: `uname -s`. Under a bash DefaultShell (Git for Windows, MSYS2,
 * Cygwin, WSL) it answers; under cmd or PowerShell it fails, and the caller
 * falls through to the Windows-native probe.
 */
export const HOST_PLATFORM_UNAME_PROBE = 'uname -s';

/**
 * Second probe, reached only when `uname` did not answer: ask cmd for its
 * banner. `cmd /c ver` works when the DefaultShell IS cmd, when it is
 * PowerShell (which can launch cmd), and — harmlessly — never on POSIX, where
 * there is no `cmd`.
 */
export const HOST_PLATFORM_VER_PROBE = 'cmd /c ver';

/**
 * Read the platform off `uname -s` output.
 *
 * Windows answers with its build-flavoured names — `MINGW64_NT-10.0-19045`
 * (Git for Windows), `MSYS_NT-*`, `CYGWIN_NT-*`. WSL answers `Linux`, and
 * honestly so: everything POSIX there genuinely applies. Any other non-empty
 * kernel name (Linux, Darwin, FreeBSD…) is POSIX. Empty output means the
 * probe did not really run — `null`, so the caller tries the next probe
 * rather than guessing.
 */
export function hostPlatformFromUname(stdout: string): HostPlatform | null {
  const line = stdout.trim();
  if (!line) return null;
  if (/^(MINGW|MSYS|CYGWIN)/i.test(line)) return 'windows';
  return 'posix';
}

/**
 * Read the platform off `cmd /c ver` output. The banner looks like
 * `Microsoft Windows [Version 10.0.26200.6901]`; anything that does not say
 * Windows is POSIX by elimination.
 */
export function hostPlatformFromVer(stdout: string): HostPlatform | null {
  return /microsoft windows/i.test(stdout) ? 'windows' : 'posix';
}

/**
 * Classify the host with one or two execs. Never throws — an exec that fails
 * outright is answered by the next probe, and a host where both fail is
 * declared POSIX: the long-standing assumption every client already makes.
 */
export async function detectHostPlatform(
  exec: (command: string) => Promise<ExecResult>,
): Promise<HostPlatform> {
  try {
    const uname = await exec(HOST_PLATFORM_UNAME_PROBE);
    const fromUname = hostPlatformFromUname(uname.stdout);
    if (fromUname) return fromUname;
  } catch {
    // fall through to the cmd probe
  }
  try {
    const ver = await exec(HOST_PLATFORM_VER_PROBE);
    return hostPlatformFromVer(ver.stdout) ?? 'posix';
  } catch {
    return 'posix';
  }
}
