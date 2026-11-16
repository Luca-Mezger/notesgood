// Light / dark appearance. Dark mode inverts paper and ink (and dims PDFs) but leaves pictures alone.
export type ThemeSetting = 'system' | 'light' | 'dark';
const KEY = 'margin.theme';
export const themeSetting = (): ThemeSetting => (localStorage.getItem(KEY) as ThemeSetting) || 'system';
export const setThemeSetting = (t: ThemeSetting) => localStorage.setItem(KEY, t);
const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
export function applyTheme() {
  const t = themeSetting();
  const dark = t === 'dark' || (t === 'system' && !!mq?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#15171b' : '#f6f7f9');
}
mq?.addEventListener?.('change', applyTheme);
