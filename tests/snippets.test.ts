import { describe, expect, it } from 'vitest';
import {
  commandTemplateInsertion,
  commandTemplatesForHost,
  orderedItemsForHost,
  parseLegacyCommandTemplates,
  parseLegacySnippets,
  reorderHostItems,
  snippetInsertion,
  snippetsForHost,
  type HostCommandTemplate,
  type HostSnippet,
} from '../src/snippets';

describe('legacy snippet parsing', () => {
  it('keeps durable host IDs, nullable labels, literal multiline bodies, and source order', () => {
    const result = parseLegacySnippets(
      [
        { id: 8, hostId: 41, label: null, body: 'first\nsecond', kind: 'command' },
        { id: 3, hostId: 7, label: '  keep spaces  ', body: 'echo ok', kind: 'future-kind' },
      ],
      [41, 7],
    );

    expect(result).toEqual({
      kind: 'ok',
      snippets: [
        {
          id: '8',
          hostId: '41',
          label: null,
          body: 'first\nsecond',
          kind: 'command',
          sortOrder: 0,
        },
        {
          id: '3',
          hostId: '7',
          label: '  keep spaces  ',
          body: 'echo ok',
          kind: 'future-kind',
          sortOrder: 1,
        },
      ],
    });
  });

  it('rejects malformed data as a whole and reports the row that failed', () => {
    expect(parseLegacySnippets('not rows', [41])).toEqual({
      kind: 'invalid',
      reason: 'invalid-shape',
    });
    expect(
      parseLegacySnippets(
        [
          { id: 1, hostId: 41, label: 'ok', body: 'preserve this', kind: 'command' },
          { id: 2, hostId: 99, label: 'wrong host', body: 'echo no', kind: 'command' },
        ],
        [41],
      ),
    ).toEqual({ kind: 'invalid', reason: 'unknown-host-id', index: 1 });
    expect(
      parseLegacySnippets(
        [
          { id: 1, hostId: 41, label: null, body: 'first', kind: 'command' },
          { id: 2, hostId: 41, label: null, body: 4, kind: 'command' },
        ],
        [41],
      ),
    ).toEqual({ kind: 'invalid', reason: 'invalid-body', index: 1 });
  });

  it('rejects duplicate or unsafe Room IDs rather than creating ambiguous identities', () => {
    expect(
      parseLegacySnippets(
        [
          { id: 5, hostId: 41, label: 'one', body: '1', kind: 'command' },
          { id: 5, hostId: 41, label: 'two', body: '2', kind: 'command' },
        ],
        [41],
      ),
    ).toEqual({ kind: 'invalid', reason: 'duplicate-id', index: 1 });
    expect(
      parseLegacySnippets(
        [{ id: Number.MAX_SAFE_INTEGER + 1, hostId: 41, label: null, body: '', kind: '' }],
        [41],
      ),
    ).toEqual({ kind: 'invalid', reason: 'invalid-id', index: 0 });
  });

  it('keeps command-template text and order without normalizing it', () => {
    const commands = 'cd ~/project\nmake test\n';
    const result = parseLegacyCommandTemplates(
      [
        { id: 14, hostId: 41, label: 'Build', commands },
        { id: 11, hostId: 41, label: '', commands: 'git status' },
      ],
      [41],
    );

    expect(result).toEqual({
      kind: 'ok',
      templates: [
        { id: '14', hostId: '41', label: 'Build', commands, sortOrder: 0 },
        { id: '11', hostId: '41', label: '', commands: 'git status', sortOrder: 1 },
      ],
    });
    expect(
      parseLegacyCommandTemplates(
        [{ id: 14, hostId: 99, label: 'Build', commands }],
        [41],
      ),
    ).toEqual({ kind: 'invalid', reason: 'unknown-host-id', index: 0 });
  });
});

describe('per-host snippet policy', () => {
  const snippets: HostSnippet[] = [
    { id: 'b', hostId: 'host-b', label: 'b', body: 'B', kind: 'command', sortOrder: 1 },
    { id: 'a2', hostId: 'host-a', label: 'second tie', body: 'A2', kind: 'command', sortOrder: 2 },
    { id: 'a1', hostId: 'host-a', label: 'first tie', body: 'A1', kind: 'command', sortOrder: 2 },
    { id: 'a0', hostId: 'host-a', label: 'first', body: 'A0', kind: 'command', sortOrder: 0 },
  ];

  it('filters by exact durable host ID and sorts stably without mutating input', () => {
    const before = [...snippets];
    expect(snippetsForHost(snippets, 'host-a').map(({ id }) => id)).toEqual(['a0', 'a2', 'a1']);
    expect(snippetsForHost(snippets, 'host-b').map(({ id }) => id)).toEqual(['b']);
    expect(snippetsForHost(snippets, 'host')).toEqual([]);
    expect(snippetsForHost(snippets, '   ')).toEqual([]);
    expect(snippets).toEqual(before);
  });

  it('reorders exactly one host and refuses incomplete or duplicate reorder requests', () => {
    const result = reorderHostItems(snippets, 'host-a', ['a1', 'a0', 'a2']);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected a valid reorder');
    expect(snippetsForHost(result.items, 'host-a').map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
      ['a1', 0],
      ['a0', 1],
      ['a2', 2],
    ]);
    expect(result.items.find(({ id }) => id === 'b')).toBe(snippets[0]);
    const originalHostB = snippets[0];
    if (originalHostB === undefined) throw new Error('expected a host-b snippet fixture');
    expect(originalHostB.sortOrder).toBe(1);

    expect(reorderHostItems(snippets, 'host-a', ['a0', 'a2'])).toEqual({
      kind: 'invalid',
      reason: 'invalid-order',
    });
    expect(reorderHostItems(snippets, 'host-a', ['a0', 'a0', 'a2'])).toEqual({
      kind: 'invalid',
      reason: 'invalid-order',
    });
    expect(reorderHostItems(snippets, '', ['a0', 'a2', 'a1'])).toEqual({
      kind: 'invalid',
      reason: 'invalid-host-id',
    });
  });

  it('returns exact multiline text as draft insertion and never submits it', () => {
    const snippet = snippets[1];
    if (snippet === undefined) throw new Error('expected a snippet fixture');
    expect(snippetInsertion(snippet)).toEqual({
      kind: 'insert-literal',
      text: 'A2',
      submit: false,
    });
    expect(
      snippetInsertion({ body: ' leading\nsecond line\n' }),
    ).toEqual({ kind: 'insert-literal', text: ' leading\nsecond line\n', submit: false });
    expect(
      commandTemplateInsertion({ commands: 'echo one\necho two' }),
    ).toEqual({ kind: 'insert-literal', text: 'echo one\necho two', submit: false });
  });
});

describe('command-template lookup', () => {
  const templates: HostCommandTemplate[] = [
    { id: '2', hostId: 'host-b', label: 'other', commands: 'echo b', sortOrder: 0 },
    { id: '1', hostId: 'host-a', label: 'first', commands: 'echo a', sortOrder: 0 },
  ];

  it('uses host identity and shares the same stable ordering policy', () => {
    expect(commandTemplatesForHost(templates, 'host-a')).toEqual([templates[1]]);
    expect(orderedItemsForHost(templates, 'host-b')).toEqual([templates[0]]);
    expect(commandTemplatesForHost(templates, 'missing')).toEqual([]);
  });
});
