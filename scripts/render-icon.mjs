// Render build/icon.svg -> build/icon.png (512px) for the dev-mode Dock icon (ADR-027).
// Electron's nativeImage cannot read SVG; the packaged app uses the SVG via electron-builder.
// Re-run (`pnpm icon`) after editing icon.svg.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8');
const size = 512;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size } });
await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
await page.locator('svg').screenshot({ path: join(buildDir, 'icon.png'), omitBackground: true });
await browser.close();
console.log(`wrote ${join(buildDir, 'icon.png')}`);
