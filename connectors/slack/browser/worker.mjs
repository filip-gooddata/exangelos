import { pathToFileURL } from 'node:url';
import { createProbe, sanitizeAggregate } from './probe.mjs';
let browser;
let closing;
const close = () => closing ??= (async () => {
  try { await browser?.close(); } catch { process.exitCode = 1; }
})();

try {
  if (!process.send || !['smoke', 'owner-login'].includes(process.argv[2])) process.exit(2);
  const { chromium } = await import(pathToFileURL(process.argv[3]).href);
  const login = process.argv[2] === 'owner-login';
  browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-logging',
      '--disk-cache-size=0',
      '--media-cache-size=0',
      '--disable-sync',
    ],
    timeout: 30_000,
  });
  const context = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    permissions: [],
  });
  // Routing disables HTTP cache; no request data is inspected or exported.
  await context.route('**/*', (route) => route.continue().catch(() => {}));
  const page = await context.newPage();
  if (login) await page.goto('https://slack.com/signin', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  else if (context.pages().length !== 1 || page.url() !== 'about:blank') throw null;
  process.send(true);
  if (login) {
    let busy = false;
    let selectedPage;
    let probe;
    process.on('message', async (command) => {
      if (command !== 'probe' || busy || closing) return;
      busy = true;
      try {
        const admitted = [];
        const pages = context.pages();
        if (pages.length > 8) throw null;
        for (const candidate of pages) {
          if (await candidate.evaluate(() => location.origin === 'https://app.slack.com')) admitted.push(candidate);
        }
        if (admitted.length !== 1) throw null;
        if (selectedPage !== admitted[0] || !probe) {
          await probe?.dispose();
          selectedPage = admitted[0];
          probe = await selectedPage.evaluateHandle(createProbe);
        }
        const aggregate = sanitizeAggregate(await probe.evaluate((observe) => observe()));
        if (!aggregate) throw null;
        process.send(aggregate);
      } catch {
        await probe?.dispose().catch(() => {});
        probe = null; selectedPage = null;
        process.send(false);
      } finally { busy = false; }
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30 * 60 * 1000);
      const done = () => { clearTimeout(timer); resolve(); };
      browser.once('disconnected', done);
      process.once('SIGTERM', done);
      process.once('SIGINT', done);
      process.once('disconnect', done);
    });
  }
} catch {
  process.exitCode = 1;
} finally {
  await close();
  process.disconnect?.();
}
