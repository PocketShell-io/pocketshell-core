import type { VaultSlotPullResult, VaultSlotPushResult, VaultSlotTransport } from '../../src/index';

/**
 * An in-memory settings API with the server's semantics: versioned slots,
 * base version 0 creates, a stale base answers `conflict`, 8 KB limit.
 * `beforePush` lets a test land a concurrent write; `readOnly` mimics
 * Android's transport (push errors, delete/list unsupported).
 */
export class MemoryTransport implements VaultSlotTransport {
  readonly slots = new Map<string, { version: number; data: string }>();
  readonly writes: string[] = [];
  readOnly = false;
  beforePush: ((slot: string) => void) | null = null;

  async pull(slot: string): Promise<VaultSlotPullResult> {
    const stored = this.slots.get(slot);
    return stored ? { kind: 'ok', version: stored.version, data: stored.data } : { kind: 'absent' };
  }

  async push(slot: string, data: string, baseVersion: number): Promise<VaultSlotPushResult> {
    if (this.readOnly) return { kind: 'error', message: 'read-only transport' };
    const hook = this.beforePush;
    this.beforePush = null;
    hook?.(slot);
    if (new TextEncoder().encode(data).length > 8 * 1024) return { kind: 'error', message: 'slot over 8 KB' };
    const current = this.slots.get(slot)?.version ?? 0;
    if (baseVersion !== current) return { kind: 'conflict', currentVersion: current };
    this.slots.set(slot, { version: current + 1, data });
    this.writes.push(slot);
    return { kind: 'ok', version: current + 1 };
  }

  async delete(slot: string): Promise<void> {
    if (this.readOnly) throw new Error('read-only transport');
    this.slots.delete(slot);
    this.writes.push(`delete:${slot}`);
  }

  async list(): Promise<Array<{ slot: string; version: number }>> {
    if (this.readOnly) throw new Error('read-only transport');
    return [...this.slots].map(([slot, { version }]) => ({ slot, version }));
  }

  /** Overwrite a slot as another device would (bumps the version). */
  put(slot: string, data: string): void {
    const current = this.slots.get(slot)?.version ?? 0;
    this.slots.set(slot, { version: current + 1, data });
  }
}
