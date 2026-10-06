import { describe, expect, it } from 'vitest';
import { bashPathForm, windowsWorkspaceForm } from '../src/windowsPaths';

/**
 * The three spellings one Windows directory carries — aplexer's backslash
 * form, bash's MSYS form, the SFTP server's `/X:/` form — and the two forms
 * the app's boundaries convert to. POSIX paths must pass through untouched:
 * the drive letter is the only discriminator, and a colon cannot appear in a
 * POSIX path component.
 */
describe('bashPathForm', () => {
  it('folds the SFTP spelling to the drive form bash accepts', () => {
    expect(bashPathForm('/C:/Users/User/git')).toBe('C:/Users/User/git');
  });

  it('folds backslashes to forward slashes', () => {
    expect(bashPathForm('C:\\Users\\User\\git')).toBe('C:/Users/User/git');
  });

  it('keeps the MSYS and drive forms as they are', () => {
    expect(bashPathForm('/c/Users/User/git')).toBe('/c/Users/User/git');
    expect(bashPathForm('C:/Users/User/git')).toBe('C:/Users/User/git');
  });

  it('passes POSIX paths through unchanged', () => {
    expect(bashPathForm('/home/alexey/git/pocketshell')).toBe('/home/alexey/git/pocketshell');
    expect(bashPathForm('~/git/pocketshell')).toBe('~/git/pocketshell');
  });
});

describe('windowsWorkspaceForm', () => {
  it('answers the drive form for every Windows spelling', () => {
    expect(windowsWorkspaceForm('C:\\Users\\User\\git\\aplexer')).toBe('C:/Users/User/git/aplexer');
    expect(windowsWorkspaceForm('/C:/Users/User/git/aplexer')).toBe('C:/Users/User/git/aplexer');
    expect(windowsWorkspaceForm('/c/Users/User/git/aplexer')).toBe('C:/Users/User/git/aplexer');
    expect(windowsWorkspaceForm('C:/Users/User/git/aplexer')).toBe('C:/Users/User/git/aplexer');
  });

  it('upper-cases the drive letter so the spellings compare equal', () => {
    expect(windowsWorkspaceForm('c:/users/u')).toBe('C:/users/u');
  });

  it('passes POSIX workspaces through unchanged', () => {
    expect(windowsWorkspaceForm('/home/alexey/git/aplexer')).toBe('/home/alexey/git/aplexer');
  });
});
