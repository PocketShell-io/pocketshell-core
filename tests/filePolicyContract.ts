/**
 * The same pure file-policy assertions run in Chromium and in the Android
 * embed engines (Node vm and QuickJS). Keep assertions synchronous so the
 * verdict crosses each runtime boundary as a plain string.
 */
export function runFilePolicyContract(C: typeof import('../src/index')): string {
  let assertions = 0;
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    const got = JSON.stringify(actual);
    const want = JSON.stringify(expected);
    if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`);
    assertions += 1;
  };

  equal(C.normalizeRemotePath('/home/u//work/../notes'), '/home/u/notes', 'normalizes path');
  equal(C.normalizeRemotePath('/../../etc'), '/etc', 'clamps root traversal');
  equal(C.resolveRemotePath('./a/../b', '/home/u'), '/home/u/b', 'resolves relative dot segments');
  equal(C.resolveRemotePath('/tmp/a', '/home/u'), '/tmp/a', 'keeps absolute path anchored');
  equal(C.joinRemoteChildPath('/home/u', '../etc'), { ok: false, reason: 'separator' }, 'rejects child traversal');
  equal(C.joinRemoteChildPath('/home/u', 'literal%2fname'), { ok: true, path: '/home/u/literal%2fname' }, 'does not decode path spelling');
  equal(C.isRemotePathWithin('/home/u', '/home/user/x'), false, 'checks path boundary');
  equal(C.normalizeRemotePath('/tmp/caf\u00e9'), '/tmp/caf\u00e9', 'preserves composed Unicode path');
  equal(C.normalizeRemotePath('/tmp/cafe\u0301'), '/tmp/cafe\u0301', 'preserves decomposed Unicode path');
  equal(C.sanitizeFilename('../../../report (final).png').base, 'report_final', 'sanitizes filename');
  equal(C.sanitizeFilename('отчёт.png').base, 'отчёт', 'keeps Unicode filename');
  equal(C.sanitizeAttachmentScope('HOST/A:main'), 'host-a-main', 'sanitizes scope');
  equal(C.composeAttachmentFilename('20260923-123456', 1, C.sanitizeFilename('shot.png')),
    '20260923-123456-02-shot.png', 'composes staged filename');
  equal(C.classifyFileByName('/tmp/readme.md').kind, 'markdown', 'classifies markdown');
  equal(C.classifyFileBytes({ kind: 'unknown', mime: null }, new Uint8Array([0x68, 0x69])).kind,
    'text', 'sniffs unknown text');
  equal(C.sortFileEntries([
    { name: 'z', type: 'file' },
    { name: 'b', type: 'dir' },
    { name: 'a', type: 'dir' },
  ]).map(({ name }) => name), ['a', 'b', 'z'], 'orders entries');
  equal(C.evaluateFileEditSave(
    { isDirectory: false, sizeBytes: 4, modifiedEpochMs: 5 },
    { isDirectory: false, sizeBytes: 4, modifiedEpochMs: 5 },
  ), 'unchanged', 'accepts unchanged edit version');
  equal(C.evaluateFileEditSave(null, { isDirectory: false, sizeBytes: 4, modifiedEpochMs: 5 }),
    'unverifiable', 'fails closed without baseline');
  equal(C.DEFAULT_ATTACHMENT_RETENTION_POLICY, {
    ttlMillis: 7 * 24 * 60 * 60 * 1_000,
    keepNewest: 20,
    protectNewestMillis: 24 * 60 * 60 * 1_000,
  }, 'uses desktop retention defaults');
  equal(C.decideAttachmentStage([
    { kind: 'uploaded', attachment: 'a' },
    { kind: 'failed' },
  ]), { kind: 'partial', attachments: ['a'], failedCount: 1 }, 'retains partial staged success');
  equal(C.planAttachmentRetention([
    { name: 'recent', type: 'file', modifyTime: 9_999 },
    { name: 'expired', type: 'file', modifyTime: 1 },
    { name: 'dir', type: 'dir', modifyTime: 1 },
  ], 10_000, { ttlMillis: 5_000, keepNewest: 1, protectNewestMillis: 1_000 })
    .delete.map(({ name }) => name), ['expired'], 'prunes only eligible files');

  return `assertions=${assertions}`;
}
