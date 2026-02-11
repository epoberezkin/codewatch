import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.join(__dirname, '..', 'screenshots');

const pages = [
  { file: 'gate.html', screenshots: [{ name: 'gate.png' }] },
  { file: 'home.html', screenshots: [{ name: 'home-step2.png' }] },
  { file: 'estimate.html', screenshots: [{ name: 'estimate-overview.png' }] },
  { file: 'audit.html', screenshots: [{ name: 'audit-progress.png' }] },
  { file: 'report.html', screenshots: [{ name: 'report-full.png', fullPage: true }] },
  { file: 'project.html', screenshots: [{ name: 'project-dashboard.png', fullPage: true }] },
  { file: 'projects.html', screenshots: [{ name: 'projects-browse.png' }] },
];

async function capture() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  for (const page of pages) {
    const p = await context.newPage();
    const filePath = path.join(__dirname, page.file);
    await p.goto(`file://${filePath}`);
    await p.waitForTimeout(500); // Let CSS render

    for (const screenshot of page.screenshots) {
      await p.screenshot({
        path: path.join(screenshotsDir, screenshot.name),
        fullPage: screenshot.fullPage || false,
      });
      console.log(`Captured: ${screenshot.name}`);
    }
    await p.close();
  }

  await browser.close();
  console.log('All screenshots captured!');
}

capture().catch(console.error);
