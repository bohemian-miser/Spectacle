/** The light/dark switch. Lives in the lobby header and in the arena HUD. */

import { otherTheme, useTheme } from './theme';

export interface ThemeToggleProps {
  /** Extra classes (the lobby wants no label on narrow screens). */
  readonly className?: string;
}

export function ThemeToggle({ className = '' }: ThemeToggleProps): JSX.Element {
  const [theme, setTheme] = useTheme();
  const next = otherTheme(theme);
  return (
    <button
      type="button"
      className={`btn theme-toggle ${className}`.trim()}
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      onClick={() => setTheme(next)}
    >
      <span className="theme-glyph" aria-hidden="true">
        {theme === 'dark' ? '☀' : '☾'}
      </span>
      {next === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}
