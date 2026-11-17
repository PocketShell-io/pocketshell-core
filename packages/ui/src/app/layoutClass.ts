import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';

/**
 * The one width classification every shared view reads.
 *
 *   compact  <= 640      one pane at a time (a phone held upright)
 *   medium   641 - 900   room for a split with a collapsed panel
 *   expanded > 900       today's desktop layout, unchanged
 *
 * Width only: pointer type is independent and lives in the `--hit-min`
 * density tokens (tokens.css). CSS that needs only width keeps using media
 * queries with these same two numbers.
 */
export type LayoutClass = 'compact' | 'medium' | 'expanded';

export const LAYOUT_BREAKPOINTS = { compact: 640, medium: 900 } as const;

export const COMPACT_QUERY = `(max-width: ${LAYOUT_BREAKPOINTS.compact}px)`;
export const MEDIUM_QUERY = `(max-width: ${LAYOUT_BREAKPOINTS.medium}px)`;

export function resolveLayoutClass(input: { compact: boolean; medium: boolean }): LayoutClass {
  if (input.compact) return 'compact';
  if (input.medium) return 'medium';
  return 'expanded';
}

/** One matchMedia pair shared by every consumer, alive while any consumer is. */
interface Shared {
  compact: Ref<boolean>;
  medium: Ref<boolean>;
  consumers: number;
  detach: () => void;
}
let shared: Shared | null = null;

function attach(): Shared {
  const compact = ref(false);
  const medium = ref(false);
  const cleanups: Array<() => void> = [];
  // `matchMedia` is absent in some test DOMs; no query means expanded, which
  // is exactly what the desktop has always drawn.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const watch = (query: string, target: typeof compact): void => {
      const list = window.matchMedia(query);
      target.value = list.matches;
      const onChange = (event: MediaQueryListEvent): void => {
        target.value = event.matches;
      };
      list.addEventListener('change', onChange);
      cleanups.push(() => list.removeEventListener('change', onChange));
    };
    watch(COMPACT_QUERY, compact);
    watch(MEDIUM_QUERY, medium);
  }
  return { compact, medium, consumers: 0, detach: () => cleanups.forEach((fn) => fn()) };
}

export function useLayoutClass(): ComputedRef<LayoutClass> {
  const state = (shared ??= attach());
  state.consumers += 1;
  const release = (): void => {
    state.consumers -= 1;
    if (state.consumers === 0) {
      state.detach();
      if (shared === state) shared = null;
    }
  };
  // Outside an effect scope there is nobody to tell us when to let go; the
  // pair then simply stays attached, which costs two listeners.
  if (getCurrentScope()) onScopeDispose(release);
  else state.consumers += 1;
  return computed(() => resolveLayoutClass({ compact: state.compact.value, medium: state.medium.value }));
}
