'use client';
// Light / dark / system theme (prototype: prefers-color-scheme + data-theme override). Stored per browser.
import { useEffect, useState } from 'react';
import { Icon } from './Icon';

type Theme = 'system' | 'light' | 'dark';
export const THEME_KEY = '11e.theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

/** Runs before first paint (root layout) so the page never flashes the wrong theme. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') setTheme(t);
    } catch {
      /* storage disabled */
    }
  }, []);
  const next = () => {
    const t = NEXT[theme];
    setTheme(t);
    apply(t);
    try {
      if (t === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      /* storage disabled */
    }
  };
  return (
    <button
      type="button"
      className="ibtn"
      onClick={next}
      aria-label={`${LABEL[theme]}. Change theme`}
      title={LABEL[theme]}
    >
      <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'sun'} />
    </button>
  );
}
