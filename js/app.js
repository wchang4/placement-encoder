// app.js
// The page. It holds the state (the video, the chosen placements, the names typed)
// and draws it. Everything about WHAT each file should be comes from plan.js; the
// encoder work lives in engine.js, args.js, level.js and analyze.js; the final
// report is verify.js. Placements live in placements.json, so adding one needs no code.

import { Engine } from './engine.js';
import { buildArgs, targetFormat, spotLength, outDuration } from './args.js';
import { verify, overall, checkName } from './verify.js';
import { measureAudio, scanVideo, grabFrames, describeBars, describeBlackEnds } from './analyze.js';
import { planLeveling } from './level.js';
import { planFiles, describeFile, nameSlots, checkNames, reportSpec, checkSource } from './plan.js';
import { summarize, pixDepth, fmtFps, fmtBytes, fmtKbps, fmtTime, aspectLabel } from './media.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();

const S = {
  cfg: null,
  chosen: [],          // placement ids, in the order of placements.json
  video: null,         // { file, src, analysis, baseName }
  files: [],           // from planFiles, each with .slots (names) and .desc (describeFile)
  names: {},           // names the person typed, by slot id
  custom: {},          // per-file setting changes, by file key
  results: {},         // per-file result after making it, by file key
  makeAnyway: {},      // files whose video is already good to go, but the person asked for a new one anyway
  running: false, cancelled: false, busyKey: null,
  blobUrls: []
};

// ---------- tiny helpers ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const joinNames = (a) => { const u = [...new Set(a)]; return u.length <= 1 ? (u[0] || '') : u.slice(0, -1).join(', ') + ' and ' + u[u.length - 1]; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const mbps = (k) => (k / 1000).toFixed(1).replace(/\.0$/, '') + ' Mbps';
const placement = (id) => S.cfg.placements.find(p => p.id === id);

// Broadcast timecode: frames counted at the nominal rate (29.97 counts as 30), so a
// 15 s spot at 29.97 fps (450 frames) reads 00:00:15:00.
function timecode(sec, fps) {
  const nom = Math.round(fps || 30), frames = Math.round(sec * (fps || 30));
  const ff = frames % nom, s = Math.floor(frames / nom);
  const p = (x) => String(x).padStart(2, '0');
  return { hms: `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`, ff: p(ff), frames };
}

// ---------- theme ----------
function setupTheme() {
  const btn = $('theme-switch');
  const isDark = () => document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const sync = () => { btn.setAttribute('aria-checked', String(isDark())); btn.title = isDark() ? 'Switch to light mode' : 'Switch to dark mode'; };
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pe-theme', next); } catch (e) { /* private window: not remembered */ }
    sync();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', sync);
  sync();
}

// ---------- 2. tiles ----------
function badge(p, cls = 'word') {
  const tl = p.tile || {};
  const stripes = Array.isArray(tl.colors) && tl.colors.length > 1
    ? `background:linear-gradient(90deg,${tl.colors.map((c, i, a) => `${c} ${(100 * i / a.length).toFixed(1)}% ${(100 * (i + 1) / a.length).toFixed(1)}%`).join(',')})` : null;
  return el('span', { class: cls, style: `--brand:${tl.color || '#4f5866'};${stripes || ''}`, text: tl.title || p.short });
}

function buildTiles() {
  const list = S.cfg.placements;
  const tiles = list.map(p => {
    const tl = p.tile || {};
    const logo = el('div', { class: 'logo' });
    if (tl.logo) {
      const img = el('img', { src: tl.logo, alt: tl.title || p.short });
      img.addEventListener('error', () => logo.replaceChildren(badge(p)));
      logo.append(img);
    } else logo.append(badge(p));
    return el('button', { type: 'button', class: 'tile', 'data-id': p.id, 'aria-pressed': 'false', title: p.name, onclick: () => onTile(p) },
      el('span', { class: 'chk', 'aria-hidden': 'true', text: '✓' }), logo, el('span', { class: 'sub', text: tl.sub || '' }));
  });
  $('tiles').replaceChildren(...tiles);
}

function onTile(p) {
  if (S.making) return; // placements can be chosen while the video is checked, not while files are made
  const on = !S.chosen.includes(p.id);
  if (on && p.custom) S.chosen = [p.id];                                     // Custom stands alone
  else if (on) S.chosen = S.chosen.filter(id => !placement(id).custom).concat(p.id);
  else S.chosen = S.chosen.filter(id => id !== p.id);
  const order = S.cfg.placements.map(x => x.id);
  S.chosen.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const t of document.querySelectorAll('.tile')) t.setAttribute('aria-pressed', String(S.chosen.includes(t.dataset.id)));
  replan();
}

// ---------- planning ----------
function lengthForPlanning() {
  const src = S.video?.src;
  if (!src?.video) return null;
  const spot = spotLength(src.durationSec, src.video.fps, S.cfg.spotLengths);
  return spot ? spot.seconds : src.durationSec;
}

const tagOf = (p) => (p.tile?.title || p.short).split(/[\s/]+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '');

function replan() {
  const chosen = S.chosen.map(placement);
  S.files = planFiles(chosen, S.cfg, { lengthSec: lengthForPlanning() });
  const many = S.files.length > 1;
  for (const f of S.files) {
    // Names start from the video's name. When several files (or copies) are made, each
    // ends with the placements it is for, so none replaces another.
    const slots = nameSlots(f);
    f.slots = slots.map(slot => {
      const id = f.key + '|' + slot.key;
      const forTag = f.members.filter(p => slot.for.includes(p.short)).map(tagOf).join('-');
      const dflt = S.video?.baseName ? (many || slots.length > 1 ? `${S.video.baseName}_${forTag}` : S.video.baseName) : '';
      return { ...slot, id, name: S.names[id] ?? dflt };
    });
    f.desc = describeFile(f, S.cfg, S.video, S.custom[f.key] || {});
    f.asIs = checkSource(f, S.cfg, S.video); // is the video already good to go for this file?
  }
  renderFiles();
}

