import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, initialTheme, otherTheme, parseTheme } from '../client/src/theme';

describe('theme choice', () => {
  it('defaults to light', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(initialTheme(null, null)).toBe('light');
  });

  it('remembers a stored choice', () => {
    expect(initialTheme('dark', null)).toBe('dark');
    expect(initialTheme('light', null)).toBe('light');
  });

  it('lets ?theme= win over the stored choice', () => {
    expect(initialTheme('light', 'dark')).toBe('dark');
    expect(initialTheme('dark', 'light')).toBe('light');
  });

  it('ignores junk in either place', () => {
    expect(initialTheme('sepia', null)).toBe('light');
    expect(initialTheme('dark', 'sepia')).toBe('dark');
    expect(parseTheme('')).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
  });

  it('toggles', () => {
    expect(otherTheme('light')).toBe('dark');
    expect(otherTheme('dark')).toBe('light');
  });
});
