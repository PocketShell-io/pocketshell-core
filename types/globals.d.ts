/**
 * The platform surface @pocketshell/core relies on — the intersection every
 * client already provides: browsers, Electron main and renderer, Node 16+,
 * and modern embedded JS engines (the Android embed path). Declared here, in
 * the package's own typecheck only, so the sources neither borrow the DOM lib
 * nor node's — either would lie about where the code can run. Nothing here is
 * shipped or re-exported.
 */

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): number;

declare function clearTimeout(id: number | undefined): void;

declare function atob(data: string): string;

declare const TextDecoder: {
  new (
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ): {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  };
};