const extOf = (f) => f.desc?.settings?.container || S.cfg.formats[f.rules?.format]?.container || 'mp4';

// A file whose video already meets its spec is not made, unless the person asks for it.
const goodAsIs = (f) => !!f.asIs?.ok && !S.makeAnyway[f.key];
const toMake = () => S.files.filter(f => !goodAsIs(f));
// Name problems for the files that will be made (files kept as they are have no new name).
const nameProblems = () => checkNames(S.files.map(f => (goodAsIs(f) ? { ...f, slots: [] } : f)), extOf);

// ---------- 3. file slips ----------
function slipStatus(f, nameProblems) {
  if (S.busyKey === f.key) return ['run', 'Making it now'];
  const r = S.results[f.key];
  if (r) return r.status === 'pass' ? ['ok', 'Made'] : r.status === 'warn' ? ['warn', 'Made, look at the notes'] : ['bad', 'Made, with problems'];
  if (goodAsIs(f)) return ['ok', 'Already good to go'];
  if (f.desc.blocked) return ['bad', 'Cannot be made as is'];
  if (f.desc.waiting) return ['', 'Waiting for your video'];
  if (!S.video.analysis) return ['', 'Checking your video'];
  return ['need', 'New file needed'];
}

function renderFiles() {
  const n = S.files.length, m = S.chosen.length;
  $('files-intro').textContent = !n ? 'Choose at least one placement to see the files you need.'
    : n === 1 ? (m > 1 ? `One file covers all ${m} placements.` : 'One file.')
    : `${n} files for ${plural(m, 'placement', 'placements')}. Placements that can take the same file share one.`;
  const problems = nameProblems();
  $('slips').replaceChildren(...S.files.map((f, i) => slip(f, i, n, problems)));
  updateMake(problems);
}

function slip(f, i, n, problems) {
  const d = f.desc, names = f.members.map(p => p.short);
  const nameProblems = f.slots.map((_, j) => problems.get(`${i}:${j}`) || []);
  const [st, stText] = slipStatus(f, nameProblems);
  const node = el('article', { class: 'slip' + (st ? ' st-' + st : ''), 'data-key': f.key });

  node.append(el('div', { class: 'slip-head' },
    el('div', {},
      n > 1 ? el('p', { class: 'slip-of', text: `File ${i + 1} of ${n}` }) : null,
      el('h3', { class: 'slip-title', 'aria-label': 'For ' + joinNames(f.members.map(p => p.name)) }, f.members.map(p => { const b = badge(p); b.title = p.name; return b; }))),
    el('span', { class: 'status ' + st, text: stText })));

  node.append(readout(f));

  if (goodAsIs(f)) {
    node.append(asIsPanel(f));
  } else if (!d.waiting && f.rules) {
    if (f.asIs?.ok) node.append(el('div', { class: 'asis-undo' }, el('span', { class: 'hint', text: 'Your video is already good to go for this file; a new one will be made anyway.' }),
      el('button', { type: 'button', class: 'link', text: 'Use my video as it is', onclick: () => { delete S.makeAnyway[f.key]; replan(); } })));
    const list = (cls, items) => el('ul', { class: 'items ' + cls },
      items.map(x => el('li', { class: x.level || '' }, x.text, x.more ? el('small', { text: x.more }) : null)));
    node.append(changesTable(f));
    if (d.todo.length) node.append(el('div', { class: 'todo-box' }, el('h4', { text: 'Before you make it' }), list('todo', d.todo)));
    if (d.good.length) node.append(el('div', { class: 'good-box' }, el('h4', { text: 'Good to know' }), list('good', d.good)));

    node.append(el('div', { class: 'names' }, f.slots.map((slot, j) => nameRow(f, slot, j, i, nameProblems[j]))));
  } else if (f.rules) {
    node.append(el('div', { class: 'slip-body' }, el('p', { class: 'hint', style: 'margin:0', text: `Drop your video in step 1 to see exactly what will change for ${joinNames(names)}.` })));
  } else {
    node.append(el('div', { class: 'slip-body' }, el('ul', { class: 'items todo' }, d.todo.map(x => el('li', { class: 'bad' }, x.text)))));
  }

  const foot = el('div', { class: 'slip-foot' }, specNotes(f));
  if (f.rules && !d.waiting) {
    const zones = safeArea(f); if (zones) foot.append(zones);
    if (!goodAsIs(f)) foot.append(settingsPanel(f)); // nothing to set when nothing is made
  }
  node.append(foot);
  const run = el('div', { class: 'slip-run', id: 'run-' + i });
  if (S.results[f.key]) run.append(resultView(S.results[f.key]));
  node.append(run);
  return node;
}

// Your video next to the new file: what changes, row by row.
function changesTable(f) {
  const rows = f.desc.diff || [];
  const who = joinNames(f.members.map(p => p.short));
  const sub = S.video.analysis ? `Your video doesn\u2019t meet ${who}\u2019s spec as it is. When you click Make, the tool makes a new file with these changes:`
    : 'The full list of changes appears when the check of your video finishes.';
  return el('div', { class: 'changes' },
    el('p', { class: 'changes-line', text: `A new file is needed for ${who}.` }),
    el('p', { class: 'changes-sub', text: sub }),
    el('table', { class: 'diff' },
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }), el('th', { scope: 'col', text: 'Your video' }), el('th', { scope: 'col', 'aria-label': 'becomes' }), el('th', { scope: 'col', text: 'New file' }))),
      el('tbody', {}, rows.map(r => el('tr', {},
        el('th', { scope: 'row', text: r.label }),
        el('td', { class: 'from', text: r.from }),
        el('td', { class: 'arrow', 'aria-hidden': 'true', text: '\u2192' }),
        el('td', { class: 'to' }, r.to, r.note ? el('small', { text: r.note }) : null))))));
}

