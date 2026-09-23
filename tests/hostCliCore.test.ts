import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HostCliCore,
  HostCliFailed,
  HostCliMalformed,
  HostCliTooOld,
  parseHostSessionsList,
  parseHostWarnings,
  parseHostWorkspaces,
  type HostCliExecOutcome,
  type HostCliTransport,
} from '../src/index';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/pocketshell-0.5.8/${name}`, import.meta.url), 'utf8');
const warningFixture = (): string =>
  readFileSync(new URL('./fixtures/host-cli-current-source/sessions-warnings-reference.json', import.meta.url), 'utf8');

class ScriptedTransport implements HostCliTransport {
  readonly calls: Array<{ command: string; timeoutMs: number }> = [];

  constructor(
    private readonly answer: HostCliExecOutcome | Error | (() => HostCliExecOutcome | Promise<HostCliExecOutcome>),
  ) {}

  async exec(command: string, timeoutMs: number): Promise<HostCliExecOutcome> {
    this.calls.push({ command, timeoutMs });
    if (this.answer instanceof Error) throw this.answer;
    if (typeof this.answer === 'function') return this.answer();
    return this.answer;
  }
}

const ok = (stdout = ''): HostCliExecOutcome => ({ exitCode: 0, stdout, stderr: '' });

describe('HostCliCore sessions contract', () => {
  it('parses the captured 0.5.8 sessions list and ignores newer row fields', async () => {
    const transport = new ScriptedTransport(ok(fixture('sessions-list.json')));
    const listing = await new HostCliCore(transport).listSessions();

    expect(listing.sessions.map((session) => session.name)).toEqual(['testuser:build', 'testuser:main']);
    expect(listing.sessions[0]).toMatchObject({
      workspace: '/home/testuser',
      tag: 'build',
      attached: false,
      agentState: 'waiting',
      agentStateSource: 'heuristic',
    });
    expect(listing.errors).toEqual([]);
    expect(transport.calls).toEqual([{ command: 'pocketshell sessions list --json', timeoutMs: 20_000 }]);
  });

  it('keeps the host errors array even when there are no sessions', async () => {
    const listing = await new HostCliCore(
      new ScriptedTransport(ok(fixture('sessions-list-errors.json'))),
    ).listSessions();

    expect(listing.sessions).toEqual([]);
    expect(listing.errors).toEqual([
      { message: '`/does/not/exist --json snapshot` and `/does/not/exist --json list` both failed or returned unreadable JSON' },
    ]);
  });

  it('rejects an older schema, partial JSON, and a malformed session row', () => {
    expect(() => parseHostSessionsList('{"schema":2,"sessions":[]}')).toThrow(HostCliTooOld);
    expect(() => parseHostSessionsList('{"schema":3,"sessions":[')).toThrow(HostCliMalformed);
    expect(() => parseHostSessionsList('{"schema":3,"sessions":[{"name":"x","attached":"yes"}]}')).toThrow(HostCliMalformed);
  });

  it('rejects transport, timeout, and nonzero exit failures instead of returning an empty list', async () => {
    const noCli = new HostCliCore(new ScriptedTransport({
      exitCode: 127,
      stdout: '',
      stderr: 'pocketshell: command not found\n',
    }));
    await expect(noCli.listSessions()).rejects.toMatchObject<Partial<HostCliFailed>>({
      kind: 'failed',
      exitCode: 127,
      command: 'pocketshell sessions list --json',
      stderr: 'pocketshell: command not found\n',
    });

    const timeout = new HostCliCore(new ScriptedTransport({
      exitCode: null,
      stdout: '',
      stderr: 'still running',
      timedOut: true,
    }));
    await expect(timeout.listSessions()).rejects.toMatchObject<Partial<HostCliFailed>>({
      timedOut: true,
      exitCode: null,
    });

    const broken = new HostCliCore(new ScriptedTransport(new Error('channel closed')));
    await expect(broken.listSessions()).rejects.toMatchObject<Partial<HostCliFailed>>({
      exitCode: null,
      message: 'Could not run `pocketshell sessions list --json` on the host: channel closed',
    });
  });

  it('treats idempotent create as success and preserves the structured create error', async () => {
    const reused = await new HostCliCore(
      new ScriptedTransport(ok(fixture('sessions-create-existing.json'))),
    ).createSession('main', { cwd: '/home/testuser' });
    expect(reused).toEqual({
      name: 'testuser:main',
      id: '3763a224-3f30-4320-9d92-951ae7f6c972',
      created: false,
    });

    const createError = new HostCliCore(new ScriptedTransport({
      exitCode: 127,
      stdout: fixture('sessions-create-error.json'),
      stderr: '',
    }));
    await expect(createError.createSession('core-cli-capture', { cwd: '/home/testuser' }))
      .rejects.toMatchObject<Partial<HostCliFailed>>({
        kind: 'failed',
        exitCode: 127,
        message: "pocketshell: `a start --tag core-cli-capture` exited 127: [Errno 2] No such file or directory: 'systemd-run'",
      });
  });

  it('quotes adversarial create values and terminates positional option parsing', async () => {
    const transport = new ScriptedTransport(ok(fixture('sessions-create-existing.json')));
    const core = new HostCliCore(transport);
    await core.createSession('--help', {
      cwd: "/tmp/dir with 'quote'\nΩ $(touch /tmp/should-not-exist)",
      engine: "codex 'engine",
      profile: 'proﬁle Ω',
    });

    expect(transport.calls).toEqual([{
      command: "pocketshell sessions create --json --cwd '/tmp/dir with '\\''quote'\\''\nΩ $(touch /tmp/should-not-exist)' --engine 'codex '\\''engine' --profile 'proﬁle Ω' -- '--help'",
      timeoutMs: 60_000,
    }]);
  });

  it('kills by a terminated, quoted name and builds attach as a process-replacing command', async () => {
    const transport = new ScriptedTransport(ok());
    const core = new HostCliCore(transport);
    await core.killSession("it's --odd\nΩ");

    expect(transport.calls).toEqual([{
      command: "pocketshell sessions kill -- 'it'\\''s --odd\nΩ'",
      timeoutMs: 20_000,
    }]);
    expect(core.buildAttachCommand('--help')).toBe("exec pocketshell sessions attach -- '--help'");
  });
});

describe('HostCliCore warnings contract', () => {
  it('parses the warning array shape, maps known kinds, and builds exact selectors', () => {
    const warnings = parseHostWarnings(warningFixture());
    expect(warnings.map((warning) => warning.kind)).toEqual(['oom', 'crash']);
    expect(warnings[0]).toMatchObject({
      workspace: '/home/alexey/git/pocketshell',
      tag: 'work',
      ackSelector: '/home/alexey/git/pocketshell:work',
      createdAtMs: 1_768_320_000_000,
    });
    expect(warnings[1]?.ackSelector).toBe('/home/alexey/git/aplexer:api');
    expect(parseHostWarnings('[{"session":"id","kind":"new-kind","detail":"still shown"}]')[0])
      .toMatchObject({ kind: null, detail: 'still shown', ackSelector: 'id' });
  });

  it('surfaces unsupported warnings and ack verbs on published pocketshell 0.5.8', async () => {
    const warnings = new HostCliCore(new ScriptedTransport({
      exitCode: 2,
      stdout: '',
      stderr: readFileSync(new URL('./fixtures/pocketshell-0.5.8/sessions-warnings.stderr.txt', import.meta.url), 'utf8'),
    }));
    await expect(warnings.listWarnings()).rejects.toMatchObject<Partial<HostCliFailed>>({
      exitCode: 2,
      command: 'pocketshell sessions warnings --json',
      stderr: expect.stringContaining("No such command 'warnings'"),
    });

    const ack = new HostCliCore(new ScriptedTransport({
      exitCode: 2,
      stdout: '',
      stderr: readFileSync(new URL('./fixtures/pocketshell-0.5.8/sessions-ack.stderr.txt', import.meta.url), 'utf8'),
    }));
    await expect(ack.ackWarnings('--help')).rejects.toMatchObject<Partial<HostCliFailed>>({
      exitCode: 2,
      command: "pocketshell sessions ack --json -- '--help'",
      stderr: expect.stringContaining("No such command 'ack'"),
    });
  });
});

describe('HostCliCore workspaces contract', () => {
  it('parses captured schema-1 list, add, and remove responses', async () => {
    const empty = parseHostWorkspaces(fixture('workspaces-list-empty.json'));
    expect(empty.workspaces).toEqual([]);

    const added = await new HostCliCore(
      new ScriptedTransport(ok(fixture('workspaces-add.json'))),
    ).addWorkspace('core fixture', '/home/testuser/core-fixture');
    expect(added.workspaces).toEqual([{
      path: '/home/testuser/core-fixture',
      displayPath: '/home/testuser/core-fixture',
    }]);

    const removed = await new HostCliCore(
      new ScriptedTransport(ok(fixture('workspaces-remove.json'))),
    ).removeWorkspace('core fixture', '/home/testuser/core-fixture');
    expect(removed.workspaces).toEqual([]);
  });

  it('quotes paths and host identities as single arguments', async () => {
    const path = "/tmp/project 'one'\nΩ";
    const host = "opaque 'host'\nΩ";
    const transport = new ScriptedTransport(ok(fixture('workspaces-add.json')));
    await new HostCliCore(transport).addWorkspace(host, path);

    expect(transport.calls).toEqual([{
      command: "pocketshell workspaces add '/tmp/project '\\''one'\\''\nΩ' --host 'opaque '\\''host'\\''\nΩ' --json",
      timeoutMs: 20_000,
    }]);
  });

  it('rejects too-old, partial, and invalid schema-1 workspaces responses', () => {
    expect(() => parseHostWorkspaces('{"schema":0,"workspaces":[]}')).toThrow(HostCliTooOld);
    expect(() => parseHostWorkspaces('{"schema":1,"workspaces":[')).toThrow(HostCliMalformed);
    expect(() => parseHostWorkspaces('{"schema":1,"workspaces":[{"path":"  "}]}')).toThrow(HostCliMalformed);
    expect(() => parseHostWorkspaces('{"schema":1,"workspaces":[{"path":"/tmp","display_path":null}]}'))
      .toThrow(HostCliMalformed);
  });

  it('preserves structured mutation failure as a host failure', async () => {
    const transport = new ScriptedTransport({
      exitCode: 2,
      stdout: '{"schema":1,"error":{"code":"invalid_request","message":"bad path"}}',
      stderr: '{"schema": 1, "error": {"code": "invalid_request", "message": "bad path"}}\n',
    });
    await expect(new HostCliCore(transport).addWorkspace('host', 'relative-path'))
      .rejects.toMatchObject<Partial<HostCliFailed>>({
        exitCode: 2,
        stderr: expect.stringContaining('invalid_request'),
      });
  });
});
