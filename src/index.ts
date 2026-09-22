/**
 * @pocketshell/core — the PocketShell contract layer, one implementation for
 * every client.
 *
 * Each module here is a VERBATIM copy of the code that used to live in
 * pocketshell-desktop's src/shared/ and was re-copied into pocketshell-web by
 * scripts/sync-shared.sh. The package is now the source of truth; the desktop
 * and web apps import it and no app holds a copy. Every module is pure
 * TypeScript — no Node, no DOM, no I/O — so the same build runs in the
 * Electron main process, the browser, and an embedded JS engine (the Android
 * path; see embed/ and README.md).
 */

export * from './types';
export * from './net';
export * from './byteSize';
export * from './shellQuote';
export * from './userBinPath';
export * from './sync';
export * from './syncConfig';
export * from './syncMerge';
export * from './sshConfigCore';
export * from './knownHostsCore';
export * from './osc52';
export * from './sftpCore';
export * from './aplexer';
export * from './aplexerCommands';
export * from './aplexerParsers';
export * from './aplexerClientCore';
export * from './agentCommands';
export * from './agentLaunch';
export * from './composerSend';
