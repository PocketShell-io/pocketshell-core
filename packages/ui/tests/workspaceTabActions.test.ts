import { effectScope } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '@pocketshell/core/shared/workspaceTabs';
import {
  registerTabActions,
  tabActionRowsFor,
  unregisterTabActions,
  useActiveTabActions,
} from '../src/app/workspaceTabActions';

const session = { kind: 'session', id: 's:main', session: 'main', label: 'main' } as WorkspaceTab;
const files = { kind: 'files', id: 'files-1', label: 'Files' } as WorkspaceTab;
const tool = { kind: 'tool', id: 'tool-htop', label: 'htop' } as WorkspaceTab;

function handlers() {
  return {
    rename: vi.fn(),
    stop: vi.fn(),
    closeFiles: vi.fn(),
    closeTool: vi.fn(),
  };
}

describe('tabActionRowsFor', () => {
  it('a session tab offers Rename and a danger `Stop this session` that only arms the stop', () => {
    const h = handlers();
    const rows = tabActionRowsFor(session, h);
    expect(rows.map((r) => [r.id, r.label, r.danger ?? false])).toEqual([
      ['rename', 'Rename session…', false],
      ['stop', 'Stop this session', true],
    ]);
    rows[1]!.run();
    expect(h.stop).toHaveBeenCalledWith('main');
    rows[0]!.run();
    expect(h.rename).toHaveBeenCalledWith(session);
    expect(h.closeFiles).not.toHaveBeenCalled();
  });

  it('a Files tab and a tool tab offer their own close, nothing destructive', () => {
    const h = handlers();
    const [files1] = tabActionRowsFor(files, h);
    const [tool1] = tabActionRowsFor(tool, h);
    expect(files1).toMatchObject({ id: 'close', label: 'Close this Files tab' });
    expect(tool1).toMatchObject({ id: 'close', label: 'Close this tool' });
    files1!.run();
    tool1!.run();
    expect(h.closeFiles).toHaveBeenCalledWith('files-1');
    expect(h.closeTool).toHaveBeenCalledWith(tool);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('no tab, no rows', () => {
    expect(tabActionRowsFor(null, handlers())).toEqual([]);
  });
});

describe('the tab-actions slot', () => {
  it('follows the registered workspace and ignores a stale unregister', () => {
    const scope = effectScope();
    const rows = scope.run(() => useActiveTabActions())!;
    expect(rows.value).toEqual([]);
    const a = () => tabActionRowsFor(session, handlers());
    const b = () => tabActionRowsFor(files, handlers());
    registerTabActions(a);
    expect(rows.value.map((r) => r.id)).toEqual(['rename', 'stop']);
    registerTabActions(b);
    unregisterTabActions(a); // a stale workspace going away must not clear b
    expect(rows.value.map((r) => r.id)).toEqual(['close']);
    unregisterTabActions(b);
    expect(rows.value).toEqual([]);
    scope.stop();
  });
});
