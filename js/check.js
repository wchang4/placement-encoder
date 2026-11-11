// check.js
// The placement list check page: validates placements.json, shows which placements can
// share a file, and lets a new entry be tried before it is added.
import { planFiles, validatePlacement, whyApart } from './plan.js';
import { fmtFps } from './media.js';

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const joinAnd = (a) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const badge = (p) => el('span', { class: 'word', style: `--brand:${p.tile?.color || '#4f5866'}`, text: p.tile?.title || p.short || p.id });
const mbps = (k) => (k / 1000).toFixed(1).replace(/\.0$/, '') + ' Mbps';

let cfg;

// One line describing a file's rules, in words.
function fileWords(f) {
  if (!f.rules) return 'Cannot be made: ' + f.why;
  const a = f.rules, parts = [cfg.formats[a.format].label];
  if (a.videoOut) parts.push(mbps(a.videoOut));
  parts.push(a.frameRates ? a.frameRates.map(fmtFps).join(' or ') + ' fps' : 'own frame rate');
  parts.push(a.sampleRate / 1000 + ' kHz');
  if (a.loudness) parts.push(a.loudness.mode === 'max' ? `sound no louder than ${a.loudness.average} dB` : a.loudness.mode === 'lufs' ? `sound at ${a.loudness.target} LKFS` : `sound at ${a.loudness.target} dB average`);
  if (a.tailBlackSec) parts.push(`${a.tailBlackSec} s of black at the end`);
  if (a.maxSizeMB) parts.push(`under ${a.maxSizeMB} MB`);
  return parts.join(', ');
}

function renderAll() {
  const list = cfg.placements.filter(p => !p.custom);
  $('all').replaceChildren(...list.map(p => {
    const v = validatePlacement(p, cfg);
    const shares = list.filter(q => q !== p && !whyApart(p, q, cfg)).map(q => q.short);
    return el('div', { class: 'pl' },
      el('div', { class: 'who' }, badge(p), el('span', { class: 'hint', text: p.id })),
      el('div', {},
        el('p', {}, el('b', { text: p.name }), ' ', v.errors.length ? el('span', { class: 'bad-t', text: `${v.errors.length} to fix` }) : el('span', { class: 'ok-t', text: 'Complete' })),
        v.errors.length ? el('ul', {}, v.errors.map(e => el('li', { class: 'bad-t', text: e }))) : null,
        v.rules ? el('p', { class: 'hint', text: 'On its own: ' + fileWords({ rules: v.rules }) + '.' }) : null,
        el('p', { class: 'hint', text: shares.length ? 'Can share a file with ' + joinAnd(shares) + '.' : 'Always gets its own file.' }),
        v.gaps.length ? el('p', { class: 'warn-t', text: 'Assumed: ' + v.gaps.join(' ') }) : null,
        el('p', { class: 'hint', text: 'Source: ' + (p.source?.label || 'none') + (p.status === 'verified' ? '' : ' (not yet confirmed)') }))
    );
  }));
}

function renderCombo() {
  const boxes = cfg.placements.filter(p => !p.custom).map(p => {
    const cb = el('input', { type: 'checkbox', value: p.id });
    cb.addEventListener('change', planCombo);
    return el('label', {}, cb, p.short);
  });
  $('combo').replaceChildren(...boxes);
}
function planCombo() {
  const ids = [...document.querySelectorAll('#combo input:checked')].map(c => c.value);
  const files = planFiles(ids.map(id => cfg.placements.find(p => p.id === id)), cfg, { lengthSec: +$('len').value });
  $('combo-out').replaceChildren(...files.map((f, i) => el('li', {}, el('b', { text: `File ${i + 1}: ` + joinAnd(f.members.map(p => p.short)) }), el('div', { class: 'hint', text: fileWords(f) }))));
}

const TEMPLATE = {
  id: 'new-placement',
  name: 'New placement: what it is',
  short: 'New placement',
  tile: { title: 'New', sub: 'Where the ad runs', color: '#4f5866', logo: '' },
  status: 'unverified',
  verifiedDate: '',
  source: { label: 'Spec sheet name and date', url: '' },
  accepts: {
    formats: ['mp4-h264'],
    shortEdge: 1080,
    frameRates: [23.976, 29.97],
    videoKbps: { min: 10000, max: 40000 },
    maxSizeMB: null,
    sampleRates: [48000],
    audioKbps: { min: 192 },
    audioRequired: true,
    loudness: { mode: 'lufs', target: -24, peak: -2 },
    tailBlackSec: 0
  },
  notes: ['Anything from the spec sheet that a person should know.']
};

