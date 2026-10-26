import { readFileSync } from 'node:fs';

// Explicit pre-A1 mechanism fixture: keep dense reserves, 8 ladders and short bows.
export const LEGACY_LAYOUT = JSON.parse(readFileSync(new URL('./fixtures/siege-legacy-layout-f6ac8a6.json', import.meta.url)));