// The video already meets this file's spec: say so plainly, and that nothing more is needed.
function asIsPanel(f) {
  const who = joinNames(f.members.map(p => p.short));
  const name = S.video.file.name;
  const renames = f.slots.map(slot => ({ slot, r: checkName(name, slot.rule) })).filter(x => x.r && !x.r.ok);
  return el('div', { class: 'asis' },
    el('p', { class: 'asis-line', text: `Your video is already good to go for ${who}.` }),
    el('p', { class: 'asis-sub' }, 'It meets the spec as it is, so you don\u2019t need to make a new file. Send ', el('b', { text: name }), ' as it is.'),
    renames.length ? el('ul', { class: 'items todo' }, renames.map(({ slot, r }) => el('li', { class: 'warn' },
      `The file name doesn\u2019t match ${joinNames(slot.for)}\u2019s naming rule. Rename it before you send it.`,
      el('small', { text: `${joinNames(slot.for)} ${slot.for.length > 1 ? 'need' : 'needs'} ${r.expected}${slot.rule.example ? ', for example ' + slot.rule.example : ''}.` })))) : null,
    el('button', { type: 'button', class: 'ghost small', text: 'Make a new file anyway', onclick: () => { S.makeAnyway[f.key] = true; replan(); } }));
}

function readout(f) {
  const d = f.desc, a = f.rules;
  if (!a) return el('div', { class: 'readout' }, el('span', { class: 'hint', text: f.why ? 'Why: ' + f.why : '' }));
  if (d.waiting) {
    const fr = a.frameRates ? a.frameRates.map(fmtFps).join(' or ') + ' fps' : 'your video\'s own';
    return el('div', { class: 'readout' }, el('dl', { class: 'specs' },
      el('dt', { text: 'File type' }), el('dd', { text: d.format }),
      el('dt', { text: 'Picture' }), el('dd', { text: a.shortEdge ? `${a.shortEdge}p, your video's shape` : 'your video\'s size' }),
      el('dt', { text: 'Frame rate' }), el('dd', { text: fr }),
      el('dt', { text: 'Video' }), el('dd', { text: a.videoOut ? mbps(a.videoOut) : 'ProRes' })));
  }
  if (goodAsIs(f)) { // describe the video itself: it is what gets sent
    const src = S.video.src, v = src.video, tc = timecode(src.durationSec, v.fps);
    return el('div', { class: 'readout' },
      el('div', { class: 'tc', title: 'Length in broadcast timecode (hours:minutes:seconds:frames)' },
        el('span', { class: 't' }, tc.hms, el('span', { class: 'ff', text: ':' + tc.ff })),
        el('span', { class: 'u', text: `${tc.frames} frames at ${fmtFps(v.fps)} fps, your video as it is` })),
      el('dl', { class: 'specs' },
        el('dt', { text: 'File type' }), el('dd', { text: v.codec === 'h264' ? `${String(src.container).toUpperCase()} (H.264)` : v.codec === 'prores' ? 'ProRes MOV' : v.codec }),
        el('dt', { text: 'Picture' }), el('dd', { text: `${v.width} x ${v.height}` }),
        el('dt', { text: 'Frame rate' }), el('dd', { text: fmtFps(v.fps) + ' fps' }),
        el('dt', { text: 'Video' }), el('dd', { text: v.codec === 'prores' ? 'ProRes' : v.kbps ? mbps(v.kbps) : v.codec }),
        el('dt', { text: 'File size' }), el('dd', { text: fmtBytes(S.video.file.size) })));
  }
  const t = d.t, tc = timecode(d.lengthSec, t.fps), s = d.settings;
  const tail = s.tailBlackSec ? `, including ${s.tailBlackSec} s of black` : '';
  return el('div', { class: 'readout' },
    el('div', { class: 'tc', title: 'Length in broadcast timecode (hours:minutes:seconds:frames)' },
      el('span', { class: 't' }, tc.hms, el('span', { class: 'ff', text: ':' + tc.ff })),
      el('span', { class: 'u', text: `${tc.frames} frames at ${fmtFps(t.fps)} fps${tail}` })),
    el('dl', { class: 'specs' },
      el('dt', { text: 'File type' }), el('dd', { text: d.format }),
      el('dt', { text: 'Picture' }), el('dd', { text: `${t.w} x ${t.h}` }),
      el('dt', { text: 'Frame rate' }), el('dd', { text: fmtFps(t.fps) + ' fps' }),
      el('dt', { text: 'Video' }), el('dd', { text: s.vcodec === 'prores' ? 'ProRes ' + (s.proresProfile === 'hq' ? '422 HQ' : '422') : mbps(s.bitrateKbps) }),
      el('dt', { text: 'File size' }), el('dd', { text: 'about ' + fmtBytes(d.estBytes) })));
}

function nameRow(f, slot, j, i, probs) {
  const ext = '.' + extOf(f);
  const input = el('input', { type: 'text', value: slot.name, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'File name' + (f.slots.length > 1 ? ' for ' + joinNames(slot.for) : '') });
  const msg = el('div', { class: 'name-msg-wrap' });
  const paint = (list) => msg.replaceChildren(...(list.length ? list : (slot.rule?.note ? [{ level: 'rule', text: slot.rule.note }] : []))
    .map(x => el('div', { class: 'name-msg ' + x.level, text: x.text })));
  paint(probs);
  input.addEventListener('input', () => {
    S.names[slot.id] = input.value; slot.name = input.value;
    const problems = nameProblems();
    // repaint every name message (a duplicate elsewhere may have cleared) without redrawing the inputs
    document.querySelectorAll('.slip').forEach((node, fi) => node.querySelectorAll('.name-row').forEach((row, sj) => row._paint?.(problems.get(`${fi}:${sj}`) || [])));
    S.files.forEach((ff, fi) => {
      const [st, txt] = slipStatus(ff, ff.slots.map((_, sj) => problems.get(`${fi}:${sj}`) || []));
      const node = document.querySelectorAll('.slip')[fi]; if (!node) return;
      node.className = 'slip' + (st ? ' st-' + st : '');
      const chip = node.querySelector('.status'); chip.className = 'status ' + st; chip.textContent = txt;
    });
    updateMake(problems);
  });
  const row = el('div', { class: 'name-row' },
    el('label', {}, 'File name', f.slots.length > 1 ? el('span', { class: 'for', text: ' for ' + joinNames(slot.for) }) : null),
    el('div', { class: 'name-field' }, input, el('span', { class: 'ext', text: ext })), msg);
  row._paint = paint;
  return row;
}

