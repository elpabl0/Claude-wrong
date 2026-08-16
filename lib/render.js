import { escapeHtml, markdown } from './markdown.js';

/* ------------------------------------------------------------------ styling */

export const CSS = `
:root{
  --bg:#faf9f7; --panel:#ffffff; --panel-2:#f4f2ee;
  --ink:#16181d; --muted:#63666f; --line:#e4e1db;
  --accent:#a8481a; --yes:#2c6b4b; --no:#9c3a3a; --void:#77797f; --open:#3a5a94;
  --shadow:0 1px 2px rgba(20,20,25,.05),0 8px 24px -16px rgba(20,20,25,.25);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e0f12; --panel:#15171c; --panel-2:#1b1e24;
    --ink:#e9e7e2; --muted:#989ca5; --line:#272b33;
    --accent:#e0904f; --yes:#6cbd93; --no:#e0736f; --void:#868a93; --open:#7ba3e0;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.8);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-feature-settings:"kern","liga";
}
.wrap{max-width:64rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
h1,h2,h3,h4{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;font-weight:600;line-height:1.2;letter-spacing:-.01em;margin:0 0 .5rem}
h1{font-size:clamp(1.9rem,4vw,2.6rem)}
h2{font-size:1.5rem;margin-top:2.75rem}
h3{font-size:1.15rem;margin-top:1.75rem}
p{margin:0 0 1rem}
code,.mono,.num{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:.92em}
code{background:var(--panel-2);padding:.1em .35em;border-radius:4px}
pre{background:var(--panel-2);padding:1rem;border-radius:8px;overflow-x:auto;border:1px solid var(--line)}
pre code{background:none;padding:0}
hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
blockquote{margin:0 0 1rem;padding:.25rem 0 .25rem 1rem;border-left:3px solid var(--line);color:var(--muted)}
small,.small{font-size:.85rem}
.muted{color:var(--muted)}
.scroll-x{overflow-x:auto;-webkit-overflow-scrolling:touch}

header.site{border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
header.site .wrap{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:baseline;padding-top:.9rem;padding-bottom:.9rem}
.brand{font-family:ui-monospace,monospace;font-weight:600;letter-spacing:-.02em;color:var(--ink);text-decoration:none;font-size:1.02rem}
.brand span{color:var(--accent)}
nav.site{display:flex;flex-wrap:wrap;gap:1rem;margin-left:auto;font-size:.92rem}
nav.site a{color:var(--muted);text-decoration:none}
nav.site a:hover,nav.site a[aria-current=page]{color:var(--ink);text-decoration:underline}

.lede{font-size:1.1rem;color:var(--muted);max-width:44rem}
main{padding:2.5rem 0 4rem}

.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:1.75rem 0}
.tile{background:var(--panel);padding:1rem 1.1rem}
.tile .k{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.tile .v{font-family:ui-monospace,monospace;font-size:1.7rem;line-height:1.25;margin-top:.3rem;font-variant-numeric:tabular-nums}
.tile .s{font-size:.8rem;color:var(--muted);margin-top:.15rem}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.25rem;box-shadow:var(--shadow)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(19rem,1fr));gap:1rem}

table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.74rem;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
td.num,th.num{text-align:right;font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}

.tag{display:inline-block;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;padding:.15rem .45rem;border-radius:4px;border:1px solid var(--line);color:var(--muted);background:var(--panel-2);white-space:nowrap}
.tag.yes{color:var(--yes);border-color:color-mix(in srgb,var(--yes) 35%,transparent)}
.tag.no{color:var(--no);border-color:color-mix(in srgb,var(--no) 35%,transparent)}
.tag.void{color:var(--void)}
.tag.open{color:var(--open);border-color:color-mix(in srgb,var(--open) 35%,transparent)}
.tag.overdue{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent)}

.plist{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel)}
.plist li{border-bottom:1px solid var(--line)}
.plist li:last-child{border-bottom:0}
.plist a.row{display:grid;grid-template-columns:4.2rem 1fr auto;gap:.9rem;align-items:baseline;padding:.85rem 1rem;text-decoration:none;color:inherit}
.plist a.row:hover{background:var(--panel-2)}
.p-prob{font-family:ui-monospace,monospace;font-size:1.05rem;font-variant-numeric:tabular-nums;text-align:right;color:var(--ink)}
.p-q{font-size:.97rem}
.p-meta{font-size:.78rem;color:var(--muted);margin-top:.2rem;display:flex;flex-wrap:wrap;gap:.5rem}
.p-right{text-align:right;white-space:nowrap}

.bar{height:4px;background:var(--panel-2);border-radius:2px;overflow:hidden;margin-top:.4rem;max-width:12rem}
.bar>i{display:block;height:100%;background:var(--accent)}

figure{margin:1.5rem 0}
figcaption{font-size:.85rem;color:var(--muted);margin-top:.6rem}
svg .axis{stroke:var(--line)}
svg .gridline{stroke:var(--line);stroke-dasharray:2 4}
svg .ref{stroke:var(--muted);stroke-dasharray:5 4;opacity:.7}
svg .pt{fill:var(--accent)}
svg .err{stroke:var(--accent);opacity:.55}
svg .lbl{fill:var(--muted);font:11px ui-monospace,monospace}
svg .crowd{fill:none;stroke:var(--open);stroke-width:1.5;stroke-dasharray:4 3}

.hyp{border-left:3px solid var(--line);padding:.1rem 0 .1rem 1rem;margin:1.25rem 0}
.hyp.supported{border-color:var(--no)}
.hyp.contradicted{border-color:var(--yes)}
.hyp.undecided,.hyp.insufficient-data{border-color:var(--line)}
.hyp h3{margin:0 0 .35rem;font-size:1.02rem}

.callout{background:var(--panel-2);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:.9rem 1.1rem;margin:1.5rem 0;font-size:.94rem}
.kv{display:grid;grid-template-columns:minmax(8rem,max-content) 1fr;gap:.35rem 1.1rem;font-size:.93rem}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
.reasoning{white-space:pre-wrap;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:1rem;font-size:.94rem}

footer.site{border-top:1px solid var(--line);padding:2rem 0 3rem;color:var(--muted);font-size:.86rem;background:var(--panel)}
footer.site p{margin:0 0 .5rem}
@media (max-width:36rem){
  .plist a.row{grid-template-columns:3.4rem 1fr;}
  .p-right{grid-column:1/-1;text-align:left;margin-top:.1rem}
}
`;

