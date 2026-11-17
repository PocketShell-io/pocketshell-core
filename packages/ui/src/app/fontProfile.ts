/**
 * What a client says about its fonts: the stack its custom families fall back
 * through and which families Settings offers.
 *
 * Same shape as `provideApi`/`provideExtensions`: a module-level value a client
 * sets once at startup, with the desktop/web profile as the default. A phone
 * bundles exactly one monospace face and has no installed fonts to offer, so
 * its profile lists only that face and is not free text (#3138).
 */
import { BUNDLED_MONO_FAMILY, DEFAULT_MONO_STACK, MONOSPACE_FAMILIES } from '../fonts';

export interface FontProfile {
  /** The tail a chosen family is prepended to (fonts.ts `resolveMonoStack`). */
  fallbackStack: string;
  /** The families Settings offers. */
  families: readonly string[];
  /** Whether Settings also accepts any typed family name (desktop: yes; a phone: no). */
  freeText: boolean;
}

export const DEFAULT_FONT_PROFILE: FontProfile = {
  fallbackStack: DEFAULT_MONO_STACK,
  families: MONOSPACE_FAMILIES,
  freeText: true,
};

let profile: FontProfile = DEFAULT_FONT_PROFILE;

/** Set the client's font profile (once, at startup). Pass nothing to restore the default. */
export function provideFontProfile(next?: Partial<FontProfile>): void {
  profile = next ? { ...DEFAULT_FONT_PROFILE, ...next } : DEFAULT_FONT_PROFILE;
}

export function fontProfile(): FontProfile {
  return profile;
}

/** A phone profile: only what is bundled, so only that is offered. */
export function bundledOnlyFontProfile(fallbackStack: string): FontProfile {
  return { fallbackStack, families: [BUNDLED_MONO_FAMILY], freeText: false };
}
