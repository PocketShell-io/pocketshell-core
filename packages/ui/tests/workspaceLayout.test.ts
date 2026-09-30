import { describe, expect, it } from 'vitest';
import {
  NARROW_WORKSPACE_MAX_WIDTH,
  NARROW_WORKSPACE_QUERY,
  resolveWorkspaceLayout,
} from '../src/app/workspaceLayout';

describe('host workspace layout', () => {
  it('keeps the wide side-by-side layout whatever is open', () => {
    for (const hasFolder of [false, true]) {
      for (const panelRequested of [false, true]) {
        expect(resolveWorkspaceLayout({ narrow: false, hasFolder, panelRequested })).toBe('split');
      }
    }
  });

  it('shows one half at a time on a narrow screen', () => {
    expect(resolveWorkspaceLayout({ narrow: true, hasFolder: false, panelRequested: false })).toBe('panel');
    expect(resolveWorkspaceLayout({ narrow: true, hasFolder: true, panelRequested: false })).toBe('pane');
    expect(resolveWorkspaceLayout({ narrow: true, hasFolder: true, panelRequested: true })).toBe('panel');
  });

  it('names a phone-width breakpoint', () => {
    expect(NARROW_WORKSPACE_MAX_WIDTH).toBeGreaterThanOrEqual(412);
    expect(NARROW_WORKSPACE_QUERY).toBe(`(max-width: ${NARROW_WORKSPACE_MAX_WIDTH}px)`);
  });
});
