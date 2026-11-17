// Which multi-session projects the narrow session tree has collapsed (#3145).
// Persisted per project key in localStorage so the arrangement survives the
// tree's refresh timer and an app restart; the rows view stays store-free and
// just calls this. A project is OPEN unless it is listed.
import { ref, type Ref } from 'vue';

export const COLLAPSED_STORAGE_KEY = 'ps.sessionTree.collapsed';

function load(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function useCollapsedGroups(): {
  collapsed: Ref<string[]>;
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
} {
  const collapsed = ref<string[]>(load());
  return {
    collapsed,
    isCollapsed: (key) => collapsed.value.includes(key),
    toggle(key) {
      collapsed.value = collapsed.value.includes(key)
        ? collapsed.value.filter((k) => k !== key)
        : [...collapsed.value, key];
      try {
        globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsed.value));
      } catch {
        /* storage unavailable: the toggle still works for this session */
      }
    },
  };
}
