#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { basename, extname, join, resolve } from 'path';

const configPath = join(homedir(), '.familysearch-mcp', 'config.json');

const BROWSER_PATHS = {
  darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  ],
};

const FORMAT_OPTIONS = {
  jpg: { label: 'JPG Only', extension: '.jpg' },
  'pdf-highlights': { label: 'PDF Record Image with Highlights', extension: '.pdf' },
  'pdf-no-highlights': { label: 'PDF Record Image with No Highlights', extension: '.pdf' },
};

function findBrowserExecutable() {
  if (process.env.BRAVE_PATH && existsSync(process.env.BRAVE_PATH)) return process.env.BRAVE_PATH;
  return (BROWSER_PATHS[platform()] || []).find(existsSync) || null;
}

function parseImageId(value) {
  const match = String(value || '').match(/3:1:[A-Z0-9-]+/i);
  if (!match) throw new Error('Expected a FamilySearch image ID such as 3:1:3QHK-93G5-35Q3 or an ARK URL containing one.');
  return match[0];
}

function loadCookies() {
  if (!existsSync(configPath)) throw new Error('FamilySearch session config not found. Run login-with-browser first.');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const cookies = String(config.cookies || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      return {
        name: part.slice(0, separator),
        value: part.slice(separator + 1),
        domain: '.familysearch.org',
        path: '/',
      };
    })
    .filter((cookie) => cookie.name && cookie.value);
  if (!cookies.length) throw new Error('No FamilySearch cookies found. Run login-with-browser first.');
  return cookies;
}

function safeFileName(value, imageId, extension) {
  const requested = basename(String(value || '')).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const base = requested || `familysearch-${imageId.replace(/:/g, '-')}`;
  return `${base.replace(/\.(jpg|jpeg|pdf)$/i, '')}${extension}`;
}

function availablePath(directory, fileName) {
  const extension = extname(fileName);
  const stem = fileName.slice(0, -extension.length);
  let candidate = join(directory, fileName);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stem}-${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

async function main() {
  const options = JSON.parse(process.argv[2] || '{}');
  const imageId = parseImageId(options.imageId || options.arkUrl);
  const format = FORMAT_OPTIONS[options.format || 'jpg'];
  if (!format) throw new Error(`Unsupported format: ${options.format}`);

  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('No supported Brave, Chromium, or Chrome browser found.');

  const outputDirectory = resolve(options.outputDirectory || join(homedir(), 'Downloads', 'familysearch-mcp'));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const outputPath = availablePath(outputDirectory, safeFileName(options.fileName, imageId, format.extension));

  const browser = await chromium.launch({
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({ viewport: null, acceptDownloads: true });
    await context.addCookies(loadCookies());
    const page = await context.newPage();
    const viewerUrl = `https://www.familysearch.org/ark:/61903/${imageId}?view=fullText&lang=en`;
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const downloadButton = page.getByRole('button', { name: /^download$/i }).first();
    await downloadButton.waitFor({ state: 'visible', timeout: 90_000 });
    await downloadButton.click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Customize your download option' });
    await dialog.waitFor({ state: 'visible', timeout: 30_000 });
    await dialog.getByLabel(format.label, { exact: true }).check();

    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await dialog.getByRole('button', { name: /^download$/i }).click();
    const download = await downloadPromise;
    await download.saveAs(outputPath);
    const failure = await download.failure();
    if (failure) throw new Error(`FamilySearch download failed: ${failure}`);

    const stats = statSync(outputPath);
    process.stdout.write(JSON.stringify({
      imageId,
      format: options.format || 'jpg',
      outputPath,
      bytes: stats.size,
      viewerUrl,
      highResolution: (options.format || 'jpg') === 'jpg',
    }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
