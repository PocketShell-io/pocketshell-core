/**
 * Platform settings sections: the one extension point through which a host
 * shell adds settings the shared app cannot own.
 *
 * The shared Settings view renders every portable preference itself. Some
 * settings only exist on one platform — Android's dictation language and
 * recognizer silence window, its update-install handoff, its native crash
 * reporter — and must not become shared code, because they drive platform
 * APIs the other clients do not have. The shell registers a section here at
 * startup (before the app mounts); SettingsView renders the registered
 * sections as ordinary groups, in `order`, after the built-in ones.
 *
 * A section is a component plus metadata. It receives no props: it reads and
 * writes its own platform store, so the shared view never learns its shape.
 */
import { markRaw, shallowReactive, type Component } from 'vue';

export interface SettingsSection {
  /** Stable id; also the group's DOM id (`settings-section-<id>`). */
  id: string;
  /** Group heading, in the shared uppercase group-title style. */
  title: string;
  /** Ascending; sections with equal order keep registration order. */
  order?: number;
  component: Component;
}

const registered = shallowReactive<SettingsSection[]>([]);

/** The registered sections, sorted by `order`, for SettingsView to render. */
export function settingsSections(): readonly SettingsSection[] {
  return [...registered]
    .map((section, index) => ({ section, index }))
    .sort((left, right) => (left.section.order ?? 0) - (right.section.order ?? 0) || left.index - right.index)
    .map(({ section }) => section);
}

/**
 * Register (or replace, by id) one platform section. Returns an unregister
 * closure, for tests and hot reload.
 */
export function registerSettingsSection(section: SettingsSection): () => void {
  if (!/^[a-z0-9-]+$/.test(section.id)) throw new Error(`settings section id must be kebab-case: ${section.id}`);
  const entry: SettingsSection = { ...section, component: markRaw(section.component) };
  const existing = registered.findIndex((candidate) => candidate.id === section.id);
  if (existing >= 0) registered.splice(existing, 1, entry);
  else registered.push(entry);
  return () => {
    const index = registered.indexOf(entry);
    if (index >= 0) registered.splice(index, 1);
  };
}
