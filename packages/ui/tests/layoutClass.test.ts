// @vitest-environment jsdom
import { effectScope, nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_BREAKPOINTS, resolveLayoutClass, useLayoutClass } from '../src/app/layoutClass';
import { NARROW_WORKSPACE_MAX_WIDTH, NARROW_WORKSPACE_QUERY } from '../src/app/workspaceLayout';
import { useNarrowWorkspace } from '../src/app/useNarrowWorkspace';
import { computed, ref } from 'vue';

/** A matchMedia whose answers follow `width`, with live change events. */
function installMatchMedia(initialWidth: number) {
  let width = initialWidth;
  const lists: Array<{ max: number; matches: boolean; listeners: Set<(e: MediaQueryListEvent) => void> }> = [];
  const matchMedia = vi.fn((query: string) => {
    const max = Number(/max-width:\s*(\d+)px/.exec(query)?.[1]);
    const list = { max, matches: width <= max, listeners: new Set<(e: MediaQueryListEvent) => void>() };
    lists.push(list);
    return {
      get matches() {
        return list.matches;
      },
      media: query,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => list.listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => list.listeners.delete(fn),
    };
  });
  vi.stubGlobal('matchMedia', matchMedia);
  Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
  return {
    matchMedia,
    lists,
    resize(next: number) {
      width = next;
      for (const list of lists) {
        const matches = width <= list.max;
        if (matches === list.matches) continue;
        list.matches = matches;
        for (const fn of list.listeners) fn({ matches } as MediaQueryListEvent);
      }
    },
    listenerCount: () => lists.reduce((n, l) => n + l.listeners.size, 0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('LAYOUT_BREAKPOINTS', () => {
  it('keeps today\'s 640 and adds 900', () => {
    expect(LAYOUT_BREAKPOINTS).toEqual({ compact: 640, medium: 900 });
    expect(NARROW_WORKSPACE_MAX_WIDTH).toBe(640);
    expect(NARROW_WORKSPACE_QUERY).toBe('(max-width: 640px)');
  });

  it('resolves the three classes at and around the edges', () => {
    const at = (w: number) =>
      resolveLayoutClass({ compact: w <= LAYOUT_BREAKPOINTS.compact, medium: w <= LAYOUT_BREAKPOINTS.medium });
    expect([360, 412, 640].map(at)).toEqual(['compact', 'compact', 'compact']);
    expect([641, 800, 900].map(at)).toEqual(['medium', 'medium', 'medium']);
    expect([901, 1280].map(at)).toEqual(['expanded', 'expanded']);
  });
});

describe('useLayoutClass', () => {
  it('reports compact, medium and expanded from the viewport and follows resizes', async () => {
    const env = installMatchMedia(412);
    const scope = effectScope();
    const cls = scope.run(() => useLayoutClass())!;
    expect(cls.value).toBe('compact');
    env.resize(700);
    await nextTick();
    expect(cls.value).toBe('medium');
    env.resize(1200);
    await nextTick();
    expect(cls.value).toBe('expanded');
    env.resize(640);
    await nextTick();
    expect(cls.value).toBe('compact');
    scope.stop();
  });

  it('is expanded when matchMedia does not exist', () => {
    expect(typeof window.matchMedia).not.toBe('function');
    const scope = effectScope();
    const cls = scope.run(() => useLayoutClass())!;
    expect(cls.value).toBe('expanded');
    scope.stop();
  });

  it('shares one matchMedia pair across consumers and detaches with the last', () => {
    const env = installMatchMedia(1000);
    const a = effectScope();
    const b = effectScope();
    a.run(() => useLayoutClass());
    b.run(() => useLayoutClass());
    expect(env.matchMedia).toHaveBeenCalledTimes(2); // one pair, not one per consumer
    expect(env.listenerCount()).toBe(2);
    a.stop();
    expect(env.listenerCount()).toBe(2);
    b.stop();
    expect(env.listenerCount()).toBe(0);
  });
});

describe('useNarrowWorkspace as a layout-class consumer', () => {
  it('is narrow only in the compact class', async () => {
    const env = installMatchMedia(800); // medium: still the split layout
    const activeFolder = computed<string | null>(() => '/work');
    const scope = effectScope();
    const ws = scope.run(() => useNarrowWorkspace({ activeFolder, panelCollapsed: ref(false) }))!;
    expect(ws.layout.value).toBe('split');
    env.resize(400);
    await nextTick();
    expect(ws.layout.value).toBe('pane');
    env.resize(1000);
    await nextTick();
    expect(ws.layout.value).toBe('split');
    scope.stop();
  });

  it('keeps the wide layout when matchMedia is absent', () => {
    const scope = effectScope();
    const ws = scope.run(() =>
      useNarrowWorkspace({ activeFolder: computed(() => null), panelCollapsed: ref(false) }),
    )!;
    expect(ws.layout.value).toBe('split');
    scope.stop();
  });
});
