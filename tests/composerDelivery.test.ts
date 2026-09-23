import { describe, expect, it } from 'vitest';
import * as Core from '../src';
import { runComposerDeliveryContract } from './composerDeliveryContract';

describe('composer delivery contract', () => {
  it('preserves byte framing, ordered actions, and drafts after uncertain writes', async () => {
    await expect(runComposerDeliveryContract(Core)).resolves.toMatch(/^assertions=\d+$/);
  });
});
