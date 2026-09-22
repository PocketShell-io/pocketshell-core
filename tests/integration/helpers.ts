import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { describe } from 'vitest';
import type { AplexerExecOutcome, AplexerTransport } from '../../src/aplexerClientCore';
import { toDirEntry, toFileStat, type DirEntry, type FileStat, type SftpAttrsLike } from '../../src/sftpCore';

/**
 * Shared helpers for the integration tests.
 *
 * The tier mirrors pocketshell-desktop's tests/integration: `testcontainers`
 * starts ephemeral containers from the prebuilt `pocketshell-test:*` tags
 * (build them once with `scripts/build-docker.sh` — the fleet files under
 * tests-docker/ are byte-identical copies of the desktop fleet, so either
 * project's build script produces the same images). Every suite REFUSES to
 * collect when Docker is unavailable rather than skipping — a suite that
 * cannot run must be a red file, never a green tick nobody earned.
 *
 * ssh2 stays a devDependency: the transport is platform-side by contract, and
 * these suites play the platform so core's client code runs against a real
 * sshd, real sftp subsystem and real `a` (aplexer) host.
 */

const DOCKER_DIR = resolve(__dirname, '..', '..', 'tests-docker');

/** Absolute path to the committed ed25519 test private key. */
export const TEST_KEY_PATH = resolve(DOCKER_DIR, 'test_key');

/** True iff the docker CLI is present AND the daemon answers `docker info`. */
export function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `describe` wrapper that REFUSES to collect the suite when Docker is
 * unavailable. Skipping would report a green suite that ran nothing; throwing
 * during collection turns the same state into a loud red file — start Docker
 * or build the images (`scripts/build-docker.sh`).
 */
export function describeDocker(name: string, fn: () => void): void {
  if (!isDockerAvailable()) {
    throw new Error(
      `${name}: Docker is not reachable, so this integration suite cannot run. ` +
        'Start Docker (docker info must answer) rather than letting the suite skip.',
    );
  }
  describe(name, fn);
}

/** One live ssh2 connection to a test container, plus its captured host key. */
export interface SshHandle {
  conn: Client;
  /** The raw public-key blob the server presented, from the hostVerifier. */
  hostKeyBlob: Buffer;
  close(): void;
}

/** Connect as testuser with the committed key; reject on any failure. */
export function connectSsh(
  host: string,
  port: number,
  opts: { username?: string; timeoutMs?: number } = {},
): Promise<SshHandle> {
  return new Promise((onReady, onError) => {
    const conn = new Client();
    let hostKeyBlob: Buffer | undefined;
    const cfg: ConnectConfig = {
      host,
      port,
      username: opts.username ?? 'testuser',
      privateKey: readFileSync(TEST_KEY_PATH),
      readyTimeout: opts.timeoutMs ?? 15_000,
      // TOFU by hand: accept whatever the container presents, remember the
      // blob — the known-hosts suite runs core's verdicts against it.
      hostVerifier: (key: Buffer) => {
        hostKeyBlob = key;
        return true;
      },
    };
    conn
      .on('ready', () =>
        onReady({
          conn,
          hostKeyBlob: hostKeyBlob ?? Buffer.alloc(0),
          close: () => conn.end(),
        }),
      )
      .on('error', onError)
      .connect(cfg);
  });
}

function execOnce(
  conn: Client,
  command: string,
): Promise<AplexerExecOutcome> {
  return new Promise((onDone, onError) => {
    conn.exec(command, (err, stream) => {
      if (err) return onError(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        onDone({ exitCode: code, stdout, stderr });
      });
    });
  });
}

/** Adapt an ssh2 connection to core's one-method `AplexerTransport`. */
export function execTransport(handle: SshHandle): AplexerTransport {
  return {
    exec: (command: string) => execOnce(handle.conn, command),
  };
}

/** sftp handle plus the readdir/stat normalisation desktop's SftpService runs. */
export interface SftpHandle {
  raw: SFTPWrapper;
  /** core's contract: readdir elements → DirEntry, exactly as the desktop maps them. */
  list(path: string): Promise<DirEntry[]>;
  /** core's contract: stat → FileStat. */
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  close(): void;
}

export async function openSftp(handle: SshHandle): Promise<SftpHandle> {
  const sftp = await new Promise<SFTPWrapper>((onReady, onError) =>
    handle.conn.sftp((err, raw) => (err ? onError(err) : onReady(raw))),
  );
  const call = <T>(op: (s: SFTPWrapper, done: (err: Error | null, value?: T) => void) => void) =>
    new Promise<T>((onDone, onError) =>
      op(sftp, (err, value) => (err ? onError(err) : onDone(value as T))),
    );

  return {
    raw: sftp,
    list: (path: string) =>
      call<{ filename: string; longname: string; attrs: SftpAttrsLike }[]>((s, done) =>
        s.readdir(path, (err, entries) => done(err as never, entries as never)),
      ).then((entries) =>
        // The exact normalisation desktop's SftpService.run does:
        // ssh2 attrs spread + longname, through core's toDirEntry.
        entries.map((e) => toDirEntry({ ...e.attrs, longname: e.longname }, e.filename)),
      ),
    stat: (path: string) =>
      call<SftpAttrsLike>((s, done) =>
        s.stat(path, (err, attrs) => done(err as never, attrs as never)),
      ).then((attrs) => toFileStat(attrs)),
    readFile: (path: string) => call<Buffer>((s, done) => s.readFile(path, done as never)),
    writeFile: (path: string, data: string | Buffer) =>
      call<void>((s, done) => s.writeFile(path, data, done as never)),
    mkdir: (path: string) => call<void>((s, done) => s.mkdir(path, done as never)),
    rename: (from: string, to: string) => call<void>((s, done) => s.rename(from, to, done as never)),
    unlink: (path: string) => call<void>((s, done) => s.unlink(path, done as never)),
    rmdir: (path: string) => call<void>((s, done) => s.rmdir(path, done as never)),
    close: () => sftp.end(),
  };
}
