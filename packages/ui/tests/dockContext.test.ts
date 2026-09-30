import { describe, expect, it, vi } from 'vitest';
import { dockContextFor } from '@ui/app/dockContext';

describe('dockContextFor (terminal.dock context)', () => {
  it('is null unless a session tab with a pane identity is active', () => {
    const panes = new Map();
    expect(dockContextFor(false, 'id', 'main', panes)).toBeNull();
    expect(dockContextFor(true, null, 'main', panes)).toBeNull();
    expect(dockContextFor(true, 'id', null, panes)).toBeNull();
  });

  it('names the active pane and types into it through the pane found at send time', () => {
    const panes = new Map<string, { sendInput: (d: string) => void }>();
    const ctx = dockContextFor(true, 'ws/main', 'main', panes)!;
    expect(ctx).toMatchObject({ sessionKey: 'ws/main', sessionName: 'main' });
    // The pane mounts after the context was built; the send still reaches it.
    const sendInput = vi.fn();
    panes.set('ws/main', { sendInput });
    ctx.sendInput('\x1b[A');
    expect(sendInput).toHaveBeenCalledWith('\x1b[A');
  });

  it('drops input quietly when the pane is gone', () => {
    const ctx = dockContextFor(true, 'gone', 'gone', new Map())!;
    expect(() => ctx.sendInput('x')).not.toThrow();
  });
});
