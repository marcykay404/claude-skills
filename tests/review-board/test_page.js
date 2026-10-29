#!/usr/bin/env node
// Browser tests for the review-board page. Run: node tests/review-board/test_page.js
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
// Each test builds a board with build_board.py, serves the page with a fake `window.claude`
// database, and drives it like a person would.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const SKILL = path.resolve(__dirname, '../../skills/review-board');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-cases.json'), 'utf8')).cases;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'review-board-test-'));
const T = m => `2026-01-01T08:${String(m).padStart(2, '0')}:00.000Z`;

const BOARD = {
  title: 'Test Board', groups: [{ key: 'X', title: 'Group X' }, { key: 'Y', title: 'Group Y' }],
  items: [
    { id: 'X1', group: 'X', severity: 'blocker', title: 'Question one', issue: 'Issue one.', rec: 'Do one.', options: [{ key: 'a', label: 'Option A', recommended: true }, { key: 'b', label: 'Option B' }] },
    { id: 'X2', group: 'X', severity: 'important', title: 'Question two', issue: 'Issue two.', rec: 'Do two.' },
    { id: 'Y1', group: 'Y', severity: 'detail', title: 'Question three', issue: 'Issue three.', rec: 'Do three.' },
  ],
};

function build(board) {
  const src = path.join(TMP, 'board.json'), out = path.join(TMP, 'board.html');
  fs.writeFileSync(src, JSON.stringify(board));
  execFileSync('python3', [path.join(SKILL, 'scripts/build_board.py'), src, out]);
  const page = path.join(TMP, 'page.html');
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>${fs.readFileSync(out, 'utf8')}</body></html>`);
  return 'file://' + page;
}

// Fake database. opts: data {coll:{id:body}}, delayMs before use('db') resolves, failSet/failAdd (number of rejections),
// noDb, readOnly.
function stub(opts) {
  return `(() => {
    const o = ${JSON.stringify(opts)};
    const store = o.data || {}; const subs = {}; let n = 0;
    window.__writes = []; window.__fail = { set: o.failSet || 0, add: o.failAdd || 0 };
    const snap = c => ({ docs: Object.entries(store[c] || {}).map(([id, b]) => ({ id, data: () => b, metadata: {} })), metadata: { fromCache: false } });
    const fire = c => (subs[c] || []).forEach(cb => cb(snap(c)));
    const err = () => Object.assign(new Error('down'), { code: 'unavailable' });
    const db = {
      collection: c => ({
        onSnapshot: cb => { (subs[c] = subs[c] || []).push(cb); setTimeout(() => cb(snap(c)), 5); return () => {}; },
        add: async b => { if (window.__fail.add > 0) { window.__fail.add--; throw err(); } const id = 'm' + (++n); (store[c] = store[c] || {})[id] = b; window.__writes.push([c, id, b]); setTimeout(() => fire(c), o.echoMs || 5); return { id }; },
      }),
      doc: p => ({ set: async b => { if (window.__fail.set > 0) { window.__fail.set--; throw err(); } const [c, id] = p.split('/'); (store[c] = store[c] || {})[id] = b; window.__writes.push([c, id, b]); setTimeout(() => fire(c), o.echoMs || 5); } }),
    };
    window.claude = { use: name => new Promise(res => setTimeout(() => res(
      name === 'db' ? (o.noDb ? null : db) : name === 'user' ? { can: async () => !o.readOnly } : null), name === 'db' ? (o.delayMs || 0) : 0)) };
  })();`;
}

let browser;
async function open(opts = {}, { board = BOARD, w = 1100, h = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  await page.addInitScript(stub(opts));
  await page.goto(build(board));
  if (!opts.delayMs && !opts.noDb) await page.waitForFunction(() => !/Loading/.test(document.getElementById('status-line').textContent));
  page._errors = errors; page._ctx = ctx;
  return page;
}
const close = async p => { assert.deepStrictEqual(p._errors, [], 'page errors'); await p._ctx.close(); };
const state = (p, id) => p.$eval('#item-' + id, n => n.dataset.state);
const writes = p => p.evaluate(() => window.__writes.map(([c, id, b]) => [c, id, b.answer !== undefined ? b.answer : b.text]));
const settle = p => p.waitForTimeout(120);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- state rules: the page must agree with round_report.py on every shared case ----
test('state parity with round_report.py', async () => {
  for (const c of CASES) {
    const data = { responses: {}, decisions: {}, messages: {} };
    if (c.responses) data.responses.X1 = { ...c.responses, at: T(c.responses.at) };
    if (c.decisions) data.decisions.X1 = { ...c.decisions, text: 'Decision', at: T(c.decisions.at), ...(c.decisions.seen ? { seen: T(c.decisions.seen) } : {}) };
    (c.messages || []).forEach((m, i) => { data.messages['m' + i] = { ...m, item: 'X1', text: 'note', at: T(m.at), ...(m.seen ? { seen: T(m.seen) } : {}) }; });
    const p = await open({ data });
    assert.strictEqual(await state(p, 'X1'), c.expect, c.name);
    await close(p);
  }
});

// ---- answering ----
test('every answer saves at once; clicking it again or Clear answer undoes it', async () => {
  const p = await open();
  await p.click('#item-X1 .row');
  await p.click('#item-X1 [data-fk="ans:b"]'); await settle(p);
  assert.strictEqual(await state(p, 'X1'), 'with_claude');
  await p.click('#item-X1 [data-fk="ans:b"]'); await settle(p);
  assert.strictEqual(await state(p, 'X1'), 'your_turn', 'clicking the selected answer again clears it');
  await p.click('#item-X1 [data-fk="ans:a"]'); await settle(p);
  await p.click('#item-X1 [data-fk="clear"]'); await settle(p);
  assert.strictEqual(await state(p, 'X1'), 'your_turn', 'Clear answer clears it');
  assert.deepStrictEqual((await writes(p)).map(w => w[2]), ['b', null, 'a', null]);
  await close(p);
});

test('"I have a question" saves and opens the comment box under the buttons', async () => {
  const p = await open();
  await p.click('#item-X1 .row');
  await p.click('#item-X1 [data-fk="ans:discuss"]'); await settle(p);
  const order = await p.$$eval('#item-X1 .body > *', ns => ns.map(n => n.className));
  assert.ok(order.indexOf('prompt-note') === order.indexOf('answers') + 1, order.join(','));
  assert.strictEqual(await p.evaluate(() => document.activeElement.id), 'c-X1');
  await close(p);
});

test('keyboard: focus stays on the chosen answer; arrow keys move between answers', async () => {
  const p = await open();
  await p.click('#item-X1 .row');
  await p.focus('#item-X1 [data-fk="ans:a"]'); await p.keyboard.press('Space'); await settle(p);
  assert.strictEqual(await p.evaluate(() => document.activeElement.dataset.fk), 'ans:a');
  await p.keyboard.press('ArrowRight');
  assert.strictEqual(await p.evaluate(() => document.activeElement.dataset.fk), 'ans:b');
  await close(p);
});

test('row accessible name is the title; the summary is its description', async () => {
  const p = await open();
  const r = await p.$eval('#item-X1 .row', n => [n.getAttribute('aria-labelledby'), n.getAttribute('aria-describedby')]);
  assert.deepStrictEqual(r, ['t-X1', 's-X1']);
  assert.strictEqual(await p.$eval('#gh-X', n => n.tagName + '>' + n.firstElementChild.tagName), 'H2>BUTTON');
  await close(p);
});

// ---- saving: failures, retries, sending ----
test('a transient failure is retried once and succeeds', async () => {
  const p = await open({ failSet: 1 });
  await p.click('#item-X1 .row'); await p.click('#item-X1 [data-fk="ans:b"]');
  await p.waitForTimeout(1500);
  assert.deepStrictEqual(await writes(p), [['responses', 'X1', 'b']]);
  assert.strictEqual(await state(p, 'X1'), 'with_claude');
  await close(p);
});

test('a failed save rolls back and offers Retry', async () => {
  const p = await open({ failSet: 2 });
  await p.click('#item-X1 .row'); await p.click('#item-X1 [data-fk="ans:b"]');
  await p.waitForTimeout(1500);
  assert.strictEqual(await state(p, 'X1'), 'your_turn', 'rolled back');
  assert.strictEqual(await p.$$eval('#item-X1 .ans[aria-checked="true"]', n => n.length), 0);
  assert.match(await p.$eval('#item-X1 .ans-foot .save-status', n => n.textContent), /Couldn't save/);
  await p.click('#item-X1 [data-fk="retry"]'); await p.waitForTimeout(300);
  assert.deepStrictEqual(await writes(p), [['responses', 'X1', 'b']]);
  await close(p);
});

test('a failed comment keeps the draft', async () => {
  const p = await open({ failAdd: 2 });
  await p.click('#item-X2 .row'); await p.fill('#c-X2', 'Keep me'); await p.click('#item-X2 [data-fk="send"]');
  await p.waitForTimeout(1500);
  assert.strictEqual(await p.$eval('#c-X2', n => n.value), 'Keep me');
  assert.strictEqual(await p.$$eval('#item-X2 .msg', n => n.length), 0);
  await close(p);
});

test('Ctrl+Enter sends once, clears the box and shows the comment', async () => {
  const p = await open();
  await p.click('#item-X2 .row'); await p.fill('#c-X2', 'Via keyboard');
  await p.keyboard.press('Control+Enter'); await settle(p);
  await p.keyboard.press('Control+Enter'); await settle(p);
  assert.strictEqual(await p.$eval('#c-X2', n => n.value), '');
  assert.deepStrictEqual(await p.$$eval('#item-X2 .msg', ns => ns.map(n => n.textContent)), ['YouVia keyboard']);
  assert.strictEqual((await writes(p)).length, 1);
  assert.strictEqual(await p.evaluate(() => document.activeElement.id), 'c-X2');
  await close(p);
});

test('a quick reply sends once even if tapped twice', async () => {
  const data = { responses: { X2: { answer: 'discuss', at: T(1) } }, messages: { o: { item: 'X2', by: 'owner', text: 'Q?', at: T(1) }, c: { item: 'X2', by: 'claude', text: 'Which?', at: T(5), seen: T(1), asks: true, quick: [{ label: 'This one' }, { label: 'That one' }] } } };
  // echoMs: the saved reply reaches the snapshot late, so the second tap lands after the write
  // has finished but before the page has seen it.
  const p = await open({ data, echoMs: 400 });
  await p.click('#item-X2 .row');
  await p.$eval('#item-X2 [data-fk="q0"]', b => { b.click(); b.click(); });
  await p.waitForTimeout(100);
  await p.click('#item-X2 [data-fk="q0"]', { force: true, timeout: 300 }).catch(() => {});
  await p.waitForTimeout(500);
  assert.strictEqual((await writes(p)).filter(w => w[2] === 'This one').length, 1);
  assert.strictEqual(await state(p, 'X2'), 'with_claude');
  await close(p);
});

test('unsent drafts survive a reload', async () => {
  const p = await open();
  await p.click('#item-X2 .row'); await p.fill('#c-X2', 'Half written');
  await p.reload(); await p.waitForFunction(() => !/Loading/.test(document.getElementById('status-line').textContent));
  await p.click('#item-X2 .row');
  assert.strictEqual(await p.$eval('#c-X2', n => n.value), 'Half written');
  await close(p);
});

// ---- loading and access ----
test('while loading: no fake state, controls disabled, clicks ignored', async () => {
  const p = await open({ delayMs: 1500 });
  assert.match(await p.$eval('#status-line', n => n.textContent), /Loading/);
  await p.click('#item-X1 .row');
  assert.ok(await p.$eval('#item-X1 [data-fk="ans:a"]', n => n.disabled));
  await p.waitForFunction(() => !/Loading/.test(document.getElementById('status-line').textContent));
  assert.deepStrictEqual(await writes(p), []);
  assert.ok(!(await p.$eval('#item-X1 [data-fk="ans:a"]', n => n.disabled)), 'enabled once loaded');
  await close(p);
});

test('no database: says so and stays read-only', async () => {
  const p = await open({ noDb: true }); await p.waitForTimeout(300);
  assert.match(await p.$eval('#status-line', n => n.textContent), /can't be loaded/);
  assert.ok(!(await p.$eval('#banner', n => n.hidden)));
  await close(p);
});

test('read-only access disables answering', async () => {
  const p = await open({ readOnly: true });
  await p.click('#item-X1 .row');
  assert.ok(await p.$eval('#item-X1 [data-fk="ans:a"]', n => n.disabled));
  assert.match(await p.$eval('#banner', n => n.textContent), /can't save/);
  await close(p);
});

// ---- decided items, tabs, sections ----
test('decided item: decision first, no comment box until Reopen, then "Previous decision"', async () => {
  const data = { responses: { X1: { answer: 'a', at: T(1) } }, decisions: { X1: { text: 'Go with A.', at: T(5), seen: T(1) } } };
  const p = await open({ data });
  await p.click('.tab:has-text("Decided")'); await p.click('#item-X1 .row');
  assert.strictEqual(await p.$eval('#item-X1 .body > :first-child', n => n.className), 'decision-box');
  assert.strictEqual(await p.$$eval('#item-X1 textarea', n => n.length), 0);
  await p.click('#item-X1 [data-fk="reopen"]');
  await p.fill('#c-X1', 'Reconsider'); await p.click('#item-X1 [data-fk="send"]'); await settle(p);
  assert.strictEqual(await state(p, 'X1'), 'with_claude');
  assert.strictEqual(await p.$eval('#item-X1 .decision-box .label', n => n.textContent), 'Previous decision');
  assert.strictEqual(await p.$$eval('#item-X1 [data-fk="reopen"]', n => n.length), 0);
  await close(p);
});

test('Decided tab shows items from fully decided sections', async () => {
  const data = { responses: {}, decisions: { Y1: { text: 'Done.', at: T(5), seen: T(1) } } };
  const p = await open({ data });
  await p.click('.tab:has-text("Decided")');
  assert.ok(await p.$eval('#item-Y1', n => n.offsetHeight > 0));
  await close(p);
});

test('Anything else: Claude replies show a badge and appear in Since your last visit', async () => {
  const data = { messages: { o: { item: '_general', by: 'owner', text: 'Also refunds', at: T(1) }, c: { item: '_general', by: 'claude', text: 'Added D1-D3', at: T(5) } } };
  const p = await (async () => {
    const ctx = await browser.newContext(); const pg = await ctx.newPage(); pg._errors = []; pg._ctx = ctx;
    pg.on('pageerror', e => pg._errors.push(e.message));
    await pg.addInitScript(() => { try { localStorage.setItem('review-board:last-visit:Test Board', '2026-01-01T08:02:00.000Z'); } catch (e) {} });
    await pg.addInitScript(stub({ data })); await pg.goto(build(BOARD));
    await pg.waitForFunction(() => !/Loading/.test(document.getElementById('status-line').textContent)); return pg;
  })();
  assert.match(await p.$eval('#general-toggle', n => n.textContent), /1 new from Claude/);
  assert.match(await p.$eval('#since-list', n => n.textContent), /Anything else · Claude replied/);
  await close(p);
});

// ---- layout and safety ----
test('phone: long unbroken text never makes the page scroll sideways', async () => {
  const long = 'https://example.com/' + 'x'.repeat(300);
  const board = JSON.parse(JSON.stringify(BOARD)); board.items[0].rec = long; board.items[0].issue = long; board.items[0].title = 'T' + 'y'.repeat(120);
  const p = await open({}, { board, w: 390, h: 844 });
  await p.click('#item-X1 .row'); await settle(p);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
  await close(p);
});

test('board text is shown as text, never run as code', async () => {
  const board = JSON.parse(JSON.stringify(BOARD)); board.items[0].title = '<img src=x onerror="window.__pwned=1">'; board.title = '</title><script>window.__pwned=1</script>';
  const p = await open({}, { board });
  assert.strictEqual(await p.evaluate(() => window.__pwned), undefined);
  assert.strictEqual(await p.$eval('#t-X1', n => n.textContent), '<img src=x onerror="window.__pwned=1">');
  await close(p);
});

test('text boxes: Home and End move the caret instead of scrolling', async () => {
  const p = await open();
  await p.click('#item-X2 .row'); await p.click('#c-X2'); await p.keyboard.type('first\nsecond line');
  await p.keyboard.press('Home');
  assert.deepStrictEqual(await p.$eval('#c-X2', n => [n.selectionStart, n.selectionEnd]), [6, 6]);
  await p.keyboard.press('Control+Home');
  assert.deepStrictEqual(await p.$eval('#c-X2', n => [n.selectionStart, n.selectionEnd]), [0, 0]);
  await close(p);
});

(async () => {
  browser = await chromium.launch();
  let failed = 0;
  const only = process.argv[2]; // optional: run only tests whose name contains this text
  for (const [name, fn] of tests.filter(([n]) => !only || n.includes(only))) {
    try { await fn(); console.log('  ok  ', name); }
    catch (e) { failed++; console.log('  FAIL', name, '\n       ', (e.message || String(e)).split('\n').slice(0, 6).join('\n        ')); }
  }
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${(only ? tests.filter(([n]) => n.includes(only)) : tests).length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