function specNotes(f) {
  return el('details', {}, el('summary', { text: f.members.length > 1 ? 'Spec sheet notes for these placements' : 'Spec sheet notes' }),
    el('ul', { class: 'spec-list' }, f.members.map(p => el('li', {},
      el('b', { text: p.name }),
      p.custom ? null : el('span', { class: 'conf ' + (p.status === 'verified' ? 'yes' : 'no'), text: p.status === 'verified' ? 'Confirmed ' + (p.verifiedDate || '') : 'Not yet confirmed with the placement' }),
      el('div', { class: 'src' }, 'Source: ', p.source?.url ? el('a', { href: p.source.url, target: '_blank', rel: 'noopener', text: p.source.label || p.source.url }) : (p.source?.label || 'none')),
      p.notes?.length ? el('ul', {}, p.notes.map(t => el('li', { text: t }))) : null))));
}

// The placements' documented safe areas, drawn on a frame from your video.
function safeArea(f) {
  const thumbs = S.video?.analysis?.thumbs; if (!thumbs?.length) return null;
  const v = S.video.src.video;
  const zones = f.members.flatMap(p => (p.safeZones || []).map(z => ({ ...z, label: `${p.short}: ${z.label}` })))
    .filter(z => Math.abs(v.width / v.height - z.refW / z.refH) / (z.refW / z.refH) < 0.01);
  if (!zones.length) return null;
  const frame = el('div', { class: 'zone-frame' }, el('img', { src: (thumbs[1] || thumbs[0]).url, alt: 'A frame from your video' }),
    zones.map(z => el('div', { class: 'zone ' + (z.type === 'safe' ? 'safe' : 'avoid'), title: z.label,
      style: `left:${100 * z.x / z.refW}%;top:${100 * z.y / z.refH}%;width:${100 * z.w / z.refW}%;height:${100 * z.h / z.refH}%` })));
  return el('details', {}, el('summary', { text: 'Check the safe area' }), frame,
    el('p', { class: 'hint', text: zones.map(z => (z.type === 'safe' ? 'Keep text inside the dashed line (' : 'Keep clear of the red box (') + z.label + ')').join('. ') + '. Check by eye; the tool cannot see text.' }));
}

// A few plain settings per file. Most people never open this.
function settingsPanel(f) {
  const c = S.custom[f.key] || {}, s = f.desc.settings, isCustom = f.members.some(p => p.custom);
  const set = (k, v) => { const x = { ...(S.custom[f.key] || {}) }; if (v === undefined) delete x[k]; else x[k] = v; S.custom[f.key] = x; delete S.results[f.key]; replan(); };
  const select = (label, value, options, onchange) => {
    const sel = el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t })));
    sel.value = value; sel.addEventListener('change', () => onchange(sel.value));
    return el('label', {}, label, sel);
  };
  const fields = [];
  if (isCustom) {
    fields.push(select('File type', `${s.container}-${s.vcodec}${s.vcodec === 'prores' ? '-' + s.proresProfile : ''}`,
      [['mp4-h264', 'MP4 (H.264)'], ['mov-h264', 'MOV (H.264)'], ['mov-prores-422', 'ProRes 422 MOV'], ['mov-prores-hq', 'ProRes 422 HQ MOV']],
      (v) => { const F = S.cfg.formats[v.replace(/-(422|hq)$/, '-$1')] || S.cfg.formats[v];
        const x = { ...(S.custom[f.key] || {}), container: F.container, vcodec: F.vcodec, acodec: F.acodec, proresProfile: F.proresProfile || 'hq', faststart: F.faststart, stripEditLists: F.stripEditLists };
        S.custom[f.key] = x; replan(); }));
  }
  const rates = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'];
  fields.push(select('Frame rate', c.fps ?? 'native', [['native', f.rules.frameRates ? 'Automatic (an accepted rate)' : 'Keep your video\'s rate'], ...rates.map(r => [r, r + ' fps'])],
    (v) => set('fps', v === 'native' ? undefined : v)));
  if (s.vcodec === 'h264') {
    const inp = el('input', { type: 'number', min: '500', max: '100000', step: '100', value: String(s.bitrateKbps) });
    inp.addEventListener('change', () => set('bitrateKbps', Number(inp.value) || undefined));
    fields.push(el('label', {}, 'Video bitrate (kbps)', inp));
  }
  fields.push(select('Light grain', c.noiseOn == null ? 'auto' : c.noiseOn ? 'on' : 'off', [['auto', 'Automatic'], ['on', 'On'], ['off', 'Off']],
    (v) => set('noiseOn', v === 'auto' ? undefined : v === 'on')));
  const loudNow = c.loudMode == null ? 'plan' : c.loudMode === 'off' ? 'off' : `${c.loudMode}:${c.loudTarget}:${c.loudPeak}`;
  const loudOpts = [['plan', f.rules.loudness ? 'As the placement asks' : 'Leave as it is (no rule given)'], ['off', 'Leave as it is']];
  if (isCustom || !f.rules.loudness) loudOpts.push(['lufs:-24:-2', 'Broadcast: -24 LKFS'], ['lufs:-14:-1', 'Streaming: -14 LUFS'], ['max:-12:-8', 'Cinema limits: -12 dB average, -8 dB peak']);
  fields.push(select('Sound level', loudNow, loudOpts, (v) => {
    const x = { ...(S.custom[f.key] || {}) };
    delete x.loudMode; delete x.loudTarget; delete x.loudPeak;
    if (v === 'off') x.loudMode = 'off';
    else if (v !== 'plan') { const [mode, tg, pk] = v.split(':'); Object.assign(x, { loudMode: mode, loudTarget: +tg, loudPeak: +pk }); }
    S.custom[f.key] = x; delete S.results[f.key]; replan();
  }));
  const changed = Object.keys(c).length;
  return el('details', { open: changed && isCustom ? true : null }, el('summary', { text: isCustom ? 'Choose the settings' : 'Change settings' + (changed ? ' (changed)' : '') }),
    el('div', { class: 'settings' }, fields,
      el('p', { class: 'hint', text: isCustom ? 'Custom files are checked against these settings only.' : 'Changing these can take the file outside a placement\'s spec. The report afterwards shows the result.' }),
      changed ? el('button', { type: 'button', class: 'ghost small', text: 'Undo my changes', onclick: () => { delete S.custom[f.key]; delete S.results[f.key]; replan(); } }) : null));
}

