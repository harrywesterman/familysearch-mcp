#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const configPath = join(homedir(), '.familysearch-mcp', 'config.json');
const BROWSER_PATHS = {
  darwin: [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  ],
};

function findBrowserExecutable() {
  const configuredPath = process.env.FAMILYSEARCH_BROWSER_PATH || process.env.BRAVE_PATH;
  if (configuredPath && existsSync(configuredPath)) return configuredPath;
  return (BROWSER_PATHS[platform()] || []).find(existsSync) || null;
}

function loadCookies() {
  if (!existsSync(configPath)) throw new Error('FamilySearch session config not found. Run login-with-browser first.');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const cookies = String(config.cookies || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return { name: part.slice(0, separator), value: part.slice(separator + 1), domain: '.familysearch.org', path: '/' };
  }).filter((cookie) => cookie.name && cookie.value);
  if (!cookies.length) throw new Error('No FamilySearch cookies found. Run login-with-browser first.');
  return cookies;
}

function normalizeDgs(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits || digits.length > 9) throw new Error('DGS must contain at most 9 digits.');
  return digits.padStart(9, '0');
}

function parseImageId(value) {
  return String(value || '').match(/3:1:[A-Z0-9-]+/i)?.[0] || '';
}

async function main() {
  const options = JSON.parse(process.argv[2] || '{}');
  const dgs = normalizeDgs(options.dgs);
  const startImage = Math.max(1, Math.trunc(options.startImage || 1));
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit || 20)));
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('No supported Brave, Chrome, or Chromium browser found.');

  const browser = await chromium.launch({ executablePath, headless: false, ignoreDefaultArgs: ['--enable-automation'], args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const context = await browser.newContext({ viewport: null });
    await context.addCookies(loadCookies());
    const page = await context.newPage();
    const filmDataPromise = page.waitForResponse(
      (response) => response.url().endsWith('/search/filmdatainfo/film-data') && response.status() === 200,
      { timeout: 90_000 },
    );
    const filmUrl = `https://www.familysearch.org/en/search/film/${dgs}?lang=en&i=0`;
    await page.goto(filmUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    if (page.url().includes('/auth/familysearch/login')) throw new Error('FamilySearch session expired. Run login-with-browser again.');
    const filmData = await (await filmDataPromise).json();
    const allImages = Array.isArray(filmData.images) ? filmData.images : [];
    const entries = allImages.slice(startImage - 1, startImage - 1 + limit).map((deepZoomUrl, offset) => {
      const imageId = parseImageId(deepZoomUrl);
      const imageNumber = startImage + offset;
      return {
        imageNumber,
        imageId,
        arkUrl: `https://www.familysearch.org/ark:/61903/${imageId}?i=${imageNumber - 1}`,
        thumbnailUrl: `https://www.familysearch.org/service/records/storage/deepzoomcloud/dz/v1/${imageId}/thumb_p200.jpg`,
      };
    }).filter((entry) => entry.imageId);
    process.stdout.write(JSON.stringify({ dgs, total: allImages.length, startImage, filmUrl, entries }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
