import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbe, sanitizeAggregate } from './probe.mjs';

import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.SLACK_PROBE_PLAYWRIGHT).href);
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const context = await browser.newContext({ serviceWorkers: 'block' });
// All URLs in this test are synthetic and every request is fulfilled locally.
await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
const page = await context.newPage();
await page.goto('https://app.slack.com/');
const row = `<div class="c-message_kit__message" data-qa="message_container" data-message-id="SYNTHETIC_PRIVATE_ID"><div class="c-message_kit__text">SYNTHETIC_PRIVATE_BODY</div><a class="c-timestamp" href="https://private.invalid/secret">SYNTHETIC_PRIVATE_NAME</a><input value="SYNTHETIC_PRIVATE_CREDENTIAL"></div>`;
const pane = content => `<div class="p-threads_flexpane" data-qa="threads_flexpane" data-channel-id="SYNTHETIC_PRIVATE_SCOPE">${content}</div>`;
async function observe(html) {
  await page.setContent(html);
  const probe = await page.evaluateHandle(createProbe);
  try { return await probe.evaluate(fn => fn()); } finally { await probe.dispose(); }
}
try {
  await test('allowlisted aggregates redact synthetic sensitive fields and compare no identities', async () => {
    const result = await observe(pane(row));
    assert.equal(result.probe_ok, true);
    for (const key of ['root_count','kit_rows','qa_rows','identity_rows','body_rows','timestamp_rows','scoped_rows','candidate_rows']) assert.equal(result[key], 1);
    assert.equal(result.comparison_ready, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
    assert.deepEqual(sanitizeAggregate(result), result);
  });
  await test('repeated observations do not invent stable identity proof', async () => {
    await page.setContent(pane(row));
    const probe = await page.evaluateHandle(createProbe);
    try {
      for (let i = 0; i < 2; i++) {
        const result = await probe.evaluate(fn => fn());
        assert.equal(result.comparison_ready, false);
        assert.equal(result.retained_rows, i === 0 ? 0 : 1);
        assert.equal(result.added_rows, 0);
      }
    } finally { await probe.dispose(); }
  });
  await test('zero or ambiguous roots reject observation; outside rows excluded', async () => {
    assert.equal((await observe(row)).probe_ok, false);
    assert.equal((await observe(pane(row) + pane(row))).probe_ok, false);
    assert.equal((await observe(pane(row) + row)).candidate_rows, 1);
  });
  await test('unsupported fields give capability zeros, not authentication or empty-account evidence', async () => {
    const result = await observe(pane('<div class="c-message_kit__message"></div>'));
    assert.equal(result.probe_ok, true);
    for (const key of ['body_rows','timestamp_rows','identity_rows','scoped_rows']) assert.equal(result[key], key === 'scoped_rows' ? 1 : 0);
    assert.equal(result.comparison_ready, false);
  });
  await test('nested rows fail closed', async () => {
    const result = await observe(pane(`<div class="c-message_kit__message">${row}</div>`));
    assert.equal(result.probe_ok, false);
    assert.equal(result.candidate_rows, 0);
  });
  await test('row, field and discovery limits fail closed', async () => {
    for (const html of [pane(row.repeat(201)), pane(`<div class="c-message_kit__message">${'<b></b>'.repeat(501)}</div>`), '<b></b>'.repeat(20001)]) {
      const result = await observe(html);
      assert.equal(result.probe_ok, false);
      assert.equal(result.bounded, false);
      assert.equal(result.candidate_rows, 0);
    }
  });
  await test('private read exceptions fail closed without exporting exception text', async () => {
    await page.setContent(pane(row));
    await page.evaluate(() => {
      for (const key of ['textContent']) Object.defineProperty(Node.prototype, key, { get() { throw new Error('SYNTHETIC_PRIVATE'); }, configurable: true });
      for (const key of ['innerHTML','outerHTML']) Object.defineProperty(Element.prototype, key, { get() { throw new Error('SYNTHETIC_PRIVATE'); }, configurable: true });
      Element.prototype.getAttribute = () => { throw new Error('SYNTHETIC_PRIVATE'); };
    });
    const probe = await page.evaluateHandle(createProbe);
    assert.equal((await probe.evaluate(fn => fn())).probe_ok, false);
    await probe.dispose();
    await page.reload();
  });
  await test('wrong origin and thrown DOM access fail closed without exception text', async () => {
    for (const origin of ['https://example.invalid/', 'https://app.slack.com:444/', 'http://app.slack.com/']) {
      await page.goto(origin);
      assert.equal((await observe(pane(row))).probe_ok, false);
    }
    await page.goto('https://app.slack.com/');
    await page.setContent(pane(row));
    await page.evaluate(() => { document.createTreeWalker = () => { throw new Error('SYNTHETIC_PRIVATE'); }; });
    const probe = await page.evaluateHandle(createProbe);
    const result = await probe.evaluate(fn => fn());
    assert.equal(result.probe_ok, false);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'), false);
    await probe.dispose();
    await page.reload();
  });
  await test('candidate body and reaction deltas remain private and absence is not removal', async () => {
    await page.setContent(pane(row + row.replaceAll('SYNTHETIC_PRIVATE_ID', 'SECOND')));
    const probe = await page.evaluateHandle(createProbe);
    try {
      const first = await probe.evaluate(fn => fn());
      assert.equal(first.candidate_comparison, false);
      await page.evaluate(() => {
        document.querySelector('.c-message_kit__text').textContent = 'CHANGED_SYNTHETIC';
        const reaction = document.createElement('span');
        reaction.setAttribute('data-qa', 'reaction');
        reaction.setAttribute('data-emoji-name', 'SYNTHETIC_EMOJI');
        reaction.setAttribute('data-count', '1');
        document.querySelector('.c-message_kit__message').append(reaction);
      });
      const second = await probe.evaluate(fn => fn());
      assert.equal(second.candidate_comparison, true);
      assert.equal(second.retained_rows, 2);
      assert.equal(second.body_changes, 1);
      assert.equal(second.reaction_additions, 1);
      assert.equal(second.comparison_ready, false);
      assert.equal(JSON.stringify(second).includes('SYNTHETIC'), false);
      await page.evaluate(() => {
        document.querySelector('[data-qa="reaction"]').remove();
        document.querySelectorAll('.c-message_kit__message')[1].remove();
      });
      const third = await probe.evaluate(fn => fn());
      assert.equal(third.reaction_missing, 1);
      assert.equal(third.missing_rows, 1);
      assert.equal(third.removed_rows, 0);
      assert.equal(third.complete_snapshot, false);
    } finally { await probe.dispose(); }
  });
  await test('scope changes, duplicate identity and interrupted observations reset baselines', async () => {
    await page.setContent(pane(row));
    const probe = await page.evaluateHandle(createProbe);
    try {
      await probe.evaluate(fn => fn());
      await page.evaluate(() => document.querySelector('[data-channel-id]').setAttribute('data-channel-id', 'OTHER'));
      assert.equal((await probe.evaluate(fn => fn())).candidate_comparison, false);
      await page.evaluate(() => document.querySelector('.p-threads_flexpane').append(document.querySelector('.c-message_kit__message').cloneNode(true)));
      assert.equal((await probe.evaluate(fn => fn())).probe_ok, false);
      await page.evaluate(() => document.querySelectorAll('.c-message_kit__message')[1].remove());
      assert.equal((await probe.evaluate(fn => fn())).candidate_comparison, false);
    } finally { await probe.dispose(); }
  });
  await test('effective editable bodies fail closed and reset candidate baselines', async () => {
    for (const kind of ['empty', 'plaintext-only', 'inherited']) {
      await page.setContent(pane(row));
      const probe = await page.evaluateHandle(createProbe);
      try {
        assert.equal((await probe.evaluate(fn => fn())).probe_ok, true);
        await page.evaluate(kind => {
          const body = document.querySelector('.c-message_kit__text');
          const target = kind === 'inherited' ? body.parentElement : body;
          target.setAttribute('contenteditable', kind === 'plaintext-only' ? kind : '');
          body.textContent = 'SYNTHETIC_EDITABLE_PRIVATE';
        }, kind);
        const result = await probe.evaluate(fn => fn());
        assert.equal(result.probe_ok, false);
        assert.equal(result.body_changes, 0);
        assert.equal(result.candidate_comparison, false);
        assert.equal(JSON.stringify(result).includes('SYNTHETIC'), false);
        await page.evaluate(() => {
          for (const node of document.querySelectorAll('[contenteditable]')) node.removeAttribute('contenteditable');
        });
        assert.equal((await probe.evaluate(fn => fn())).candidate_comparison, false);
      } finally { await probe.dispose(); }
    }
  });
  await test('IPC schema rejects extras, strings, missing fields and out-of-range counts', async () => {
    const valid = await observe(pane(row));
    for (const invalid of [null, {...valid, secret:'SYNTHETIC_PRIVATE'}, {...valid, kit_rows:'secret'}, {...valid, kit_rows:201}, {...valid, kit_rows:-1}, {...valid, kit_rows:0.5}, {...valid, probe_ok:'yes'}]) assert.equal(sanitizeAggregate(invalid), null);
    const missing = {...valid}; delete missing.probe_ok;
    assert.equal(sanitizeAggregate(missing), null);
  });
} finally { await context.close(); await browser.close(); }
