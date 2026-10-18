/**
 * Regenerates the screenshots the documentation embeds.
 *
 * The pictures in `images/` are the ones `README.md` and `docs/USER_GUIDE.md`
 * point at, so they have to keep their names: a rename silently breaks every
 * document that embeds them.
 *
 * The shots are taken from the standard project — "First Project",
 * `00000000-0000-0000-0000-000000000000` — which ships with the repository, so
 * the same run produces the same pictures on any machine rather than whatever
 * videos the person running it happens to have.
 *
 * Usage, with the stack already running (`docker compose up` or `./run.sh`):
 *
 *   cd frontend && node scripts/docs-screenshots.mjs
 *
 * BASE_URL overrides the frontend address (default http://localhost:5173).
 */
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const STANDARD_PROJECT = '00000000-0000-0000-0000-000000000000';
const OUT_DIR = process.env.OUT_DIR
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'images');

// Retina, so the pictures stay legible when a reader zooms a document.
const SCALE = 2;
const WIDTH = 1440;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: WIDTH, height: 900 },
  deviceScaleFactor: SCALE,
  // The app remembers the theme in a cookie; docs are written in the light one.
  colorScheme: 'light',
});
const page = await context.newPage();

await mkdir(OUT_DIR, { recursive: true });

async function go(path) {
  await page.goto(BASE_URL + path, { waitUntil: 'networkidle' });
  // The players draw their first frame after the metadata loads, which is after `networkidle` says the page is done.
  await page.waitForTimeout(1500);
}

/** Height of everything actually drawn, so a short page is not mostly margin. */
async function contentHeight(min = 420) {
  const bottom = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('main, header, [role="menu"], [data-panel]')]
      .map((el) => el.getBoundingClientRect().bottom + window.scrollY);
    return Math.max(0, ...rects);
  });
  return Math.max(min, Math.ceil(bottom) + 24);
}

async function shot(name, { height, full = false, locator } = {}) {
  const path = `${OUT_DIR}/${name}.png`;
  if (locator) {
    await locator.screenshot({ path });
  } else if (full) {
    await page.screenshot({ path, fullPage: true });
  } else {
    const h = height ?? (await contentHeight());
    await page.screenshot({ path, clip: { x: 0, y: 0, width: WIDTH, height: h } });
  }
  console.log('wrote', path);
}

/**
 * Covers a field whose value is a credential with a harmless placeholder.
 *
 * Drawn over the top rather than typed into the field: the settings page saves
 * as it is edited, so writing into it would push the placeholder to the
 * backend and destroy the real value.
 */
async function maskSecret(marker, text) {
  await page.evaluate(
    ([needle, replacement]) => {
      const field = [...document.querySelectorAll('textarea')]
        .find((el) => el.value.includes(needle));
      if (!field) return;
      const box = field.getBoundingClientRect();
      const cover = document.createElement('pre');
      cover.textContent = replacement;
      Object.assign(cover.style, {
        position: 'absolute',
        left: `${box.left + window.scrollX}px`,
        top: `${box.top + window.scrollY}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        margin: '0',
        padding: '8px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        font: window.getComputedStyle(field).font,
        background: window.getComputedStyle(field).backgroundColor,
        color: window.getComputedStyle(field).color,
        zIndex: '9999',
      });
      document.body.appendChild(cover);
    },
    [marker, text],
  );
}

// 1. Upload screen — where a new project starts.
await go('/');
await shot('upload_screen', { height: 420 });

// 2. Projects page — the dashboard of everything already uploaded.
await go('/history');
await shot('projects_page');

// 3. Project page — the clip grid, one card per highlight.
await go(`/project/${STANDARD_PROJECT}`);
await shot('project_details');

// 3b. One card on its own: every action a clip has, without opening its page.
await shot('clip_card', { locator: page.locator('.clip-card').first() });

// 4. The pipeline menu, with each step's state.
await page.getByRole('button', { name: 'Pipeline', exact: true }).click();
await page.waitForTimeout(500);
await shot('pipeline_menu', { height: 420 });
await page.keyboard.press('Escape');

// 5. Project settings: aspect ratio, resolution, and the captions and
//    description panels for the whole project.
await page.getByRole('button', { name: 'Project settings', exact: true }).click();
await page.waitForTimeout(500);
await shot('project_settings', { height: 420 });

// 5b. The description this project's clips are published with.
await page.getByRole('button', { name: /^Description/ }).first().click();
await page.waitForTimeout(800);
await shot('description_panel', { locator: page.getByRole('dialog') });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');

// 6. Clip page — player, the writing, the finished description, the actions.
await go(`/project/${STANDARD_PROJECT}/clip/0`);
await shot('clip_detail', { full: true });

// The three dialogs below scroll inside themselves, and an element screenshot
// only sees what is on screen. A tall window fits each one whole.
await page.setViewportSize({ width: WIDTH, height: 1400 });

// 7. Captions, with the fine-tuning open so the controls are visible.
await page.getByRole('button', { name: /^Captions/ }).first().click();
await page.waitForTimeout(800);
await page.evaluate(() => {
  document.querySelectorAll('details.caption-tuning').forEach((d) => { d.open = true; });
});
await page.waitForTimeout(500);
await shot('captions_panel', { locator: page.getByRole('dialog') });
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// 8. Overlay title — the text drawn over the opening seconds of the clip.
await page.getByRole('button', { name: 'Add overlay text' }).first().click();
await page.waitForTimeout(1200);
await shot('overlay_text', { locator: page.getByRole('dialog') });
await page.keyboard.press('Escape');
await page.setViewportSize({ width: WIDTH, height: 900 });

// 9. Settings. The OAuth client is covered before the shutter: a real one
//     lives in that box on a configured machine.
await go('/settings');
// A stored client is reported as invalid for the first moment after the page
// loads, before the debounced copy of the field catches up with it. Nothing to
// do with what the picture is showing, so it is left out of the picture.
await page.evaluate(() => {
  [...document.querySelectorAll('span')]
    .filter((el) => el.textContent?.trim() === 'Invalid JSON file content.')
    .forEach((el) => { el.style.visibility = 'hidden'; });
});
await maskSecret(
  'client_secret',
  '{\n  "installed": {\n    "client_id": "<your client id>.apps.googleusercontent.com",\n    "project_id": "<your google cloud project>",\n    "auth_uri": "https://accounts.google.com/o/oauth2/auth",\n    "token_uri": "https://oauth2.googleapis.com/token",\n    "client_secret": "<your client secret>"\n  }\n}',
);
await shot('settings_page', { full: true });

await browser.close();
