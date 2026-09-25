/**
 * Where Electron's DEFAULT application menu survives — and with it the
 * window-role accelerators `src/shared/shortcuts.ts` lists as unsuppressible.
 *
 * Windows and Linux run with the menu nulled (`src/main/index.ts`), so those
 * accelerators do not exist there and the renderer may claim the keys. macOS
 * keeps the menu, because the OS expects one, and a cancelled renderer keydown
 * does not stop a *window* role — so a chord the menu holds must not also be
 * claimed here: the app command and the role would both run. That is the
 * stand-down `text.deleteWordBackward` has made since App.vue carried this
 * flag, and `tabs.rename` (Ctrl+Shift+R, the menu's Force Reload) makes it
 * second; both handlers read this one definition rather than carrying a copy.
 *
 * The probe is the renderer-shell one App.vue used first. The platform is
 * otherwise absent from the app tree, which stays browser-only by design;
 * this is the one fact about the host a chord needs that no browser API
 * spells more honestly.
 */
export const KEEPS_DEFAULT_MENU = navigator.userAgent.includes('Mac');
