import { afterAll, beforeAll, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { connectSsh, describeDocker, execTransport, openSftp, type SftpHandle, type SshHandle } from './helpers';

/**
 * Integration tests for core's SFTP contract (`toDirEntry` / `toFileStat` /
 * `entryTypeOf`) against the real `pocketshell-test:ssh` image's OpenSSH sftp
 * subsystem. The normalisation is the contract: whatever the server sends
 * must render the same verdicts (file / dir / symlink) and the same numbers
 * on both clients, so the suites feed REAL readdir/stat output through core's
 * code — the exact mapping desktop's SftpService runs, byte for byte.
 */
describeDocker('SftpCore integration', () => {
  let container: StartedTestContainer | undefined;
  let handle: SshHandle;
  let sftp: SftpHandle;
  let home: string;
  let scratch: string;

  beforeAll(async () => {
    container = await new GenericContainer('pocketshell-test:ssh')
      .withExposedPorts(22)
      .start();
    handle = await connectSsh(container.getHost(), container.getMappedPort(22));
    sftp = await openSftp(handle);
    home = (await execTransport(handle).exec('echo $HOME')).stdout.trim();
    scratch = `${home}/pscore-sftp-${Date.now()}`;
    await sftp.mkdir(scratch);
  }, 120_000);

  afterAll(async () => {
    try {
      if (sftp && scratch) {
        for (const name of ['payload.bin', 'note.txt', 'link']) {
          await sftp.unlink(`${scratch}/${name}`).catch(() => {});
        }
        await sftp.rmdir(`${scratch}/sub`).catch(() => {});
        await sftp.rmdir(scratch).catch(() => {});
      }
    } catch {
      // best-effort cleanup; container teardown finishes the job
    }
    sftp?.close();
    handle?.close();
    if (container) await container.stop();
  }, 30_000);

  it('lists the home directory with real server attrs through toDirEntry', async () => {
    const entries = await sftp.list(home);
    const names = entries.map((e) => e.name);
    expect(names).toContain('.ssh');
    const dotSsh = entries.find((e) => e.name === '.ssh')!;
    expect(dotSsh.type).toBe('dir');
    // A real user on a real server: the numbers are populated, never NaN.
    expect(dotSsh.owner).toBeGreaterThan(0);
    expect(dotSsh.modifyTime).toBeGreaterThan(0);
    expect(dotSsh.rights.user).toBe('rwx');
  });

  it('write → read-back is byte-identical and stat reports the exact size', async () => {
    // 256 KiB of deterministic pseudo-random bytes: a real payload, not ''.
    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    const path = `${scratch}/payload.bin`;
    await sftp.writeFile(path, payload);

    const back = await sftp.readFile(path);
    expect(back.equals(payload)).toBe(true);

    const stat = await sftp.stat(path);
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(payload.length);
    // mtime is server clock vs ours — a fresh container is within minutes.
    expect(Math.abs(Date.now() - stat.modifyTime)).toBeLessThan(10 * 60_000);
  });

  it('classifies dir / file / symlink in one listing', async () => {
    await sftp.writeFile(`${scratch}/note.txt`, 'hello\n');
    await sftp.mkdir(`${scratch}/sub`);
    // A symlink needs a shell — sftp's symlink op varies across servers.
    await execTransport(handle).exec(`ln -sfn ${scratch}/note.txt ${scratch}/link`);

    const entries = await sftp.list(scratch);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('note.txt')?.type).toBe('file');
    expect(byName.get('sub')?.type).toBe('dir');
    expect(byName.get('link')?.type).toBe('symlink');
    // The longname's ls-letter and the attrs helpers must agree on OpenSSH.
    expect(byName.get('link')?.longname.startsWith('l')).toBe(true);
  });

  it('rename / unlink / rmdir round-trip', async () => {
    await sftp.writeFile(`${scratch}/note.txt`, 'moved?\n');
    const from = `${scratch}/note.txt`;
    const to = `${scratch}/renamed.txt`;
    await sftp.rename(from, to);
    const after = await sftp.list(scratch);
    expect(after.map((e) => e.name)).not.toContain('note.txt');
    expect(after.map((e) => e.name)).toContain('renamed.txt');
    expect((await sftp.readFile(to)).toString()).toBe('moved?\n');

    await sftp.unlink(to);
    await sftp.rmdir(`${scratch}/sub`);
    const names = (await sftp.list(scratch)).map((e) => e.name);
    expect(names).not.toContain('renamed.txt');
    expect(names).not.toContain('sub');
  });
});
