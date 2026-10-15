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

declare function btoa(data: string): string;

declare const TextDecoder: {
  new (
    label?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ): {
    decode(input?: Uint8Array, options?: { stream?: boolean }): string;
  };
};

declare const TextEncoder: {
  new (): {
    encode(input?: string): Uint8Array;
  };
};

/** Minimal browser WebSocket surface (browsers, Electron, Node 18+, WebView). */
declare const WebSocket: {
  new (url: string | URL): {
    binaryType: string;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code: number; reason: string }) => void) | null;
    onerror: (() => void) | null;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
  };
};

/**
 * WebCrypto, the slice the key vault uses (browsers in secure contexts,
 * Electron, Node 19+, the Android WebView). Key handles stay opaque.
 */
interface CoreCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
}

interface CoreSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: Uint8Array | Record<string, unknown>,
    algorithm: string | Record<string, unknown>,
    extractable: boolean,
    keyUsages: string[],
  ): Promise<CoreCryptoKey>;
  exportKey(format: string, key: CoreCryptoKey): Promise<ArrayBuffer | Record<string, unknown>>;
  deriveBits(algorithm: Record<string, unknown>, baseKey: CoreCryptoKey, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: Record<string, unknown>, key: CoreCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: Record<string, unknown>, key: CoreCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
}

declare const crypto: {
  readonly subtle?: CoreSubtleCrypto;
  getRandomValues<T extends Uint8Array>(array: T): T;
};