function tryDraft() {
  const out = $('try-out');
  let p;
  try { p = JSON.parse($('draft').value); }
  catch (e) { out.replaceChildren(el('div', { class: 'msg bad', text: 'This is not valid JSON yet: ' + e.message + '. Check for a missing comma or quote.' })); return; }
  // Drop nulls so "maxSizeMB": null means "no limit".
  if (p.accepts) for (const k of Object.keys(p.accepts)) if (p.accepts[k] == null) delete p.accepts[k];
  const len = +$('len').value;
  const v = validatePlacement(p, cfg);
  const msgs = [];
  if (v.errors.length) msgs.push(el('div', { class: 'msg bad', text: 'To fix:\n' + v.errors.map(e => '- ' + e).join('\n') }));
  else msgs.push(el('div', { class: 'msg info', text: 'Complete. On its own it would be: ' + fileWords({ rules: v.rules }) + '.' }));
  if (v.gaps.length) msgs.push(el('div', { class: 'msg warn', text: 'Assumed (check these are right):\n' + v.gaps.map(e => '- ' + e).join('\n') }));
  const others = cfg.placements.filter(q => !q.custom && q.id !== p.id);
  const same = others.filter(q => (q.tile?.title || '').toLowerCase() === (p.tile?.title || '').toLowerCase() || q.short.toLowerCase() === (p.short || '').toLowerCase());
  if (same.length) msgs.push(el('div', { class: 'msg warn', text: `This looks like an existing tile (${joinAnd(same.map(q => q.name))}). If it is a new spec for the same placement, replace that entry. If it is a different product from the same company, give it a different tile subtitle so people can tell them apart.` }));
  if (cfg.placements.some(q => q.id === p.id)) msgs.push(el('div', { class: 'msg warn', text: `The id "${p.id}" is already used. Pick a new one, or this entry replaces the existing one.` }));
  if (!v.errors.length) {
    const shares = others.filter(q => !whyApart(p, q, cfg, len)).map(q => q.short);
    const apart = others.filter(q => whyApart(p, q, cfg, len)).map(q => `${q.short}: ${whyApart(p, q, cfg, len)}`);
    msgs.push(el('div', { class: 'msg info', text: (shares.length ? 'Can share a file with ' + joinAnd(shares) + '.' : 'Would always get its own file.') + (apart.length ? '\n\nCannot share with:\n' + apart.map(x => '- ' + x).join('\n') : '') }));
    // What changes when everything is chosen together
    const before = planFiles(others, cfg, { lengthSec: len });
    const after = planFiles([...others, p], cfg, { lengthSec: len });
    const home = after.find(f => f.members.includes(p));
    const was = home && before.find(f => home.members.filter(m => m !== p).every(m => f.members.includes(m)) && f.members.length === home.members.length - 1);
    let effect = `With every placement chosen at once: ${before.length} files before, ${after.length} after.`;
    if (home && home.members.length > 1) {
      effect += `\nIt joins the file for ${joinAnd(home.members.filter(m => m !== p).map(m => m.short))}.`;
      if (was) {
        const a = fileWords(was), b = fileWords(home);
        effect += a === b ? '\nThat file does not change.' : `\nThat file changes from:\n  ${a}\nto:\n  ${b}`;
      }
    } else effect += '\nIt gets its own file.';
    msgs.push(el('div', { class: 'msg info', text: effect }));
  }
  out.replaceChildren(...msgs);
}

function setupTheme() {
  const btn = $('theme-switch');
  const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const sync = () => btn.setAttribute('aria-checked', String(isDark()));
  btn.addEventListener('click', () => { const t = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('pe-theme', t); } catch (e) {} sync(); });
  sync();
}

async function init() {
  setupTheme();
  cfg = await (await fetch('placements.json', { cache: 'no-cache' })).json();
  $('draft').value = JSON.stringify(TEMPLATE, null, 2);
  $('btn-try').addEventListener('click', tryDraft);
  $('len').addEventListener('change', planCombo);
  renderAll(); renderCombo();
}
init();