/* ------------------------------------------------------------------ helpers */

export const fmt = {
  pct: (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`),
  num: (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d)),
  signed: (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`),
  date: (s) => (s ? String(s).slice(0, 10) : '—'),
  int: (x) => (x === null || x === undefined ? '—' : String(x)),
};

/** Wilson score interval - honest error bars on a small number of coin flips. */
export function wilson(successes, n, z = 1.96) {
  if (!n) return null;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const NAV = [
  ['/', 'Ledger'],
  ['/open/', 'Open'],
  ['/resolved/', 'Resolved'],
  ['/calibration/', 'Calibration'],
  ['/methodology/', 'Method'],
];

export function layout({ title, description, body, active = '/', config, generated }) {
  const site = config.site;
  const full = title === site.title ? title : `${title} · ${site.title}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(full)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(full)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://${site.domain}${active}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="https://${site.domain}${active}">
<link rel="alternate" type="application/feed+json" href="/feed.json" title="${escapeHtml(site.title)}">
<style>${CSS}</style>
</head>
<body>
<header class="site"><div class="wrap">
  <a class="brand" href="/">wrong<span>.</span>aecs<span>.</span>io</a>
  <nav class="site">
    ${NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`).join('\n    ')}
    <a href="${site.repo}" rel="noopener">Source</a>
  </nav>
</div></header>
<main><div class="wrap">
${body}
</div></main>
<footer class="site"><div class="wrap">
  <p>Predictions are written by a language model on a schedule, and resolved by a script against a source and a threshold that were both committed before the outcome was known.</p>
  <p>Every record is append-only and its history is checked on each push, so nothing here can be softened after the fact. <a href="${site.repo}" rel="noopener">Read the code</a> · <a href="/api/report.json">JSON</a> · <a href="/feed.json">Feed</a></p>
  <p class="mono small">Built ${escapeHtml(generated)} · protocol v${config.protocol_version}</p>