function updateMake(problems) {
  const n = S.files.length;
  $('make').hidden = !n;
  if (!n) return;
  const list = toMake(), idx = (f) => S.files.indexOf(f);
  const outs = list.reduce((k, f) => k + (f.slots?.length || 1), 0);
  const blocked = list.some(f => f.desc.blocked) || list.some(f => f.slots.some((_, j) => (problems.get(`${idx(f)}:${j}`) || []).some(x => x.level === 'bad')));
  const btn = $('btn-make');
  const nothing = !list.length;
  btn.hidden = nothing;
  btn.disabled = !(S.video?.src && S.video.analysis && !blocked && !S.running);
  btn.textContent = list.length === 1 ? (outs > 1 ? `Make the file (${outs} copies)` : 'Make the file') : `Make the ${list.length} files`;
  const kept = n - list.length;
  const total = list.reduce((k, f) => k + (f.desc.estBytes || 0) * (f.slots?.length || 1), 0);
  $('make-note').textContent = nothing ? `Nothing to make. Your video is already good to go for ${n === 1 ? 'this placement' : 'every file'}; just check the file name.`
    : !S.video?.src ? 'Drop your video in step 1 first.'
    : !S.video.analysis ? 'Waiting for the check of your video to finish.'
    : blocked ? 'Fix the items marked with a cross first.'
    : S.running ? 'Keep this tab open and in front while the files are made.'
    : `Makes ${plural(list.length, 'new file', 'new files')}: for ${joinNames(list.map(f => joinNames(f.members.map(p => p.short))))}. `
      + (kept ? `${joinNames(S.files.filter(goodAsIs).flatMap(f => f.members.map(p => p.short)))} ${S.files.filter(goodAsIs).flatMap(f => f.members).length > 1 ? 'need' : 'needs'} nothing: send your video as it is. ` : '') + (window.showSaveFilePicker && !window.__testSink
      ? `About ${fmtBytes(total)} in total. Next, your browser asks where to save ${outs === 1 ? 'the file' : 'them (pick a folder)'}.`
      : `About ${fmtBytes(total)} in total. ${outs === 1 ? 'It goes' : 'They go'} to your Downloads folder.`);
  $('btn-cancel').hidden = !S.running;
}

// ---------- progress ----------
function progressBox(where) {
  const what = el('div', { class: 'what' }), bar = el('div', { class: 'bar' }, el('i')), pct = el('span'), elapsed = el('span'), eta = el('span');
  const box = el('div', { class: 'progress', role: 'status', 'aria-live': 'polite' }, what, bar, el('div', { class: 'meta' }, pct, elapsed, eta));
  where.replaceChildren(box);
  const t0 = performance.now();
  const clock = setInterval(() => { elapsed.textContent = 'Elapsed ' + fmtTime((performance.now() - t0) / 1000); }, 500);
  let stage0 = 0;
  return {
    set(text, ratio) {
      what.textContent = text;
      bar.classList.toggle('indet', ratio == null);
      bar.firstElementChild.style.width = ratio == null ? '' : Math.round(ratio * 100) + '%';
      pct.textContent = ratio == null ? '' : Math.round(ratio * 100) + '%';
    },
    // A callback for passes that report "seconds of video done".
    timed(text, duration) {
      const s0 = performance.now(); stage0 = s0; this.set(text, 0); eta.textContent = 'Time left: estimating';
      return (sec) => {
        const r = Math.min(1, sec / duration), e = (performance.now() - s0) / 1000;
        this.set(text, r);
        eta.textContent = r > 0.02 && e > 5 ? 'Time left: about ' + fmtTime(e / r - e) : 'Time left: estimating';
      };
    },
    noEta() { eta.textContent = ''; },
    done() { clearInterval(clock); box.remove(); }
  };
}

async function ensureEngine(prog) {
  if (engine.ready) return;
  prog.set('Loading the encoder (the first visit downloads about 31 MB, then it is kept)', null);
  await engine.load((got, tot, cached) => { if (tot) prog.set('Loading the encoder' + (cached ? '' : ' (first visit only)'), got / tot); });
}

// ---------- 1. video ----------
function setupDrop() {
  const drop = $('drop'), input = $('file');
  const pickFile = () => { if (!S.running) input.click(); };
  drop.addEventListener('click', pickFile);
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); } });
  $('vc-replace').addEventListener('click', pickFile);
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0]); input.value = ''; });
  const zone = document.body;
  ['dragenter', 'dragover'].forEach(e => zone.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => zone.addEventListener(e, (ev) => { ev.preventDefault(); if (e === 'drop' || ev.target === document.body) drop.classList.remove('over'); }));
  zone.addEventListener('drop', (ev) => {
    const files = ev.dataTransfer?.files; if (!files?.length) return;
    if (files.length > 1) videoMsg('warn', 'One video at a time. Using the first one: ' + files[0].name);
    loadFile(files[0]);
  });
}

