import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef } from 'vue';
import { useLayoutClass } from './layoutClass';

/**
 * Whether the primary pointer is a finger (`pointer: coarse`). Independent of
 * width: a narrow desktop window with a mouse is compact but not coarse.
 */
export function useCoarsePointer(): ComputedRef<boolean> {
  const coarse = ref(false);
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const list = window.matchMedia('(pointer: coarse)');
    coarse.value = list.matches;
    const onChange = (event: MediaQueryListEvent): void => {
      coarse.value = event.matches;
    };
    list.addEventListener('change', onChange);
    if (getCurrentScope()) onScopeDispose(() => list.removeEventListener('change', onChange));
  }
  return computed(() => coarse.value);
}

/** Compact width: overlays are full-screen pages, the palette is a bottom sheet. */
export function useCompact(): ComputedRef<boolean> {
  const layout = useLayoutClass();
  return computed(() => layout.value === 'compact');
}

/**
 * A popup menu becomes a bottom sheet only for a finger on a compact screen;
 * a mouse keeps the click-point anchored menu at any width.
 */
export function usePopupSheet(): ComputedRef<boolean> {
  const compact = useCompact();
  const coarse = useCoarsePointer();
  return computed(() => compact.value && coarse.value);
}