</div></footer>
</body>
</html>`;
}

/* ------------------------------------------------------------------- pieces */

export function tiles(items) {
  return `<div class="tiles">${items
    .map((t) => `<div class="tile"><div class="k">${escapeHtml(t.k)}</div><div class="v">${t.v}</div>${t.s ? `<div class="s">${t.s}</div>` : ''}</div>`)
    .join('')}</div>`;
}

const STATE_TAG = {
  resolved: (e) => `<span class="tag ${e.resolution.status}">${e.resolution.status}</span>`,
  void: () => '<span class="tag void">void</span>',
  open: () => '<span class="tag open">open</span>',
  overdue: () => '<span class="tag overdue">resolving</span>',
};

export function predictionRow(e) {
  const p = e.prediction;
  const right =
    e.state === 'resolved'
      ? `${STATE_TAG.resolved(e)}<div class="p-meta" style="justify-content:flex-end"><span class="num">Brier ${fmt.num(e.brier)}</span></div>`
      : e.state === 'void'
        ? STATE_TAG.void()
        : `${STATE_TAG[e.state](e)}<div class="p-meta" style="justify-content:flex-end">${e.state === 'open' ? `${e.daysUntilResolution}d left` : `due ${fmt.date(p.resolution_date)}`}</div>`;
  return `<li><a class="row" href="/p/${p.id}/">
  <div class="p-prob">${fmt.pct(p.probability)}<div class="bar"><i style="width:${(p.probability * 100).toFixed(1)}%"></i></div></div>
  <div>
    <div class="p-q">${escapeHtml(p.question)}</div>
    <div class="p-meta">
      <span>${escapeHtml(p.category)}</span>
      <span>${p.claim_type}</span>
      <span>${e.horizonDays}d</span>
      ${p.origin === 'crowd-mirror' ? `<span>${escapeHtml(p.external_reference.platform)} · crowd ${fmt.pct(p.external_reference.community_probability)}</span>` : ''}
      <span class="mono">${fmt.date(p.batch)} → ${fmt.date(p.resolution_date)}</span>
    </div>
  </div>
  <div class="p-right">${right}</div>
</a></li>`;
}

export function predictionList(entries, emptyMessage = 'Nothing here yet.') {
  if (!entries.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `<ul class="plist">${entries.map(predictionRow).join('\n')}</ul>`;
}

/**
 * Reliability diagram. The dashed diagonal is perfect calibration; a point above
 * it means the world said yes more often than the forecast did.
 */
export function calibrationChart(bins, { width = 620, height = 420 } = {}) {
  const pad = { l: 52, r: 18, t: 18, b: 46 };
  const W = width - pad.l - pad.r;
  const H = height - pad.t - pad.b;
  const x = (v) => pad.l + v * W;
  const y = (v) => pad.t + (1 - v) * H;
  const used = bins.filter((b) => b.n > 0);

  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const gridlines = ticks
    .map(
      (t) =>
        `<line class="gridline" x1="${x(0)}" y1="${y(t)}" x2="${x(1)}" y2="${y(t)}"/>` +
        `<line class="gridline" x1="${x(t)}" y1="${y(0)}" x2="${x(t)}" y2="${y(1)}"/>`,
    )
    .join('');
  const labels = ticks
    .map(
      (t) =>
        `<text class="lbl" x="${x(t)}" y="${y(0) + 18}" text-anchor="middle">${(t * 100).toFixed(0)}%</text>` +
        `<text class="lbl" x="${x(0) - 8}" y="${y(t) + 4}" text-anchor="end">${(t * 100).toFixed(0)}%</text>`,
    )
    .join('');

  const maxN = Math.max(1, ...used.map((b) => b.n));
  const points = used
    .map((b) => {
      const ci = wilson(Math.round(b.observed * b.n), b.n);
      const r = 3 + 7 * Math.sqrt(b.n / maxN);
      const err = ci
        ? `<line class="err" x1="${x(b.meanPredicted)}" y1="${y(ci.lo)}" x2="${x(b.meanPredicted)}" y2="${y(ci.hi)}" stroke-width="1.5"/>`
        : '';
      return `${err}<circle class="pt" cx="${x(b.meanPredicted)}" cy="${y(b.observed)}" r="${r.toFixed(1)}"><title>${b.label}: ${b.n} prediction${b.n === 1 ? '' : 's'}, mean forecast ${fmt.pct(b.meanPredicted, 1)}, happened ${fmt.pct(b.observed, 1)} of the time</title></circle>`;
    })
    .join('');

  const path = used.length > 1
    ? `<polyline class="crowd" points="${used.map((b) => `${x(b.meanPredicted).toFixed(1)},${y(b.observed).toFixed(1)}`).join(' ')}" style="stroke:var(--accent);stroke-dasharray:none;opacity:.35"/>`
    : '';

  return `<figure>