function videoMsg(level, text) { $('video-msg').replaceChildren(...(text ? [el('div', { class: 'msg ' + level, text })] : [])); }

async function loadFile(file) {
  if (S.running) return;
  videoMsg('', '');
  if (!/\.(mov|mp4|m4v)$/i.test(file.name) && !/^video\//.test(file.type)) { videoMsg('bad', `${file.name} does not look like a video. Use a MOV or MP4 file.`); return; }
  if (file.size === 0) { videoMsg('bad', `${file.name} is empty. If it is in a OneDrive or SharePoint folder, wait for it to finish downloading, then try again.`); return; }
  clearResults();
  S.video = { file, src: null, analysis: null,
    baseName: file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) };
  S.names = {};
  $('drop').hidden = true; $('video-card').hidden = false; $('vc-body').hidden = true;
  $('vc-name').textContent = file.name; $('vc-size').textContent = fmtBytes(file.size);
  $('vc-facts').replaceChildren(); $('vc-thumbs').replaceChildren(); $('vc-tech').replaceChildren();
  replan();
  S.running = true; updateMake(new Map());
  const prog = progressBox($('vc-progress'));
  try {
    await ensureEngine(prog);
    prog.set('Reading the file', null);
    S.video.src = summarize(await engine.probe(file));
    if (!S.video.src.video) throw new Error('No video picture was found in this file.');
    renderTech(); replan();
    const src = S.video.src, st = S.cfg.strictness, path = await engine.mountForEncode(file);
    const analysis = { audio: null, video: null, thumbs: [] };
    if (src.audio) { prog.set('Measuring the sound', null); analysis.audio = await measureAudio(engine, path); }
    analysis.video = await scanVideo(engine, path, src.video.fps, st.dupDiffThreshold, pixDepth(src.video.pixFmt), prog.timed('Looking at every frame', src.durationSec));
    prog.noEta(); prog.set('Taking three frames to show you', null);
    analysis.thumbs = await grabFrames(engine, path, src.durationSec);
    S.video.analysis = analysis;
  } catch (e) {
    if (!S.cancelled) videoMsg('bad', friendlyError(e));
    if (!S.video.src) { $('video-card').hidden = true; $('drop').hidden = false; S.video = null; }
  } finally {
    prog.done(); S.running = false; S.cancelled = false;
    if (S.video?.src) renderFacts();
    replan();
  }
}

function renderFacts() {
  const v = S.video.src.video, src = S.video.src, a = S.video.analysis, st = S.cfg.strictness;
  const tc = timecode(src.durationSec, v.fps);
  const facts = [['Length', `${src.durationSec.toFixed(2)} s (${tc.hms}:${tc.ff})`], ['Picture', `${v.width} x ${v.height}, ${aspectLabel(v.width, v.height)}`], ['Frame rate', fmtFps(v.fps) + ' fps']];
  if (!src.audio) facts.push(['Sound', 'none']);
  else if (a?.audio?.silent) facts.push(['Sound', 'silent']);
  else if (a?.audio) facts.push(['Sound', `average ${a.audio.rms.toFixed(1)} dB, peak ${a.audio.samplePeak.toFixed(1)} dB`]);
  if (a?.video) {
    const d = a.video.dups;
    facts.push(['Repeated frames', d.percent > st.dupPassPercent ? `${d.percent.toFixed(1)}% (longest ${d.longestRunSec.toFixed(1)} s)` : 'none']);
    facts.push(['Black bars', describeBars(a.video.crop, v.width, v.height, st.barTolerancePx) || 'none']);
    const ends = describeBlackEnds(a.video.black, src.durationSec);
    if (ends.start || ends.end) facts.push(['Black frames', [ends.start ? `${ends.start.toFixed(1)} s at the start` : '', ends.end ? `${ends.end.toFixed(1)} s at the end` : ''].filter(Boolean).join(', ')]);
    if (a.video.idet && a.video.idet.interlacedPercent >= 5) facts.push(['Scan', 'interlaced']);
  }
  $('vc-facts').replaceChildren(...facts.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })]));
  $('vc-thumbs').replaceChildren(...(a?.thumbs || []).map(t => el('figure', {}, el('img', { src: t.url, alt: t.label }), el('figcaption', { text: t.label }))));
  $('vc-body').hidden = false;
}

function renderTech() {
  const s = S.video.src, v = s.video, a = s.audio;
  const rows = [['Container', s.container.toUpperCase()], ['Video', v.codec + (v.profile ? ' (' + v.profile + ')' : '') + ', ' + fmtKbps(v.kbps) + (v.kbpsEstimated ? ' (estimated)' : '')],
    ['Pixels', v.pixFmt + (v.bitDepth ? ', ' + v.bitDepth + '-bit' : '')], ['Frame rate type', v.cfrLikely === false ? 'possibly variable' : 'constant'],
    ['Colour tags', [v.colorSpace, v.colorPrimaries, v.colorTransfer].filter(Boolean).join(' / ') || 'none'],
    ['Audio', a ? `${a.codec}, ${a.sampleRate / 1000} kHz, ${a.channels} channels` + (a.kbps ? ', ' + Math.round(a.kbps) + ' kbps' : '') : 'none'],
    ['Tracks', `${s.videoCount} video, ${s.audioCount} audio` + (s.otherCount ? `, ${s.otherCount} other (ignored)` : '')]];
  $('vc-tech').replaceChildren(...rows.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })]));
  $('vc-facts').replaceChildren(el('dt', { text: 'Length' }), el('dd', { text: s.durationSec.toFixed(2) + ' s' }), el('dt', { text: 'Picture' }), el('dd', { text: `${v.width} x ${v.height}` }), el('dt', { text: 'Frame rate' }), el('dd', { text: fmtFps(v.fps) + ' fps' }));
  $('vc-body').hidden = false;
}

