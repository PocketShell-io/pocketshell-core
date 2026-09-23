import { describe, expect, it } from 'vitest';
import {
  expandRemoteHome,
  isHomeRelativeRemotePath,
  isRemotePathWithin,
  joinRemoteChildPath,
  normalizeRemotePath,
  parentRemotePath,
  remotePathName,
  resolveRemotePath,
} from '../src/remotePathPolicy';

describe('remote path normalization', () => {
  it('folds separators and dot segments and clamps above root', () => {
    expect(normalizeRemotePath('home//alexey/./git/../notes.md')).toBe('/home/alexey/notes.md');
    expect(normalizeRemotePath('/../../etc/passwd')).toBe('/etc/passwd');
    expect(normalizeRemotePath('/..')).toBe('/');
    expect(normalizeRemotePath('')).toBe('/');
    expect(normalizeRemotePath('safe\0/../etc')).toBeNull();
  });

  it('resolves absolute, relative and home-relative paths', () => {
    expect(resolveRemotePath('/tmp/a', '/home/u/x')).toBe('/tmp/a');
    expect(resolveRemotePath('../a', '/home/u/x')).toBe('/home/u/a');
    expect(resolveRemotePath('./a/../b', '/home/u')).toBe('/home/u/b');
    expect(resolveRemotePath('/../../etc/passwd', '/home/u')).toBe('/etc/passwd');
    expect(resolveRemotePath('~/a', '/tmp', '/home/u')).toBe('/home/u/a');
    expect(resolveRemotePath('$HOME/a', null, '/home/u')).toBe('/home/u/a');
    expect(resolveRemotePath('~/a')).toBeNull();
    expect(resolveRemotePath('~other/a', '/home/u')).toBeNull();
    expect(resolveRemotePath('a\0b', '/home/u')).toBeNull();
  });

  it('expands only recognized home prefixes', () => {
    expect(isHomeRelativeRemotePath('~')).toBe(true);
    expect(isHomeRelativeRemotePath('$HOME/docs')).toBe(true);
    expect(isHomeRelativeRemotePath('~other/docs')).toBe(false);
    expect(expandRemoteHome('~', '/home/u/')).toBe('/home/u');
    expect(expandRemoteHome('~/docs', null)).toBeNull();
    expect(expandRemoteHome('/tmp', null)).toBe('/tmp');
    expect(expandRemoteHome('/tmp\0/file', null)).toBeNull();
  });

  it('joins only a single safe child name', () => {
    expect(joinRemoteChildPath('/home/u/', 'note.txt')).toEqual({
      ok: true,
      path: '/home/u/note.txt',
    });
    expect(joinRemoteChildPath('/', 'a\\b')).toEqual({ ok: true, path: '/a\\b' });
    expect(joinRemoteChildPath('/home/u', 'literal%2fname'))
      .toEqual({ ok: true, path: '/home/u/literal%2fname' });
    expect(joinRemoteChildPath('/home/u', '../etc')).toEqual({ ok: false, reason: 'separator' });
    expect(joinRemoteChildPath('/home/u', '.')).toEqual({ ok: false, reason: 'dot-segment' });
    expect(joinRemoteChildPath('/home/u', '..')).toEqual({ ok: false, reason: 'dot-segment' });
    expect(joinRemoteChildPath('/home/u', '')).toEqual({ ok: false, reason: 'empty-name' });
    expect(joinRemoteChildPath('/home/u', 'x\0y')).toEqual({ ok: false, reason: 'nul' });
    expect(joinRemoteChildPath('/bad\0path', 'x')).toEqual({ ok: false, reason: 'invalid-directory' });
  });

  it('checks path-component containment rather than string prefixes', () => {
    expect(isRemotePathWithin('/home/u', '/home/u')).toBe(true);
    expect(isRemotePathWithin('/home/u', '/home/u/file')).toBe(true);
    expect(isRemotePathWithin('/home/u', '/home/user/file')).toBe(false);
    expect(isRemotePathWithin('/home/u', '/home/u/../other')).toBe(false);
    expect(isRemotePathWithin('/', '/etc/passwd')).toBe(true);
    expect(isRemotePathWithin('/home/u', '/home/u\0/file')).toBe(false);
  });

  it('returns parent and final component after normalization', () => {
    expect(parentRemotePath('/home/u/notes/../a.txt')).toBe('/home/u');
    expect(parentRemotePath('/')).toBe('/');
    expect(remotePathName('/home/u/notes.txt')).toBe('notes.txt');
    expect(remotePathName('/')).toBe('/');
    expect(parentRemotePath('/bad\0path')).toBeNull();
  });

  it('preserves the remote host’s exact Unicode path spelling', () => {
    const composed = '/tmp/caf\u00e9';
    const decomposed = '/tmp/cafe\u0301';
    expect(normalizeRemotePath(composed)).toBe(composed);
    expect(normalizeRemotePath(decomposed)).toBe(decomposed);
    expect(normalizeRemotePath(composed)).not.toBe(normalizeRemotePath(decomposed));
  });
});
