/**
 * settings/page.js — 读取同目录的 page.html。
 */

import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

export function settingsPage() {
  return PAGE;
}