// ---------- making the files ----------
const MIME = { mp4: 'video/mp4', mov: 'video/quicktime' };

async function onMake() {
  if (S.running || !S.files.length) return;
  $('make-msg').replaceChildren();
  clearResults();
  const list = toMake();
  if (!list.length) return;
  const outs = list.flatMap(f => f.slots.map(slot => slot.name.trim() + '.' + extOf(f)));
  // Ask where to save BEFORE the long work (it needs this click). One file: "Save as". Several: a folder.
  const target = { handle: null, dir: null };
  if (!window.__testSink && outs.length === 1 && window.showSaveFilePicker) {
    const ext = extOf(list[0]);
    try { target.handle = await window.showSaveFilePicker({ suggestedName: outs[0], types: [{ description: 'Video', accept: { [MIME[ext]]: ['.' + ext] } }] }); }
    catch (e) { if (e.name === 'AbortError') { makeMsg('info', 'No save location chosen, so nothing was made.'); return; } }
  } else if (!window.__testSink && outs.length > 1 && window.showDirectoryPicker) {
    try {
      target.dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const existing = [];
      for (const nm of outs) { try { await target.dir.getFileHandle(nm); existing.push(nm); } catch (e) { /* not there */ } }
      if (existing.length && !window.confirm('These files are already in that folder and would be replaced:\n\n' + existing.join('\n') + '\n\nReplace them?')) { makeMsg('info', 'Nothing was made. Choose another folder or change the names.'); return; }
    } catch (e) {
      if (e.name === 'AbortError') { makeMsg('info', 'No folder chosen, so nothing was made.'); return; }
      target.dir = null; // fall back to normal downloads
    }
  }
  S.running = true; S.making = true; S.cancelled = false;
  for (const t of document.querySelectorAll('.tile')) t.disabled = true;
  try {
    for (let k = 0; k < list.length && !S.cancelled; k++) {
      const f = list[k], i = S.files.indexOf(f);
      S.busyKey = f.key; renderFiles();
      document.querySelector(`.slip[data-key="${CSS.escape(f.key)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try { S.results[f.key] = await makeOne(f, i, target, k, list.length); }
      catch (e) { if (!S.cancelled) S.results[f.key] = { status: 'fail', error: friendlyError(e), rows: [], notes: [] }; }
      S.busyKey = null;
    }
  } finally {
    S.running = false; S.making = false; S.busyKey = null;
    for (const t of document.querySelectorAll('.tile')) t.disabled = false;
    renderFiles();
    if (S.cancelled) makeMsg('info', 'Stopped. Files already finished were saved; the one in progress was not.');
    S.cancelled = false;
  }
}

async function makeOne(f, i, target, k = 0, count = 1) {
  const s = f.desc.settings, src = S.video.src, ext = s.container, memName = 'out.' + ext;
  const pre = count > 1 ? `File ${k + 1} of ${count}: ` : '';
  const prog = progressBox(document.getElementById('run-' + i));
  try {
    await ensureEngine(prog);
    const path = await engine.mountForEncode(S.video.file);
    const leveling = s.loudMode !== 'off' && !!src.audio;
    let audioFilter = null, levelInfo = '';
    if (leveling) ({ filter: audioFilter, info: levelInfo } = await planLeveling(engine, path, s, prog.timed(pre + 'measuring the sound', src.durationSec)));
    const t = targetFormat(s, src);
    const spot = spotLength(outDuration(src, t), t.fps, S.cfg.spotLengths);
    const { args, notes } = buildArgs(s, src, path, memName, { audioFilter, spot });
    await engine.encode(args, prog.timed(pre + 'making it', f.desc.lengthSec)); // the new file's length (CTV adds 10 s)

    const extra = {};
    if (leveling) { prog.set(pre + 'checking the sound', null); extra.audio = await measureAudio(engine, memName); }
    if (s.dupCheck) extra.video = await scanVideo(engine, memName, t.fps, S.cfg.strictness.dupDiffThreshold, s.vcodec === 'prores' ? 10 : 8, prog.timed(pre + 'checking every frame', f.desc.lengthSec));
    prog.noEta(); prog.set(pre + 'checking the file', null);
    let data = await engine.takeOutput(memName);
    const blob = new Blob([data], { type: MIME[ext] }); data = null;
    const out = summarize(await engine.probe(blob, '.' + ext)); out.sizeBytes = blob.size;

    prog.set(pre + 'saving', null);
    const saved = [];
    for (const slot of f.slots) {
      const name = slot.name.trim() + '.' + ext;
      const handle = target.dir ? await target.dir.getFileHandle(name, { create: true }) : (f.slots.length === 1 && count === 1 ? target.handle : null);
      saved.push({ name, ...(await saveOutput(blob, name, handle, !!target.dir)) });
    }
    const source = { ...src, dupPercent: S.video.analysis?.video?.dups?.percent, conversion: S.video.analysis?.video?.dups?.conversion };
    const rows = verify(out, s, reportSpec(f), { source, fileName: null, strictness: S.cfg.strictness, extra, spot, tail: s.tailBlackSec || 0 });
    for (const slot of f.slots) {
      const r = checkName(slot.name.trim() + '.' + ext, slot.rule);
      if (r) rows.push({ label: 'File name' + (f.slots.length > 1 ? ' for ' + joinNames(slot.for) : ''), expected: r.expected, actual: r.actual, status: r.ok ? 'pass' : 'warn', note: r.ok ? '' : slot.rule.note || '' });
    }
    const where = saved.some(x => x.how === 'download') ? 'Downloaded to your Downloads folder as' : target.dir ? 'Saved in the folder you chose, as' : 'Saved where you chose, as';
    return { status: overall(rows), rows, notes: [...f.desc.changes.map(c => c.text + '.'), ...notes, ...(levelInfo ? [levelInfo] : [])], saved, where, members: f.members.map(p => p.short) };
  } finally { prog.done(); }
}

function resultView(r) {
  if (r.error) return el('div', { class: 'result bad' }, el('div', { class: 'line', text: 'This file could not be made.' }), el('div', { class: 'msg bad', text: r.error }));
  const count = (st) => r.rows.filter(x => x.status === st).length;
  const who = joinNames(r.members);
  const line = r.status === 'pass' ? `Made and checked. It meets ${r.members.length > 1 ? 'the spec for ' + who : who + "'s spec"}.`
    : r.status === 'warn' ? `Made. ${plural(count('warn'), 'thing', 'things')} to look at before you send it.`
    : `Made, but ${plural(count('fail'), 'check', 'checks')} failed. ${who} may reject it.`;
  const issues = r.rows.filter(x => x.status === 'fail' || x.status === 'warn');
  return el('div', { class: 'result ' + (r.status === 'pass' ? 'ok' : r.status === 'warn' ? 'warn' : 'bad') },
    el('div', { class: 'line', text: line }),
    el('div', { class: 'saved' }, el('span', {}, r.where + ' ', el('b', { text: r.saved.map(x => x.name).join(', ') })),
      el('div', { class: 'row' }, r.saved.filter(x => x.url).map(x => el('button', { type: 'button', class: 'primary small', text: r.saved.length > 1 ? 'Download ' + x.name : 'Download a copy', onclick: () => triggerDownload(x.url, x.name) })))),
    issues.length ? el('ul', { class: 'items todo' }, issues.map(x => el('li', { class: x.status === 'fail' ? 'bad' : 'warn' }, `${x.label}: ${x.actual}` + (x.expected ? ` (should be ${x.expected})` : ''), x.note ? el('small', { text: x.note }) : null))) : null,
    el('details', {}, el('summary', { class: 'hint', text: `Full report (${r.rows.length} checks)` }),
      el('table', { class: 'report' }, el('thead', {}, el('tr', {}, ['Check', 'Expected', 'Result', '', 'Note'].map(h => el('th', { text: h })))),
        el('tbody', {}, r.rows.map(x => el('tr', {}, el('td', { text: x.label }), el('td', { text: x.expected }), el('td', { text: x.actual }),
          el('td', {}, el('span', { class: 'tag ' + x.status, text: x.status === 'pass' ? 'OK' : x.status.toUpperCase() })), el('td', { text: x.note || '' }))))),
      r.notes.length ? el('ul', { class: 'hint' }, r.notes.map(t => el('li', { text: t }))) : null),
    el('p', { class: 'hint', style: 'margin:0', text: 'This checks the file against the published spec. Have someone review it before it is sent.' }));
}

// Saves the file where the person chose (Edge and Chrome), or as a normal download.
// Either way a download link is kept, so a copy can be saved again from the file's slip.
async function saveOutput(blob, name, handle) {
  const url = URL.createObjectURL(blob); S.blobUrls.push(url);
  if (window.__testSink) { await window.__testSink(blob, name); return { url, how: 'test' }; }
  if (handle) { const w = await handle.createWritable(); await w.write(blob); await w.close(); return { url, how: 'chosen' }; }
  triggerDownload(url, name);
  return { url, how: 'download' };
}
function triggerDownload(url, name) { const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); }

function clearResults() { S.results = {}; for (const u of S.blobUrls) URL.revokeObjectURL(u); S.blobUrls = []; }
function makeMsg(level, text) { $('make-msg').replaceChildren(el('div', { class: 'msg ' + level, text })); }

function onCancel() { S.cancelled = true; engine.cancel(); }

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/out of memory|memory access|alloc|RangeError|detached/i.test(m))
    return 'The browser ran out of memory. Close other tabs and programs and try again, or use desktop software for this file.\n\nDetails: ' + m.slice(0, 300);
  return m.slice(0, 600);
}

// ---------- safety nets ----------
function setupGuards() {
  window.addEventListener('beforeunload', (ev) => { if (S.running) { ev.preventDefault(); ev.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (S.running && document.hidden) makeMsg('info', 'This tab is in the background. Browsers slow background tabs, so the work may pause until you come back.');
  });
  const unexpected = (ev) => { if (S.running) return; makeMsg('bad', 'Something unexpected went wrong: ' + friendlyError(ev.reason || ev.error || ev)); };
  window.addEventListener('unhandledrejection', unexpected);
  window.addEventListener('error', unexpected);
}

// ---------- start-up ----------
async function init() {
  setupTheme();
  const msgs = $('browser-msg');
  if (!window.WebAssembly || !window.Worker) { msgs.append(el('div', { class: 'msg bad', text: 'This browser cannot run the encoder. Use a current version of Edge or Chrome.' })); return; }
  const ua = navigator.userAgent;
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) msgs.append(el('div', { class: 'msg warn', text: 'Safari has not been tested. If anything fails, use Edge or Chrome.' }));
  else if (!window.showSaveFilePicker) msgs.append(el('div', { class: 'msg info', text: 'This browser saves finished files as normal downloads. Edge and Chrome can save large files more safely.' }));
  try { S.cfg = await (await fetch('placements.json', { cache: 'no-cache' })).json(); }
  catch (e) { msgs.append(el('div', { class: 'msg bad', text: 'Could not read placements.json. Open this page through its web address, not by double-clicking the file. ' + e })); return; }
  buildTiles();
  setupDrop();
  setupGuards();
  $('btn-make').addEventListener('click', onMake);
  $('btn-cancel').addEventListener('click', onCancel);
  replan();
  window.__app = { S, loadFile, onTile: (id) => onTile(placement(id)), onMake, replan, engine }; // for testing
}
init();
