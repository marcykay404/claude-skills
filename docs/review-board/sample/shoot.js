// Retakes the screenshots in ../images from the sample board.
// Run from the repo root: node docs/review-board/sample/shoot.js
// board.json is a sample review partway through; seed.json is its database after one round.
// The day-one shot uses the same board as it would have looked before any answers.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname, OUT = path.join(HERE, '..', 'images');
const BUILD = path.resolve(HERE, '../../../skills/review-board/scripts/build_board.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'review-board-shots-'));
const board = JSON.parse(fs.readFileSync(path.join(HERE, 'board.json'), 'utf8'));
const seed = JSON.parse(fs.readFileSync(path.join(HERE, 'seed.json'), 'utf8'));

// The publish skeleton the Artifact tool adds around the fragment.
function page(name, b) {
  const src = path.join(TMP, name + '.json'), frag = path.join(TMP, name + '.html'), full = path.join(TMP, name + '.full.html');
  fs.writeFileSync(src, JSON.stringify(b));
  execFileSync('python3', [BUILD, src, frag]);
  fs.writeFileSync(full, `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${fs.readFileSync(frag, 'utf8')}</body></html>`);
  return 'file://' + full;
}
const sample = page('sample', board);
const firstItems = board.items.filter(i => !i.isNew).map(({ changed, changedAt, isNew, ...i }) => i);
const dayOne = page('day-one', {
  ...board, round: 'Round 1', items: firstItems,
  groups: board.groups.filter(g => firstItems.some(i => i.group === g.key)),
});

// Single-item shots use a tall viewport so the whole item fits on screen.
// A fake window.claude with an in-memory database, like the browser tests use.
function stub({ data, lastVisit, title }) {
  try { if (lastVisit) localStorage.setItem('review-board:last-visit:' + title, lastVisit); } catch (e) {}
  const store = JSON.parse(JSON.stringify(data)); const subs = {}; let n = 0;
  const snap = c => ({ docs: Object.entries(store[c] || {}).map(([id, d]) => ({ id, data: () => d, metadata: {} })), metadata: { fromCache: false } });
  const fire = c => (subs[c] || []).forEach(cb => cb(snap(c)));
  const db = {
    collection: c => ({
      onSnapshot: cb => { (subs[c] = subs[c] || []).push(cb); setTimeout(() => cb(snap(c)), 5); return () => {}; },
      add: async d => { (store[c] = store[c] || {})['n' + (++n)] = d; setTimeout(() => fire(c), 5); return {}; },
    }),
    doc: p => ({ set: async d => { const [c, id] = p.split('/'); (store[c] = store[c] || {})[id] = d; setTimeout(() => fire(c), 5); } }),
  };
  window.claude = { use: async x => (x === 'db' ? db : x === 'user' ? { can: async () => true } : null) };
}

const errors = [];
async function open(browser, { url = sample, data = seed, w = 1100, h = 820, scheme = 'light', lastVisit = '2026-10-28T12:00:00.000Z' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(stub, { data, lastVisit, title: board.title });
  await p.goto(url);
  await p.waitForFunction(() => !/Loading/.test(document.getElementById('status-line').textContent));
  await p.waitForTimeout(200);
  return { ctx, p };
}
const save = async (target, name, opts = {}) => { await target.screenshot({ path: path.join(OUT, name), ...opts }); console.log('saved', name); };

(async () => {
  const b = await chromium.launch();
  let ctx, p;

  // 1. Overview after a round: status line, since your last visit, tabs, collapsed rows.
  ({ ctx, p } = await open(b)); await save(p, '01-overview.png'); await ctx.close();

  // 2. A follow-up question from Claude with quick replies (B3).
  ({ ctx, p } = await open(b, { h: 1400 })); await p.click('#item-B3 .row'); await p.waitForTimeout(500);
  await save(p.locator('#item-B3'), '02-follow-up.png'); await ctx.close();

  // 3. Answering B2, after choosing "I have a question…" (its earlier answer removed so it reads as fresh).
  const d3 = JSON.parse(JSON.stringify(seed)); delete d3.responses.B2;
  for (const k of Object.keys(d3.messages)) if (d3.messages[k].item === 'B2') delete d3.messages[k];
  ({ ctx, p } = await open(b, { data: d3, h: 1400 })); await p.click('#item-B2 .row');
  await p.click('#item-B2 .ans:has-text("I have a question")'); await p.waitForTimeout(500);
  await save(p.locator('#item-B2'), '03-answering.png'); await ctx.close();

  // 4. A decided item: the decision first, then the thread, with Reopen.
  ({ ctx, p } = await open(b, { h: 1400 })); await p.click('.tab:has-text("Decided")'); await p.click('#item-A1 .row'); await p.waitForTimeout(500);
  await save(p.locator('#item-A1'), '04-decided.png'); await ctx.close();

  // 5. Changed and new items: section B (B1 was rewritten after a question) and the new section D, with C folded away.
  ({ ctx, p } = await open(b)); await p.click('#gh-C .group-head'); await p.waitForTimeout(300);
  await p.evaluate(() => scrollTo(0, 0)); // keep the sticky tab bar in its place above the list
  // A full-page clip is in page coordinates, so measure from the top of the page, not the viewport.
  const clip = await p.evaluate(() => {
    const t = document.getElementById('group-B').getBoundingClientRect(), e = document.getElementById('group-D').getBoundingClientRect();
    return { x: t.left - 8, y: t.top + scrollY - 8, width: t.width + 16, height: e.bottom - t.top + 16 };
  });
  await save(p, '05-new-and-changed.png', { fullPage: true, clip });
  await ctx.close();

  // 6. "Anything else?" with a general note and Claude's reply.
  ({ ctx, p } = await open(b)); await p.click('#general-toggle'); await p.waitForTimeout(500);
  await save(p.locator('#general'), '06-anything-else.png'); await ctx.close();

  // 7. Phone, dark mode.
  ({ ctx, p } = await open(b, { w: 390, h: 844, scheme: 'dark' })); await save(p, '07-phone-dark.png'); await ctx.close();

  // 8. Day one: the board before any answers.
  ({ ctx, p } = await open(b, { url: dayOne, data: {}, lastVisit: null })); await save(p, '08-day-one.png'); await ctx.close();

  await b.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (errors.length) { console.error('page errors:', errors); process.exit(1); }
})();