<div class="scroll-x"><svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto" role="img" aria-label="Reliability diagram: forecast probability against observed frequency">
  ${gridlines}
  <line class="ref" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>
  <line class="axis" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0)}"/>
  <line class="axis" x1="${x(0)}" y1="${y(0)}" x2="${x(0)}" y2="${y(1)}"/>
  ${labels}
  ${path}
  ${points}
  <text class="lbl" x="${pad.l + W / 2}" y="${height - 6}" text-anchor="middle">forecast probability</text>
  <text class="lbl" x="14" y="${pad.t + H / 2}" text-anchor="middle" transform="rotate(-90 14 ${pad.t + H / 2})">observed frequency</text>
</svg></div>
<figcaption>Each point is a probability bin. The dashed diagonal is perfect calibration: points above it mean the forecasts were too low, points below mean they were too high. Point size is the number of predictions in the bin; the vertical bar is a 95% Wilson interval on the observed frequency, which is wide when a bin is small — as most of them will be for a while.</figcaption>
</figure>`;
}

export function breakdownTable(rows, keyLabel) {
  if (!rows.length) return '<p class="muted">Nothing resolved in this cut yet.</p>';
  return `<div class="scroll-x"><table>
<thead><tr>
  <th>${escapeHtml(keyLabel)}</th><th class="num">n</th><th class="num">Brier</th>
  <th class="num">mean forecast</th><th class="num">happened</th><th class="num">gap</th><th class="num">skill vs base rate</th>
</tr></thead>
<tbody>${rows
    .map(
      (r) => `<tr>
  <td>${escapeHtml(String(r.key))}</td>
  <td class="num">${r.n}</td>
  <td class="num">${fmt.num(r.meanBrier)}</td>
  <td class="num">${fmt.pct(r.meanProbability, 1)}</td>
  <td class="num">${fmt.pct(r.baseRate, 1)}</td>
  <td class="num">${fmt.signed(r.calibrationGap.mean)}</td>
  <td class="num">${fmt.num(r.skillVsBaseRate)}</td>
</tr>`,
    )
    .join('')}</tbody></table></div>
<p class="small muted">“Gap” is mean forecast minus what actually happened: positive means over-forecasting. “Skill vs base rate” compares the Brier score to a forecaster who always predicts the observed frequency of this group; above zero beats it, below zero loses to it.</p>`;
}

export function hypothesisBlock(key, h) {
  const status = h.verdict.status;
  const label = { supported: 'Supported so far', contradicted: 'Contradicted so far', undecided: 'Undecided', 'insufficient-data': 'Not enough data yet' }[status];
  return `<div class="hyp ${status}">
  <h3>${key}. ${escapeHtml(h.claim)}</h3>
  <p class="small muted">${escapeHtml(h.test)}</p>
  <p class="small mono">${escapeHtml(h.statistic)} = ${fmt.signed(h.mean)} &nbsp; 95% CI [${fmt.num(h.lo)}, ${fmt.num(h.hi)}] &nbsp; n = ${h.n}</p>
  <p class="small"><strong>${label}.</strong> ${escapeHtml(h.verdict.text)}</p>
</div>`;
}

export { escapeHtml, markdown };
