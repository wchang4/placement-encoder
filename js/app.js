// app.js
// Page logic: intake, preset and settings form, warnings, encode with progress,
// download, and the verification report. The heavy lifting lives in:
//   engine.js (ffmpeg.wasm), args.js (command line), verify.js (report), media.js (helpers).
// Presets come from presets.json, so adding a placement needs no code changes.

import { Engine } from './engine.js';
import { buildArgs, targetFormat } from './args.js';
import { verify, overall, checkName } from './verify.js';
import { measureAudio, scanVideo, scanDuplicates, grabFrames, describeBars, describeBlackEnds } from './analyze.js';
import { planLeveling } from './level.js';
import { buildGroups, shortName } from './groups.js';
import { summarize, pixDepth, fmtFps, fmtBytes, fmtKbps, fmtTime, aspectLabel, aspectValue, estimateOutputBytes } from './media.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();

// ---------- state ----------
const state = {
  config: null,        // whole presets.json
  ticked: [],          // ids of the placements ticked in step 2
  groups: [],          // the files those placements need (see groups.js), each with its own settings and name
  active: 0,           // which file is shown in the editing area
  nameOverride: null,  // file name used while checking a file that is not the active one
  blobUrls: [],        // download links made this session (released when results are cleared)
  preset: null,        // preset of the active file (a placement, or a combined preset for a shared file)
  settings: null,      // current form values (starts as a copy of defaults)
  defaults: null,      // the preset's values in the same shape as settings (for highlighting changes)
  analysis: null,      // results of the preflight analysis of the current source
  file: null,          // the source File
  src: null,           // summarize() of the source
  running: false,
  showZones: true,     // draw safe-zone guides on the preview frames
};

// ---------- tiny DOM helper ----------
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
}

// ---------- settings form definition ----------
// One entry per control. "show" hides a control when it does not apply.
const OPT = {
  // "format" and "size" are shortcuts: one plain choice that sets several underlying settings.
  format: [['mp4-h264', 'MP4 file (H.264 video)'], ['mov-h264', 'MOV file (H.264 video)'], ['mov-prores', 'MOV file (Apple ProRes video, very large)']],
  size: [['keep', 'Keep the source size'], ['1920x1080', '1920 x 1080 (HD, 16:9)'], ['1280x720', '1280 x 720 (16:9)'], ['3840x2160', '3840 x 2160 (4K, 16:9)'],
    ['1080x1920', '1080 x 1920 (vertical 9:16)'], ['1080x1080', '1080 x 1080 (square)'], ['1080x1350', '1080 x 1350 (4:5)']],
  noiseStrength: [['2', '2 (lightest that works)'], ['4', '4 (recommended)'], ['6', '6'], ['8', '8 (visible on flat colour)']],
  h264Profile: [['main', 'Main'], ['high', 'High'], ['high422', 'High 4:2:2']],
  proresProfile: [['proxy', 'Proxy'], ['lt', 'LT'], ['422', '422 (Standard)'], ['hq', '422 HQ'], ['4444', '4444']],
  pixFmt: [['yuv420p', '4:2:0 (8-bit)'], ['yuv422p', '4:2:2 (8-bit)']],
  fps: [['native', 'Keep native (recommended)'], ['23.976', '23.976'], ['24', '24'], ['25', '25'], ['29.97', '29.97'], ['30', '30'], ['50', '50'], ['59.94', '59.94'], ['60', '60']],
  bitrateMode: [['vbr', 'VBR (variable)'], ['cbr', 'CBR (constant)']],
  x264Preset: [['veryfast', 'Fastest encode'], ['fast', 'Fast (default)'], ['medium', 'Balanced'], ['slow', 'Best quality (slow)']],
  acodec: [['aac', 'AAC'], ['pcm', 'PCM (uncompressed)']],
  sampleRate: [['44100', '44.1 kHz'], ['48000', '48 kHz']],
  bitDepth: [['16', '16-bit'], ['24', '24-bit']],
  channels: [['1', 'Mono'], ['2', 'Stereo']],
  loudMode: [['off', 'Off (leave the audio level unchanged)'], ['lufs', 'Integrated loudness (LUFS) + true peak'], ['rms', 'Average level (RMS dB) + peak'], ['max', 'Limits only: no louder than average (RMS dB) + peak']]
};
const isH264 = (s) => s.vcodec === 'h264';
// Read/write the two shortcut choices.
const PSEUDO = {
  format: {
    get: (s) => `${s.container}-${s.vcodec}`,
    set: (s, v) => {
      const [c, vc] = v.split('-'); s.container = c; s.vcodec = vc;
      s.acodec = vc === 'prores' ? 'pcm' : 'aac'; // ProRes deliveries use uncompressed audio; H.264 uses AAC
    }
  },
  size: {
    get: (s) => (s.width && s.height ? `${s.width}x${s.height}` : 'keep'),
    set: (s, v) => { if (v === 'keep') { s.width = null; s.height = null; } else { const [w, h] = v.split('x').map(Number); s.width = w; s.height = h; } }
  }
};
// Settings shown only in Custom mode (or after "Change the technical settings").
// Groups marked expert sit inside a further collapsed section. Audio channels are
// always stereo and the audio codec follows the file type, so neither is shown.
const FIELDS = [
  { group: 'The basics', items: [
    { k: 'format', label: 'File type', type: 'select' },
    { k: 'size', label: 'Picture size', type: 'select' },
    { k: 'fps', label: 'Frame rate', type: 'select' },
    { k: 'bitrateKbps', label: 'Video bitrate (kbps, higher = better quality and bigger file)', type: 'bitrate', show: isH264 }
  ] },
  { group: 'Video details', expert: true, items: [
    { k: 'h264Profile', label: 'H.264 profile', type: 'select', show: isH264 },
    { k: 'proresProfile', label: 'ProRes profile', type: 'select', show: (s) => !isH264(s) },
    { k: 'pixFmt', label: 'Chroma / pixel format', type: 'select', show: isH264 },
    { k: 'bitrateMode', label: 'Bitrate mode', type: 'select', show: isH264 },
    { k: 'x264Preset', label: 'Encode speed vs quality', type: 'select', show: isH264 },
    { k: 'bframes', label: 'B-frames', type: 'number', show: isH264 },
    { k: 'gopSeconds', label: 'Keyframe interval (seconds, 0 = auto)', type: 'number', show: isH264, step: '0.1' },
    { k: 'closedGop', label: 'Closed GOP', type: 'check', show: isH264 },
    { k: 'faststart', label: 'Fast-start (moov atom at front)', type: 'check' },
    { k: 'stripEditLists', label: 'Strip edit lists', type: 'check' },
    { k: 'tagBt709', label: 'Tag colour space as BT.709', type: 'check' },
    { k: 'noiseStrength', label: 'Grain strength (when grain is on)', type: 'select', numeric: true }
  ] },
  { group: 'Audio details', expert: true, items: [
    { k: 'sampleRate', label: 'Sample rate', type: 'select', numeric: true },
    { k: 'bitDepth', label: 'Bit depth', type: 'select', numeric: true, show: (s) => s.acodec === 'pcm' },
    { k: 'audioKbps', label: 'Audio bitrate (kbps)', type: 'number', show: (s) => s.acodec === 'aac' }
  ] },
  { group: 'Volume (audio leveling)', expert: true, items: [
    { k: 'loudMode', label: 'Leveling method', type: 'select' },
    { k: 'loudTarget', label: 'Target or limit (LUFS, or average dB)', type: 'number', step: '0.1', signed: true, show: (s) => s.loudMode !== 'off' },
    { k: 'loudPeak', label: 'Peak limit (dBTP, or dB)', type: 'number', step: '0.1', signed: true, show: (s) => s.loudMode !== 'off' },
    { type: 'picks', label: 'Quick picks', show: (s) => s.loudMode === 'lufs',
      picks: [['Broadcast: -24 LKFS / -2 dBTP', -24, -2], ['Streaming: -14 LUFS / -1 dBTP', -14, -1], ['Streaming: -16 LUFS / -1 dBTP', -16, -1]] },
    { type: 'hint', show: (s) => s.loudMode !== 'off',
      text: 'The audio is measured first, then adjusted, then measured again after encoding so the report shows the real result. If you do not know the target, leave leveling Off or ask the placement.' }
  ] }
];

const controls = {}; // key -> { wrap, inputs: [..], f }  (controls without a key use "_n")
const val = (s, k) => (PSEUDO[k] ? PSEUDO[k].get(s) : s[k]);

function buildSettingsForm() {
  const root = $('settings-form'); root.replaceChildren(); for (const k in controls) delete controls[k];
  let n = 0, expert = null;
  for (const g of FIELDS) {
    const grid = el('div', { class: 'grid' });
    for (const f of g.items) grid.append(buildControl(f, f.k || '_' + (n++)));
    if (g.expert) {
      if (!expert) { expert = el('details', { class: 'expert' }, el('summary', { text: 'Expert settings (most people never need these)' })); root.append(expert); }
      expert.append(el('h3', { text: g.group }), grid);
    } else root.append(el('h3', { text: g.group }), grid);
  }
  refreshForm();
}

function buildControl(f, key) {
  const s = { ...state.settings, format: val(state.settings, 'format'), size: val(state.settings, 'size') };
  let wrap, inputs = [];
  if (f.type === 'hint') {
    wrap = el('div', { class: 'hint', style: 'grid-column:1/-1', text: f.text });
  } else if (f.type === 'picks') {
    wrap = el('div', { style: 'grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, el('span', { class: 'hint', text: f.label + ':' }),
      ...f.picks.map(([t, target, peak]) => el('button', { class: 'ghost', type: 'button', text: t, onclick: () => { state.settings.loudTarget = target; state.settings.loudPeak = peak; refreshForm(); update(); } })));
  } else if (f.type === 'check') {
    const cb = el('input', { type: 'checkbox' }); cb.checked = !!s[f.k];
    cb.addEventListener('change', () => setSetting(f.k, cb.checked));
    wrap = el('label', { class: 'check' }, cb, f.label); inputs = [cb];
  } else if (f.type === 'select') {
    const sel = el('select');
    for (const [v, t] of OPT[f.k]) sel.append(el('option', { value: v, text: t }));
    sel.value = String(s[f.k]);
    sel.addEventListener('change', () => setSetting(f.k, f.numeric ? Number(sel.value) : sel.value));
    wrap = el('label', {}, f.label, sel); inputs = [sel];
  } else if (f.type === 'bitrate' || f.type === 'slider') {
    const bit = f.type === 'bitrate';
    const num = el('input', { type: 'number', min: bit ? '500' : String(f.min), max: bit ? '400000' : String(f.max), step: bit ? '100' : String(f.step) });
    const rng = el('input', { type: 'range', min: bit ? '1000' : String(f.min), max: bit ? '80000' : String(f.max), step: bit ? '500' : String(f.step) });
    num.value = rng.value = s[f.k];
    num.addEventListener('input', () => { rng.value = num.value; setSetting(f.k, Number(num.value) || 0); });
    rng.addEventListener('input', () => { num.value = rng.value; setSetting(f.k, Number(rng.value)); });
    wrap = el('label', {}, f.label, el('div', { class: 'inline' }, rng, num)); inputs = [num, rng];
  } else {
    const inp = el('input', { type: 'number', step: f.step || '1' });
    if (!f.signed) inp.min = '0';
    inp.value = s[f.k] == null ? '' : s[f.k];
    inp.addEventListener('input', () => setSetting(f.k, inp.value === '' ? null : Number(inp.value)));
    wrap = el('label', {}, f.label, inp); inputs = [inp];
  }
  controls[key] = { wrap, inputs, f };
  return wrap;
}

// Update which controls are visible / highlighted / current.
function refreshForm() {
  const s = state.settings, d = state.defaults;
  for (const c of Object.values(controls)) {
    c.wrap.classList.toggle('hidden', !!(c.f.show && !c.f.show(s)));
    const k = c.f.k;
    if (!k) continue;
    const cur = val(s, k), def = val(d, k);
    const changed = String(cur ?? '') !== String(def ?? '');
    for (const i of c.inputs) i.classList.toggle('changed', changed);
    // keep inputs in sync (e.g. after "Reset" or a quick pick)
    const i0 = c.inputs[0];
    if (i0.type === 'checkbox') i0.checked = !!cur; else if (document.activeElement !== i0) i0.value = cur == null ? '' : cur;
    if (c.inputs[1] && document.activeElement !== c.inputs[1]) c.inputs[1].value = cur;
  }
}

function setSetting(k, v) {
  if (PSEUDO[k]) PSEUDO[k].set(state.settings, v); else state.settings[k] = v;
  // Raising the frame rate repeats frames, so grain is switched on with it
  // (and off again otherwise). The user can still untick it.
  if (k === 'fps' && state.src) state.settings.noiseOn = raisesFps();
  // sensible companions: ProRes lives in MOV
  if (k === 'vcodec' && v === 'prores' && state.settings.container === 'mp4') state.settings.container = 'mov';
  if (k === 'pixFmt' && v === 'yuv422p' && state.settings.h264Profile !== 'high422') state.settings.h264Profile = 'high422';
  if (k === 'pixFmt' && v === 'yuv420p' && state.settings.h264Profile === 'high422') state.settings.h264Profile = 'high';
  // picking a leveling method for the first time: start from the usual numbers
  if (k === 'loudMode' && v === 'lufs' && !(state.settings.loudTarget < 0)) { state.settings.loudTarget = -14; state.settings.loudPeak = -1; }
  if (k === 'loudMode' && (v === 'rms' || v === 'max') && !(state.settings.loudTarget < 0)) { state.settings.loudTarget = -14; state.settings.loudPeak = -1; }
  refreshForm(); update();
}

// ---------- presets ----------
// The preset file keeps loudness and noise in their own blocks; the form wants one flat list.
function defaultsFor(p) {
  const L = p.loudness || { mode: 'off' };
  return {
    ...JSON.parse(JSON.stringify(p.settings)),
    loudMode: L.mode || 'off', loudTarget: L.targetDb ?? -14, loudPeak: L.peakDb ?? -1,
    // Grain is off by default; it is offered when the frame rate changes or repeats are found.
    noiseOn: false, noiseStrength: p.noise?.strength ?? state.config.grain?.strength ?? 4,
    dupCheck: true // always re-scan the finished file so the result can say whether repeats remain
  };
}

// One plain sentence describing what the placement's file will be.
function presetSummary(p) {
  const s = p.settings;
  const kind = s.vcodec === 'prores' ? 'a ProRes MOV file (large)' : `an ${s.container.toUpperCase()} file (H.264)`;
  const size = s.width && s.height ? `${s.width} x ${s.height}` : 'the same picture size as your video';
  const lm = p.loudness?.mode;
  const vol = lm === 'max' ? ', with the volume checked against the placement\'s limits (turned down only if too loud)'
    : lm && lm !== 'off' ? ', with the volume set automatically to the placement\'s level' : '';
  return `You'll get ${kind}, ${size}, at your video's own frame rate${vol}.`;
}

// Ticks changed: work out which files are needed. A file keeps its name and any
// changed settings while the same placements are still in it.
function onTick(p, on) {
  const isCustom = (id) => state.config.presets.find(x => x.id === id)?.custom;
  if (on && p.custom) state.ticked = [p.id];                                   // Custom stands alone
  else if (on) state.ticked = state.ticked.filter(id => !isCustom(id)).concat(p.id);
  else state.ticked = state.ticked.filter(id => id !== p.id);
  for (const t of document.querySelectorAll('.tile')) {
    const on = state.ticked.includes(t.dataset.id);
    t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on));
  }
  onTicks();
}

function onTicks() {
  saveActiveName();
  const old = state.groups;
  const sameMembers = (a, b) => a.members.map(m => m.id).join() === b.members.map(m => m.id).join();
  state.groups = buildGroups(state.config, state.ticked).map(g => {
    const prev = old.find(o => o.key === g.key && sameMembers(o, g));
    if (prev) return { ...g, defaults: prev.defaults, settings: prev.settings, customize: prev.customize, name: prev.name };
    const defaults = defaultsFor(g.preset);
    const settings = { ...defaults };
    settings.noiseOn = raisesFps(settings);
    return { ...g, defaults, settings, customize: false, name: old.find(o => o.key === g.key)?.name ?? '' };
  });
  fillDefaultNames(false);
  const n = state.groups.length;
  $('files-area').classList.toggle('hidden', !n);
  $('active-file').classList.toggle('hidden', !n);
  $('none-ticked').classList.toggle('hidden', !!n);
  $('files-head').textContent = n === 1 ? 'You need 1 file' : `You need ${n} files`;
  if (!n) { useFallback(); return; }
  setActive(Math.min(state.active, n - 1), false);
}

// Nothing ticked: the automatic check still runs, with general checks only.
function useFallback() {
  const p = state.config.presets.find(x => x.custom);
  state.preset = p; state.defaults = defaultsFor(p); state.settings = { ...state.defaults }; state.customize = false;
  update();
  if (state.analysis) renderPreflight();
}

// File names start from the video's name. With several files, each gets a short tag
// (for example _STREAM) so they do not overwrite each other.
function fillDefaultNames(force) {
  const n = state.groups.length;
  for (const g of state.groups) {
    if (!force && g.name) continue;
    g.name = state.baseName ? (n > 1 && g.tag ? `${state.baseName}_${g.tag}` : state.baseName) : '';
  }
}

function saveActiveName() { const g = state.groups[state.active]; if (g && !state.nameOverride) g.name = $('outname').value; }

// Show one file in the editing area below the cards.
function setActive(i, save = true) {
  const g = state.groups[i]; if (!g) return;
  if (save) saveActiveName();
  state.active = i;
  state.preset = g.preset; state.defaults = g.defaults; state.settings = g.settings; state.customize = g.customize;
  const p = state.preset, n = state.groups.length;
  $('active-title').textContent = (n > 1 ? `File ${i + 1} of ${n}: ` : '') + (p.custom ? 'Custom settings' : g.label);
  $('preset-status').replaceChildren(p.custom ? '' : p.status === 'verified'
    ? el('span', { class: 'tag ok', text: 'VERIFIED ' + (p.verifiedDate || '') })
    : el('span', { class: 'tag warn', text: 'SPEC NOT YET CONFIRMED', title: 'These values come from research and have not been confirmed with the placement.' }));
  $('preset-summary').textContent = p.custom ? 'Choose the settings below. Start from the basics; the expert settings are rarely needed.'
    : (g.members.length > 1 ? `One file for ${p.name}. ` : '') + presetSummary(p);
  $('preset-notes').replaceChildren(...[...(p.notes || []), ...(p.loudness?.note ? ['Volume: ' + p.loudness.note] : [])].map(t => el('li', { text: t })));
  $('preset-source').textContent = 'Source: ' + (p.source?.label || 'none') + (p.source?.url ? ' · ' + p.source.url : '') + (p.verifiedDate ? ' · last verified ' + p.verifiedDate : '');
  $('outname').value = g.name;
  buildSettingsForm(); showAdvanced(); update();
  if (state.analysis) renderPreflight(); // redraw the checklist and safe-zone guides for this file
}

// Run fn as if file g were the active one (used to check every file, not just the shown one).
function withGroup(g, fn) {
  const keep = { preset: state.preset, settings: state.settings, defaults: state.defaults, nameOverride: state.nameOverride };
  state.preset = g.preset; state.settings = g.settings; state.defaults = g.defaults; state.nameOverride = g.name;
  try { return fn(); } finally { Object.assign(state, keep); }
}

// Card for each file: what it is, which placements it covers, and how it looks so far.
function renderCards(evals) {
  const cards = state.groups.map((g, i) => {
    const e = evals[i];
    const bad = e.w.filter(x => x.level === 'bad').length + e.checks.filter(c => c[0] === 'bad').length;
    const warn = e.w.filter(x => x.level === 'warn').length + e.checks.filter(c => c[0] === 'warn').length;
    let st, cls;
    if (!state.src) { st = 'Drop your video to check it'; cls = ''; }
    else if (bad) { st = `✕ ${bad} problem${bad > 1 ? 's' : ''}`; cls = 'bad'; }
    else if (warn) { st = `! ${warn} thing${warn > 1 ? 's' : ''} to look at`; cls = 'warn'; }
    else if (!state.analysis) { st = 'Checking your video...'; cls = ''; }
    else { st = '✓ Looks ready'; cls = 'ok'; }
    const card = el('div', { class: 'card' + (i === state.active ? ' active' : ''), role: 'button', tabindex: '0', title: 'Show this file' },
      el('div', { class: 'num', text: `File ${i + 1}` }),
      el('b', { text: g.preset.custom ? 'Custom settings' : g.label }),
      el('div', { class: 'for', text: 'For: ' + g.members.map(m => m.name).join(', ') }),
      el('div', { class: 'st ' + cls, text: st }));
    const go = () => { if (!state.running && i !== state.active) setActive(i); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    return card;
  });
  $('file-cards').replaceChildren(...cards);
}

// The technical settings are hidden unless Custom is chosen or the user asks for them.
function showAdvanced() {
  const on = !!(state.preset.custom || state.customize);
  $('advanced').classList.toggle('hidden', !on);
  $('customize-row').classList.toggle('hidden', !!state.preset.custom);
  $('btn-customize').textContent = state.customize ? 'Hide the technical settings' : 'Change the technical settings';
}

// ---------- warnings and readiness ----------
function currentFileName() {
  return ((state.nameOverride ?? $('outname').value).trim()) + '.' + state.settings.container;
}

function computeWarnings() {
  const out = []; const s = state.settings, spec = state.preset.spec, src = state.src;
  const add = (level, text, block = false) => out.push({ level, text, block });

  // choices that cannot work together
  if (s.vcodec === 'prores' && s.container === 'mp4') add('bad', 'ProRes cannot be stored in an MP4. Choose MOV.', true);
  if (s.acodec === 'pcm' && s.container === 'mp4') add('bad', 'Uncompressed PCM audio is not supported in MP4 here. Choose MOV or AAC audio.', true);
  const nm = (state.nameOverride ?? $('outname').value).trim();
  if (!nm) { if (state.src) add('bad', 'Type a file name.', true); }
  else if (/[\\/:*?"<>|]/.test(nm)) add('bad', 'The file name contains characters that are not allowed: \\ / : * ? " < > |', true);
  const rule = checkName(currentFileName(), state.preset.naming);
  $('name-rule').textContent = state.preset.naming?.note || '';
  if (rule && !rule.ok) add('warn', `File name does not meet this preset's rule (${rule.expected}): ${rule.actual}.`);

  if (!src) return out;
  const v = src.video;
  if (!v) { add('bad', 'No video was found in this file.', true); return out; }

  if (spec.audioRequired && !src.audio) add('bad', 'This placement requires audio, but the source file has no audio track.', true);
  if (!src.audio && !spec.audioRequired) add('info', 'Your video has no sound. The new file will have none either.');

  const t = targetFormat(s, src);
  // reframing is out of scope: refuse to silently stretch
  const srcAspect = v.width / v.height, tgtAspect = t.w / t.h;
  if (t.scales && Math.abs(srcAspect - tgtAspect) / srcAspect > 0.01)
    add('bad', `The source is ${aspectLabel(v.width, v.height)} (${v.width}x${v.height}) but the target is ${t.w}x${t.h}. This tool does not crop or reframe, so the picture would be stretched. Supply a file with the right shape.`, true);
  else if (t.scales) add(t.w > v.width ? 'warn' : 'info', `Resolution will be changed from ${v.width}x${v.height} to ${t.w}x${t.h}${t.w > v.width ? ' (upscaling reduces sharpness)' : ''}.`);
  const aspects = spec.allowedAspects || (spec.aspect ? [spec.aspect] : null);
  if (aspects && !(t.scales && Math.abs(srcAspect - tgtAspect) / srcAspect > 0.01) && !aspects.some(l => Math.abs(tgtAspect - aspectValue(l)) / aspectValue(l) < 0.01))
    add('bad', `This placement needs ${aspects.join(' or ')}, but the output would be ${aspectLabel(t.w, t.h)}. This tool does not reframe. Supply a file with the right shape.`, true);
  if (spec.minShortEdge && Math.min(t.w, t.h) < spec.minShortEdge) add('warn', `The short edge is ${Math.min(t.w, t.h)} px; this placement wants at least ${spec.minShortEdge} px.`);

  if (t.convertsFps) add('warn', `The frame rate will be changed from ${fmtFps(v.fps)} to ${fmtFps(t.fps)} fps. ` + (t.fps > v.fps
    ? 'Going up repeats frames, which some placements (Disney+) reject even with grain.'
    : 'Going down drops frames, so motion can look jerky.') + ` If you can, ask the editor for an export at ${fmtFps(t.fps)} fps instead.`);
  if (spec.allowedFps && !spec.allowedFps.some(f => Math.abs(f - t.fps) / f < 0.001))
    add('warn', `This placement accepts ${spec.allowedFps.map(fmtFps).join(', ')} fps, but the file would be ${fmtFps(t.fps)} fps. Best fix: ask the editor for an export at an accepted frame rate. (Changing it here is possible under "Change the technical settings", with grain.)`);
  if (v.cfrLikely === false) add('warn', 'The source looks like variable frame rate. The output is forced to constant frame rate, which can repeat or drop frames.');
  if (!['progressive', 'unknown', ''].includes(v.fieldOrder)) add('warn', `The source is interlaced (${v.fieldOrder}). This tool does not deinterlace. Deinterlace first for placements that need progressive.`);
  if (s.tagBt709 && v.colorSpace && v.colorSpace !== 'bt709') add('warn', `The source colour space is "${v.colorSpace}". Tagging the output BT.709 only changes the label, it does not convert the colours.`);
  if (v.sar && v.sar !== '1:1' && v.sar !== '0:1') add('warn', `The source has non-square pixels (${v.sar}).`);

  if (spec.maxDurationSec && src.durationSec > spec.maxDurationSec + state.config.strictness.durationToleranceSec) add('warn', `The source is ${src.durationSec.toFixed(1)} s long; ${spec.maxDurationBy || 'this placement'} allows ${spec.maxDurationSec} s.`);
  if (s.vcodec === 'h264' && ((spec.minKbps != null && s.bitrateKbps < spec.minKbps) || (spec.maxKbps != null && s.bitrateKbps > spec.maxKbps)))
    add('warn', `The video bitrate (${s.bitrateKbps} kbps) is outside this placement's range (${spec.minKbps ?? 0} to ${spec.maxKbps ?? 'no limit'} kbps).`);

  // size estimate and memory guard
  const est = estimateOutputBytes(s, t.w, t.h, t.fps, src.durationSec);
  const estMB = est / 1048576, lim = state.config.limits;
  $('est').textContent = 'Estimated output: about ' + fmtBytes(est) + (s.vcodec === 'prores' ? ' (upper estimate)' : '');
  if (estMB >= lim.memoryBlockMB) add('bad', `The output is expected to be about ${fmtBytes(est)}. That is more than this browser tool can safely handle (limit ${lim.memoryBlockMB} MB) and the tab would likely crash. Use H.264, a shorter clip, or desktop encoding software.`, true);
  else if (estMB >= lim.memoryWarnMB) add('warn', `The output is expected to be large (about ${fmtBytes(est)}). It may fail on computers with 8 GB of memory. Close other tabs and programs first.`);
  else if (navigator.deviceMemory && navigator.deviceMemory <= 4 && estMB > 300) add('warn', 'This computer reports very little memory; a large output may fail.');
  if (src.durationSec > 120) add('info', `This clip is ${fmtTime(src.durationSec)} long. Encoding in the browser is slow (often several times the clip length), so expect a long wait.`);
  if (state.file && state.file.size > 2 * 1073741824 && navigator.deviceMemory && navigator.deviceMemory <= 4) add('warn', 'This is a very large source file and this computer reports little memory. It may fail.');
  if (s.loudMode !== 'off' && !src.audio) add('info', 'Volume leveling is set but your video has no sound, so it will be skipped.');
  if (spec.maxSizeMB && estMB > spec.maxSizeMB) add('warn', `The estimated size (${fmtBytes(est)}) is over this placement's limit of ${spec.maxSizeMB} MB.`);
  return out;
}

function update() {
  const n = state.groups.length;
  if (!n) {
    $('warnings').replaceChildren();
    $('btn-encode').disabled = true; $('btn-encode').textContent = 'Make the file';
    $('btn-check').disabled = true;
    $('est').textContent = state.src ? 'Tick a placement in step 2 first.' : '';
    $('file-cards').replaceChildren();
    return;
  }
  // Check the other files first, then the shown one (so its size estimate and name rule are displayed).
  const evaluate = () => ({ w: computeWarnings(), checks: state.analysis ? plainChecklist() : [] });
  const evals = state.groups.map((g, i) => (i === state.active ? null : withGroup(g, evaluate)));
  evals[state.active] = evaluate();
  const w = evals[state.active].w;
  if (n > 1) {
    const names = state.groups.map((g, i) => (i === state.active ? currentFileName() : withGroup(g, currentFileName)).toLowerCase());
    const mine = names[state.active];
    if (names.filter(x => x === mine).length > 1) w.push({ level: 'bad', text: 'Another file has the same name. Give each file its own name so one does not replace the other.', block: true });
  }
  $('warnings').replaceChildren(...w.map(x => el('div', { class: 'msg ' + x.level, text: x.text })));
  const blocked = evals.some(e => e.w.some(x => x.block));
  $('btn-encode').disabled = !state.src || blocked || state.running;
  $('btn-encode').textContent = n > 1 ? `Make the ${n} files` : 'Make the file';
  $('btn-check').disabled = !state.src || state.running;
  renderCards(evals);
  $('outext').textContent = '.' + state.settings.container;
  if (!state.src) $('est').textContent = '';
  updateGrain();
}

// "Add light grain" is shown only when it can help: the frame rate is being
// changed, or the automatic check found repeated frames. Off unless switched on.
// True when the chosen frame rate is higher than the source's, which repeats frames.
function raisesFps(s = state.settings) {
  if (!state.src) return false;
  const t = targetFormat(s, state.src);
  return t.convertsFps && t.fps > state.src.video.fps;
}

function updateGrain() {
  const s = state.settings, src = state.src;
  const converts = raisesFps();
  const d = state.analysis?.video?.dups;
  const repeats = !!d && d.percent > state.config.strictness.dupPassPercent;
  $('grain-row').classList.toggle('hidden', !(converts || repeats || s.noiseOn));
  $('grain').checked = !!s.noiseOn;
  let why;
  if (converts) why = 'Switched on because the frame rate is being raised, which repeats frames. ';
  else if (d?.conversion) why = 'Your video already has a repeated frame every few frames, a sign it was converted from another frame rate. Grain hides exact repeats, but Disney+ and similar checks may still reject it. A native-frame-rate export from the editor is the real fix. ';
  else if (repeats) why = `Your video has repeated frames (${d.percent.toFixed(1)}% of frames, longest ${d.longestRunSec.toFixed(1)} s, for example a held end card). Tick this if the placement rejects repeated frames. `;
  else why = '';
  $('grain-why').textContent = why + `Grain strength ${s.noiseStrength}: barely visible on flat colour, invisible on normal footage. The finished file is re-checked for repeats.`;
}

// ---------- source intake ----------
function setupDrop() {
  const drop = $('drop'), input = $('file');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files[0] && loadFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => {
    const files = ev.dataTransfer.files;
    if (files.length > 1) { showError('One file at a time, please. Using the first one: ' + files[0].name); }
    if (files[0]) loadFile(files[0]);
  });
}

async function loadFile(file) {
  if (state.running) return;
  clearResult(); showError('');
  if (!/\.(mov|mp4|m4v)$/i.test(file.name) && !/^video\//.test(file.type)) {
    showError('This does not look like a video file (' + file.name + '). Use a MOV or MP4.'); return;
  }
  if (file.size === 0) { showError('This file is empty (0 bytes). If it lives in a cloud-synced folder, make sure it has finished downloading.'); return; }
  state.file = file; state.src = null; state.analysis = null; $('check-area').classList.add('hidden'); update();
  $('source-status').textContent = 'Reading ' + file.name + '...';
  try {
    await ensureEngine(1, 1, 'Loading the encoder');
    showProgress('Reading the file', null);
    state.srcProbe = await engine.probe(file);
    state.src = summarize(state.srcProbe);
    if (!state.src.video) throw new Error('No video track was found in this file.');
  } catch (e) {
    hideProgress(); state.src = null; update();
    $('source-status').textContent = '';
    showError(friendlyError(e));
    return;
  }
  hideProgress();
  $('source-status').textContent = file.name + ' (' + fmtBytes(file.size) + ')';
  renderSourceDetails();
  // default output names: the source name, cleaned up (plus a tag per file when there are several)
  state.baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  fillDefaultNames(true);
  for (const g of state.groups) g.settings.noiseOn = raisesFps(g.settings);
  if (state.groups.length) $('outname').value = state.groups[state.active].name;
  update();
  onPreflight(); // the automatic check runs straight away
}

function renderSourceDetails() {
  const s = state.src, v = s.video, a = s.audio;
  const rows = [
    ['File size', fmtBytes(state.file.size)],
    ['Container', s.container.toUpperCase()],
    ['Duration', s.durationSec.toFixed(2) + ' s'],
    ['Video codec', v.codec + (v.profile ? ' (' + v.profile + ')' : '')],
    ['Resolution', `${v.width} x ${v.height} (${aspectLabel(v.width, v.height)})`],
    ['Frame rate', fmtFps(v.fps) + ' fps' + (v.cfrLikely === false ? ' (possibly variable)' : v.cfrLikely ? ' (constant)' : '')],
    ['Scan type', v.fieldOrder === 'unknown' ? 'progressive (not flagged interlaced)' : v.fieldOrder],
    ['Video bitrate', fmtKbps(v.kbps) + (v.kbpsEstimated ? ' (estimated)' : '')],
    ['Pixel format', v.pixFmt + (v.bitDepth ? ', ' + v.bitDepth + '-bit' : '')],
    ['Colour tags', [v.colorSpace, v.colorPrimaries, v.colorTransfer].filter(Boolean).join(' / ') || 'none'],
    ['Audio', a ? `${a.codec}, ${a.sampleRate / 1000} kHz, ${a.channels} ch` + (a.kbps ? ', ' + Math.round(a.kbps) + ' kbps' : '') : 'none'],
    ['Tracks', `${s.videoCount} video, ${s.audioCount} audio` + (s.otherCount ? `, ${s.otherCount} other (ignored)` : '')]
  ];
  $('source-details').replaceChildren(...rows.map(([k, val]) => el('div', {}, el('span', { text: k }), el('b', { text: val }))));
}

// ---------- progress ----------
let progTimer = null, progStart = 0;
function showProgress(step, ratio) {
  $('progress').classList.remove('hidden');
  $('step').textContent = step;
  const bar = $('bar');
  bar.classList.toggle('indet', ratio == null);
  bar.firstElementChild.style.width = ratio == null ? '' : Math.round(ratio * 100) + '%';
  $('pct').textContent = ratio == null ? '' : Math.round(ratio * 100) + '%';
}
function startClock() {
  progStart = performance.now(); clearInterval(progTimer);
  progTimer = setInterval(() => { $('elapsed').textContent = 'Elapsed ' + fmtTime((performance.now() - progStart) / 1000); }, 500);
}
function hideProgress() { clearInterval(progTimer); $('progress').classList.add('hidden'); $('eta').textContent = ''; $('elapsed').textContent = ''; }

async function ensureEngine(stepNo, total, label) {
  if (engine.ready) return;
  startClock();
  showProgress(`Step ${stepNo} of ${total}: ${label} (first visit downloads about 31 MB, then it is cached)`, null);
  await engine.load((got, tot, cached) => {
    if (tot) showProgress(`Step ${stepNo} of ${total}: ${label}${cached ? ' (from cache)' : ''}`, got / tot);
  });
}

// ---------- encode ----------
const MIME = { mp4: 'video/mp4', mov: 'video/quicktime' };

async function onEncode() {
  if (state.running || !state.groups.length) return;
  saveActiveName();
  const n = state.groups.length;
  clearResult(); showError('');

  // Ask where to save BEFORE the long encode (needs a click; Chrome/Edge only).
  // One file: a "Save as" box. Several files: choose a folder once.
  const target = { handle: null, dir: null };
  if (!window.__testSink && n === 1 && window.showSaveFilePicker) {
    const s = state.settings;
    try {
      target.handle = await window.showSaveFilePicker({ suggestedName: currentFileName(), types: [{ description: 'Video', accept: { [MIME[s.container]]: ['.' + s.container] } }] });
    } catch (e) {
      if (e.name === 'AbortError') { showError('No save location chosen, so nothing was encoded.'); return; }
    }
  } else if (!window.__testSink && n > 1 && window.showDirectoryPicker) {
    try {
      target.dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const names = state.groups.map(g => withGroup(g, currentFileName));
      const existing = [];
      for (const nm of names) { try { await target.dir.getFileHandle(nm); existing.push(nm); } catch (e) { /* not there yet */ } }
      if (existing.length && !window.confirm('These files are already in that folder and would be replaced:\n\n' + existing.join('\n') + '\n\nReplace them?')) {
        showError('Nothing was made. Choose another folder or change the file names.'); return;
      }
    } catch (e) {
      if (e.name === 'AbortError') { showError('No folder chosen, so nothing was made.'); return; }
      target.dir = null; // fall back to normal browser downloads
    }
  }

  state.running = true; update();
  $('btn-cancel').classList.remove('hidden'); $('btn-encode').classList.add('hidden');
  try {
    for (let i = 0; i < n && !state.cancelled; i++) {
      setActive(i); // show the settings of the file being made
      await encodeOne(i, n, target);
    }
  } catch (e) {
    hideProgress();
    if (!state.cancelled) showError((n > 1 ? `File ${state.active + 1} of ${n} could not be made. ` : '') + friendlyError(e));
  } finally {
    state.running = false; state.cancelled = false;
    $('btn-cancel').classList.add('hidden'); $('btn-encode').classList.remove('hidden'); update();
  }
}

async function encodeOne(i, n, target) {
  const s = state.settings, outFile = currentFileName(), memName = 'out.' + s.container;
  const pre = n > 1 ? `File ${i + 1} of ${n}, ` : '';
  // The steps shown to the user depend on what was asked for.
  const leveling = s.loudMode !== 'off' && !!state.src.audio;
  const steps = ['Loading the encoder'];
  if (leveling) steps.push('Measuring audio levels');
  steps.push('Encoding video', 'Checking the result', 'Saving the file');
  const label = (name) => `${pre}Step ${steps.indexOf(name) + 1} of ${steps.length}: ${name}`;
  const dur = state.src.durationSec;
  await ensureEngine(1, steps.length, 'Loading the encoder');
  const path = await engine.mountForEncode(state.file); // (re)mount: a cancel drops the old mount
  startClock();

  // Audio leveling: measure first, then build the filter.
  let audioFilter = null, levelInfo = '';
  if (leveling) {
    const timer = timedProgress(label('Measuring audio levels'), dur);
    ({ filter: audioFilter, info: levelInfo } = await planLeveling(engine, path, s, timer));
  }

  const { args, notes } = buildArgs(s, state.src, path, memName, { audioFilter });
  if (levelInfo) notes.push(levelInfo);
  if (s.noiseOn) notes.push(`Light grain was added (strength ${s.noiseStrength}).`);
  await engine.encode(args, timedProgress(label('Encoding video'), dur));

  // Measure the finished file while it is still inside the encoder.
  const tf = targetFormat(s, state.src);
  const extra = {};
  const stepName = label('Checking the result');
  if (leveling) { showProgress(stepName + ' (audio levels)', null); extra.audio = await measureAudio(engine, memName); }
  if (s.dupCheck) extra.video = await scanVideo(engine, memName, tf.fps, state.config.strictness.dupDiffThreshold, s.vcodec === 'prores' ? (s.proresProfile === '4444' ? 12 : 10) : 8, timedProgress(stepName + ' (frames)', dur));

  // Pull the finished file out of the encoder, wrap it in a Blob (the browser
  // can keep big Blobs on disk), and let the probe instance check it.
  showProgress(stepName, null); $('eta').textContent = '';
  let data = await engine.takeOutput(memName);
  const blob = new Blob([data], { type: MIME[s.container] });
  data = null;
  const outSummary = summarize(await engine.probe(blob, '.' + s.container));
  outSummary.sizeBytes = blob.size; // real size of what will be saved

  showProgress(label('Saving the file'), null);
  const handle = target.dir ? await target.dir.getFileHandle(outFile, { create: true }) : target.handle;
  const saved = await saveOutput(blob, outFile, handle);
  if (target.dir) saved.note = 'Saved in the folder you chose.';

  hideProgress();
  const source = { ...state.src, dupPercent: state.analysis?.video?.dups?.percent, conversion: state.analysis?.video?.dups?.conversion };
  const rows = verify(outSummary, s, state.preset, { source, fileName: outFile, strictness: state.config.strictness, extra });
  showResult((n > 1 ? `File ${i + 1} of ${n}: ` : 'Encoded: ') + outFile, rows, notes, saved.note, saved.url ? { url: saved.url, name: outFile } : null);
}

// A progress callback for a pass that reports "seconds of video done".
function timedProgress(text, duration) {
  const t0 = performance.now();
  showProgress(text, 0); $('eta').textContent = 'Time left: estimating...';
  return (sec) => {
    const r = Math.min(1, sec / duration), e = (performance.now() - t0) / 1000;
    showProgress(text, r);
    $('eta').textContent = (r > 0.02 && e > 5) ? 'Time left: about ' + fmtTime(e / r - e) : 'Time left: estimating...';
  };
}

// ---------- preflight analysis ----------
// Reads loudness, duplicate frames, black bars, black frames and interlacing from the
// source, and grabs three still frames so a person can spot slates or countdowns.
async function onPreflight() {
  if (state.running || !state.src) return;
  state.running = true; update(); showError(''); clearResult();
  $('btn-cancel').classList.remove('hidden'); $('btn-encode').classList.add('hidden');
  const src = state.src, total = src.audio ? 4 : 3; let n = 1;
  const st = state.config.strictness;
  try {
    await ensureEngine(1, total, 'Loading the encoder');
    const path = await engine.mountForEncode(state.file);
    startClock();
    const analysis = { audio: null, video: null, thumbs: [] };
    if (src.audio) {
      showProgress(`Checking your video, step ${++n} of ${total}: measuring the sound`, null);
      analysis.audio = await measureAudio(engine, path);
    }
    analysis.video = await scanVideo(engine, path, src.video.fps, st.dupDiffThreshold, pixDepth(src.video.pixFmt), timedProgress(`Checking your video, step ${++n} of ${total}: looking at every frame`, src.durationSec));
    showProgress(`Checking your video, step ${++n} of ${total}: grabbing preview frames`, null); $('eta').textContent = '';
    analysis.thumbs = await grabFrames(engine, path, src.durationSec);
    state.analysis = analysis;
    hideProgress(); renderPreflight(); update();
  } catch (e) {
    hideProgress(); if (!state.cancelled) showError(friendlyError(e));
  } finally {
    state.running = false; state.cancelled = false;
    $('btn-cancel').classList.add('hidden'); $('btn-encode').classList.remove('hidden'); update();
  }
}

function renderPreflight() {
  const a = state.analysis, src = state.src, s = state.settings, spec = state.preset.spec, st = state.config.strictness;
  const rows = []; const add = (label, result, status, note = '') => rows.push([label, result, status, note]);
  const f1 = (x) => (x == null ? 'n/a' : !isFinite(x) ? '-inf' : x.toFixed(1));
  const gain = (target, now) => (target - now >= 0 ? '+' : '') + (target - now).toFixed(1) + ' dB';
  if (!src.audio) add('Audio', 'none', spec.audioRequired ? 'fail' : 'info', spec.audioRequired ? 'This placement requires audio.' : '');
  else if (a.audio?.silent) add('Audio', 'silent', spec.audioRequired ? 'fail' : 'warn', 'The audio track contains no sound.');
  else if (a.audio) {
    const m = a.audio;
    add('Integrated loudness', f1(m.lufs) + ' LUFS', 'info', `Loudness range ${f1(m.lra)} LU.` + (s.loudMode === 'lufs' ? ` Gain needed to reach ${s.loudTarget} LUFS: ${gain(s.loudTarget, m.lufs)}.` : ''));
    add('True peak', f1(m.truePeak) + ' dBTP', m.truePeak > -1 ? 'warn' : 'info', m.truePeak > -1 ? 'Very close to full scale. Some placements reject peaks above -1 dBTP.' : '');
    if (s.loudMode === 'max') add('Average level (RMS)', f1(m.rms) + ' dB', m.rms > s.loudTarget + 0.05 ? 'warn' : 'info',
      m.rms > s.loudTarget + 0.05 ? `Louder than the ${s.loudTarget} dB limit; it will be turned down ${(m.rms - s.loudTarget).toFixed(1)} dB.` : `Within the ${s.loudTarget} dB limit; the level will be left as it is.`);
    else add('Average level (RMS)', f1(m.rms) + ' dB', 'info', s.loudMode === 'rms' ? `Gain needed to reach ${s.loudTarget} dB: ${gain(s.loudTarget, m.rms)}.` + (m.samplePeak - m.rms > s.loudPeak - s.loudTarget + 1 ? ` Warning: this audio has ${(m.samplePeak - m.rms).toFixed(1)} dB between average and peak; the target allows only ${(s.loudPeak - s.loudTarget).toFixed(1)} dB, so it cannot be reached without compression.` : '') : '');
    add('Sample peak', f1(m.samplePeak) + ' dB', 'info');
  }
  const v = a.video, d = v.dups;
  add('Duplicate frames', `${d.duplicates} of ${d.frames - 1} (${d.percent.toFixed(1)}%)`, d.percent <= st.dupPassPercent ? 'pass' : d.percent <= st.dupWarnPercent ? 'warn' : 'fail',
    d.duplicates ? `Longest repeat ${d.longestRun} frames (${d.longestRunSec.toFixed(2)} s). ` + 'Placements that flag repeated frames may reject this. "Add light grain" prevents exact repeats.' : '');
  const bars = describeBars(v.crop, src.video.width, src.video.height, st.barTolerancePx);
  add('Black bars', bars || 'none detected', bars ? (spec.noLetterbox ? 'fail' : spec.barsAllowed ? 'info' : 'warn') : 'pass', bars && spec.noLetterbox ? 'This placement does not allow letterboxing or pillarboxing. This must be fixed in the edit.' : '');
  const ends = describeBlackEnds(v.black, src.durationSec); const bp = [];
  if (ends.start) bp.push(`${ends.start.toFixed(2)} s at the start`);
  if (ends.end) bp.push(`${ends.end.toFixed(2)} s at the end`);
  add('Black frames at start/end', bp.join(', ') || 'none detected', bp.length ? 'warn' : 'pass');
  if (v.idet) add('Interlacing', v.idet.interlacedPercent < 5 ? 'progressive' : v.idet.interlacedPercent.toFixed(0) + '% interlaced frames', v.idet.interlacedPercent < 5 ? 'pass' : 'warn', v.idet.interlacedPercent < 5 ? '' : 'This tool does not deinterlace.');
  add('Frame rate type', src.video.cfrLikely === false ? 'possibly variable' : 'constant', src.video.cfrLikely === false ? 'warn' : 'pass', 'Based on the file header. A full frame-by-frame timing check is not done.');
  add('Slate / countdown', 'check the frames below', 'info', 'These cannot be detected reliably by software. Look at the first frame and the frames near the start and end.');

  if (d.conversion) add('Frame rate conversion pattern', `one repeat every ${d.conversion.every} frames`, 'fail', 'Typical of a file converted from another frame rate (for example 23.976 to 29.97).');
  const table = el('table', {}, el('thead', {}, el('tr', {}, ...['Check', 'Result', 'Status', 'Note'].map(h => el('th', { text: h })))));
  const body = el('tbody');
  for (const [l, r, stt, note] of rows) body.append(el('tr', {}, el('td', { text: l }), el('td', { text: r }), el('td', {}, el('span', { class: 'tag ' + stt, text: stt.toUpperCase() })), el('td', { class: 'note', text: note })));
  table.append(body);
  $('checklist').replaceChildren(...plainChecklist().map(checkItem));
  const g = state.groups[state.active], n = state.groups.length;
  $('check-for').textContent = !n ? 'your video (general checks only: tick a placement in step 2 to check against its spec)'
    : state.preset.custom ? 'your settings'
    : (n > 1 ? `file ${state.active + 1} of ${n} (${g.label}): ` : '') + state.preset.name;
  // Preview frames, with the preset's documented safe-zone guides drawn on top.
  const zones = state.preset.safeZones || [];
  const vw = src.video.width, vh = src.video.height;
  const usable = zones.filter(z => Math.abs(vw / vh - z.refW / z.refH) / (z.refW / z.refH) < 0.01);
  const guideBox = el('label', { class: 'check hint', style: 'display:flex;gap:8px;align-items:center;margin-top:14px' });
  const cb = el('input', { type: 'checkbox' }); cb.checked = state.showZones;
  cb.addEventListener('change', () => { state.showZones = cb.checked; renderPreflight(); });
  guideBox.append(cb, 'Show safe-zone guides for this preset');
  const thumbs = el('div', { style: 'display:flex;gap:12px;flex-wrap:wrap;margin-top:10px' },
    ...a.thumbs.map(t => {
      const box = el('div', { style: 'position:relative;overflow:hidden;border-radius:8px;width:300px;background:#000' }, el('img', { src: t.url, style: 'width:100%;display:block', alt: t.label }));
      if (state.showZones) for (const z of usable) box.append(zoneBox(z));
      return el('figure', { style: 'margin:0' }, box, el('figcaption', { class: 'hint', text: t.label }));
    }));
  let zoneNote;
  if (!zones.length) zoneNote = 'No safe zone is documented for this preset, so no guides are drawn.';
  else if (!usable.length) zoneNote = `This preset's guides are for a ${zones[0].refW} x ${zones[0].refH} frame shape, which does not match this source, so they are not drawn.`;
  else zoneNote = 'Guides: ' + usable.map(z => (z.type === 'safe' ? 'keep content inside the dashed line: ' : 'keep content out of the red box: ') + z.label).join('; ') + '. Check the frames by eye; the tool does not detect content in these areas.';
  $('preflight-report').replaceChildren(el('h3', { text: 'Measurements' }), table);
  $('thumbs').replaceChildren(el('h3', { text: 'Look at these frames' }),
    el('p', { class: 'hint', style: 'margin:0', text: 'Check there is no slate, countdown or colour bars at the start, and nothing important under the guides.' }),
    ...(zones.length ? [guideBox] : []), thumbs, el('p', { class: 'hint', text: zoneNote }));
  $('check-area').classList.remove('hidden');
}

// One checklist line: status icon, main text, optional smaller explanation.
function checkItem([status, text, more]) {
  const icon = { ok: '✓', warn: '!', bad: '✕', info: 'i' }[status];
  return el('li', { class: status }, el('span', { class: 'ic', text: icon }), el('div', {}, text, more ? el('small', { text: more }) : null));
}

// The automatic check in plain words, judged against the chosen placement.
function plainChecklist() {
  const a = state.analysis, src = state.src, v = src.video, spec = state.preset.spec, s = state.settings, st = state.config.strictness;
  const name = state.preset.custom ? 'your settings' : shortName(state.preset); // "Cineplex" rather than "Cineplex: cinema pre-show"
  const out = []; const add = (status, text, more) => out.push([status, text, more]);
  const t = targetFormat(s, src);

  // Shape and size
  const aspects = spec.allowedAspects || (spec.aspect ? [spec.aspect] : null);
  const shapeOk = !aspects || aspects.some(l => Math.abs(v.width / v.height - aspectValue(l)) / aspectValue(l) < 0.01);
  if (!shapeOk) add('bad', `Wrong shape: ${name} needs ${aspects.join(' or ')}, and this video is ${aspectLabel(v.width, v.height)}.`, 'This tool does not crop or reframe. Ask the creative team for a version in the right shape.');
  else if (t.scales) add('ok', `Shape is right. The picture will be resized from ${v.width} x ${v.height} to ${t.w} x ${t.h}.`, t.w > v.width ? 'Making a picture bigger than the original can look slightly soft.' : '');
  else add('ok', `Shape and size are right (${v.width} x ${v.height}).`);

  // Length
  if (spec.maxDurationSec && src.durationSec > spec.maxDurationSec + st.durationToleranceSec)
    add('bad', `Too long: ${src.durationSec.toFixed(1)} seconds. ${spec.maxDurationBy || name} allows up to ${spec.maxDurationSec} seconds.`, 'Ask for a shorter cut.');
  else add('ok', `Length is ${src.durationSec.toFixed(1)} seconds.`);

  // Frame rate
  if (spec.allowedFps && !spec.allowedFps.some(f => Math.abs(f - v.fps) / f < 0.001))
    add('warn', `Frame rate is ${fmtFps(v.fps)} fps. ${name} accepts ${spec.allowedFps.map(fmtFps).join(', ')} fps.`, 'Best fix: ask the editor for an export at an accepted frame rate. Changing it here creates repeated frames.');

  // Sound
  if (!src.audio) add(spec.audioRequired ? 'bad' : 'info', spec.audioRequired ? `No sound: ${name} requires audio.` : 'This video has no sound.');
  else if (a.audio?.silent) add(spec.audioRequired ? 'bad' : 'warn', 'The sound track is silent.', spec.audioRequired ? `${name} requires audible sound.` : '');
  else if (s.loudMode === 'max' && a.audio) {
    const loud = a.audio.rms > s.loudTarget + 0.05, peaky = a.audio.samplePeak > s.loudPeak + 0.05;
    if (loud || peaky) add('ok', `Sound found. It is louder than ${name} allows, so it will be turned down to fit.`,
      `Average ${a.audio.rms.toFixed(1)} dB (limit ${s.loudTarget}), peak ${a.audio.samplePeak.toFixed(1)} dB (limit ${s.loudPeak}).`);
    else add('ok', `Sound is within ${name}'s volume limits, so it will be left as it is.`,
      `Average ${a.audio.rms.toFixed(1)} dB (limit ${s.loudTarget}), peak ${a.audio.samplePeak.toFixed(1)} dB (limit ${s.loudPeak}).`);
  }
  else if (s.loudMode !== 'off') add('ok', `Sound found. The volume will be set automatically to ${name}'s level.`);
  else add('ok', 'Sound found. The volume will be left as it is.');

  // Repeated frames
  const d = a.video.dups, strict = !!spec.noDuplicateFrames; // strict = this placement is known to reject repeats
  if (d.conversion) add(strict ? 'bad' : 'warn', 'This video looks like it was converted from another frame rate (a repeated frame every few frames).',
    'Disney+ and others reject this as "duplicate frames". Ask the editor for an export at the original frame rate. Grain can hide exact repeats but may not pass their check.');
  else if (d.percent > st.dupPassPercent) add(strict ? 'warn' : 'info', `Some frames repeat (${d.percent.toFixed(1)}% of frames, longest hold ${d.longestRunSec.toFixed(1)} s), for example a held still or end card.`,
    strict ? `${spec.noDuplicateFramesBy || name} rejects repeated frames. Tick "Add light grain" below to prevent this.` : 'Usually fine. If a placement ever rejects it for repeated frames, tick "Add light grain" below.');
  else add('ok', 'No repeated frames.');

  // Black bars and black frames
  const bars = describeBars(a.video.crop, v.width, v.height, st.barTolerancePx);
  if (bars) add(spec.noLetterbox ? 'bad' : spec.barsAllowed ? 'info' : 'warn', `Black bars found (${bars}).`,
    spec.noLetterbox ? `${spec.noLetterboxBy || name} does not allow black bars. The picture must fill the frame; this needs fixing in the edit.`
      : spec.barsAllowed ? `${name} accepts this. The picture just will not fill the whole screen.`
      : 'Some placements do not allow black bars around the picture.');
  else add('ok', 'No black bars around the picture.');
  const ends = describeBlackEnds(a.video.black, src.durationSec);
  if (ends.start || ends.end) add('warn', 'Black frames at the ' + [ends.start ? `start (${ends.start.toFixed(1)} s)` : '', ends.end ? `end (${ends.end.toFixed(1)} s)` : ''].filter(Boolean).join(' and ') + '.', 'Usually fine, but some placements want the picture to start on the first frame.');

  // Interlacing
  if (a.video.idet && a.video.idet.interlacedPercent >= 5) add('warn', 'This video is interlaced (an older TV format).', 'Most placements need progressive video. Ask the editor for a progressive export.');
  return out;
}

// One safe-zone rectangle, positioned as a percentage of the frame so it scales with the preview.
function zoneBox(z) {
  const pos = `left:${100 * z.x / z.refW}%;top:${100 * z.y / z.refH}%;width:${100 * z.w / z.refW}%;height:${100 * z.h / z.refH}%;`;
  const style = z.type === 'safe'
    ? 'border:2px dashed #5fbf82;box-shadow:0 0 0 999px rgba(0,0,0,.5);'
    : 'border:2px solid #e0685a;background:rgba(224,104,90,.35);';
  return el('div', { style: 'position:absolute;pointer-events:none;box-sizing:border-box;' + pos + style, title: z.label });
}

// Save the finished file. Direct-to-disk where the browser allows, else a normal download.
// Returns { note, url } (url only for a browser download, for "Download again").
async function saveOutput(blob, name, handle) {
  if (window.__testSink) { await window.__testSink(blob, name); return { note: 'Test sink received ' + fmtBytes(blob.size) + '.' }; }
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return { note: 'Saved to the location you chose.' };
  }
  const url = URL.createObjectURL(blob); state.blobUrls.push(url);
  triggerDownload(url, name);
  return { note: 'Downloaded through your browser (check your Downloads folder).', url };
}
function triggerDownload(url, name) {
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
}

function onCancel() {
  state.cancelled = true;
  engine.cancel();
  hideProgress();
  showError('Cancelled. Nothing was saved.');
}

// Check the source file against the preset without encoding (use case 8).
function onCheckSource() {
  clearResult(); showError('');
  const extra = state.analysis ? { audio: state.analysis.audio, video: state.analysis.video } : null;
  const rows = verify(state.src, state.settings, state.preset, { source: null, fileName: null, strictness: state.config.strictness, extra });
  showResult('Check of your video against "' + state.preset.name + '" (no new file made)', rows, state.analysis ? [] : ['The automatic check has not finished, so loudness, repeated frames and black bars are not included.'], '');
}

// ---------- result and errors ----------
function clearResult() {
  $('sec-result').classList.add('hidden'); $('results').replaceChildren();
  for (const u of state.blobUrls) URL.revokeObjectURL(u);
  state.blobUrls = [];
}

function showResult(title, rows, notes, savedNote, dl) {
  const ov = overall(rows);
  const count = (st) => rows.filter(r => r.status === st).length;
  const where = state.preset.custom ? 'your settings' : state.preset.name;
  const label = {
    pass: `Ready for ${where}. The file matches the published spec.`,
    warn: `Ready for ${where}, with ${count('warn')} thing${count('warn') > 1 ? 's' : ''} to look at.`,
    fail: `${count('fail')} problem${count('fail') > 1 ? 's' : ''} found. The placement may reject this file.`
  }[ov];
  const block = el('div', { class: 'result-block' },
    el('h3', { text: title, style: 'margin-top:0' }),
    el('div', { class: 'banner ' + ov, text: label }));
  const row = el('div', { class: 'row' });
  if (dl) row.append(el('button', { class: 'primary', type: 'button', text: 'Download this file again', onclick: () => triggerDownload(dl.url, dl.name) }));
  if (savedNote) row.append(el('span', { class: 'hint', text: savedNote }));
  // Plain list of only the things that need attention; the full table sits behind "Full technical report".
  const issues = rows.filter(r => r.status === 'fail' || r.status === 'warn');
  const list = el('ul', { class: 'checklist', style: 'margin-top:12px' }, ...issues.map(r => checkItem([r.status === 'fail' ? 'bad' : 'warn',
    `${r.label}: ${r.actual}` + (r.expected ? ` (should be ${r.expected})` : ''), r.note || ''])));
  const table = el('table', {}, el('thead', {}, el('tr', {}, ...['Check', 'Expected', 'Actual', 'Result', 'Note'].map(h => el('th', { text: h })))));
  const body = el('tbody');
  for (const r of rows) body.append(el('tr', {}, el('td', { text: r.label }), el('td', { text: r.expected }), el('td', { text: r.actual }),
    el('td', {}, el('span', { class: 'tag ' + r.status, text: r.status.toUpperCase() })), el('td', { class: 'note', text: r.note || '' })));
  table.append(body);
  const custom = changedFromPreset();
  const report = el('details', { style: 'margin-top:14px' }, el('summary', { class: 'hint', style: 'cursor:pointer', text: 'Full technical report' }), table,
    ...(custom.length ? [el('p', { class: 'hint', text: 'Settings changed from the preset: ' + custom.join(', ') + '. The report checks against your current settings and the preset limits.' })] : []),
    ...(notes.length ? [el('ul', { class: 'notes' }, ...notes.map(n => el('li', { text: n })))] : []));
  block.append(row, list, report);
  $('results').append(block);
  $('sec-result').classList.remove('hidden');
  block.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changedFromPreset() {
  const d = state.defaults, s = state.settings;
  return Object.keys(d).filter(k => String(d[k] ?? '') !== String(s[k] ?? ''));
}

function showError(msg) { $('error').replaceChildren(...(msg ? [el('div', { class: 'msg bad', text: msg })] : [])); }

function friendlyError(e) {
  const m = String(e?.message || e);
  if (/memory|alloc|Aborted|out of bounds|RangeError|detached/i.test(m))
    return 'The browser ran out of memory while working on this file. Close other tabs and programs and try again, choose a smaller output (H.264 instead of ProRes, lower bitrate), or use desktop software for this one.\n\nDetails: ' + m.slice(0, 300);
  return m.slice(0, 600);
}

// ---------- safety nets ----------
// Things that go wrong in real use: closing the tab mid-encode, switching tabs
// (browsers slow background tabs), and errors nobody planned for.
function setupGuards() {
  window.addEventListener('beforeunload', (ev) => { if (state.running) { ev.preventDefault(); ev.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (state.running && document.hidden) showError('Tip: this tab is in the background. Browsers slow background tabs, so the work may pause until you come back. Keep it in the foreground.');
    else if (!document.hidden && $('error').textContent.startsWith('Tip: this tab')) showError('');
  });
  const unexpected = (ev) => {
    const e = ev.reason || ev.error || ev;
    if (state.running) return; // the running task reports its own errors
    showError('Something unexpected went wrong: ' + friendlyError(e));
  };
  window.addEventListener('unhandledrejection', unexpected);
  window.addEventListener('error', unexpected);
}

// ---------- start-up ----------
async function init() {
  const msgs = $('browser-msg');
  if (!window.WebAssembly || !window.Worker) {
    msgs.append(el('div', { class: 'msg bad', text: 'This browser cannot run the encoder. Use a current version of Edge or Chrome.' })); return;
  }
  const ua = navigator.userAgent;
  if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) msgs.append(el('div', { class: 'msg warn', text: 'Safari support is best effort and has not been tested. If anything fails, use Edge or Chrome.' }));
  else if (!window.showSaveFilePicker) msgs.append(el('div', { class: 'msg info', text: 'This browser will save the finished file as a normal download. Edge and Chrome can save larger files more safely.' }));

  try {
    state.config = await (await fetch('presets.json', { cache: 'no-cache' })).json();
  } catch (e) {
    msgs.append(el('div', { class: 'msg bad', text: 'Could not read presets.json. If you opened this page by double-clicking the file, use the web address instead. ' + e })); return;
  }
  // One clickable tile per placement: logo (or the name in the placement's colour),
  // a short line saying what it is, and a tick when chosen.
  const tick = (p) => {
    const tl = p.tile || {};
    const title = tl.title || p.name;
    const word = () => el('span', { class: 'word', text: title });
    const logo = el('div', { class: 'logo' });
    if (tl.logo) {
      const img = el('img', { src: tl.logo, alt: title });
      img.addEventListener('error', () => logo.replaceChildren(word())); // missing file: fall back to the name
      logo.append(img);
    } else logo.append(word());
    const b = el('button', { type: 'button', class: 'tile', 'data-id': p.id, 'aria-pressed': 'false', title: p.name, style: `--brand:${tl.color || 'var(--text)'}` },
      el('span', { class: 'chk', text: '✓' }), logo,
      ...(tl.logo ? [el('span', { class: 'sub', style: 'color:var(--text);font-weight:600', text: title })] : []),
      el('span', { class: 'sub', text: tl.sub || '' }));
    b.addEventListener('click', () => onTick(p, !state.ticked.includes(p.id)));
    return b;
  };
  const all = state.config.presets;
  $('ticks-main').replaceChildren(...all.filter(p => !p.custom && p.group === 'Main placements').map(tick));
  $('ticks-more').replaceChildren(...all.filter(p => !p.custom && p.group !== 'Main placements').map(tick));
  $('ticks-custom').replaceChildren(...all.filter(p => p.custom).map(tick));
  $('reset-preset').addEventListener('click', () => {
    const g = state.groups[state.active]; if (!g) return;
    g.settings = { ...g.defaults, noiseOn: raisesFps(g.defaults) }; state.settings = g.settings;
    buildSettingsForm(); update();
  });
  $('btn-customize').addEventListener('click', () => {
    state.customize = !state.customize;
    const g = state.groups[state.active]; if (g) g.customize = state.customize;
    showAdvanced();
  });
  $('grain').addEventListener('change', () => { state.settings.noiseOn = $('grain').checked; update(); });
  $('outname').addEventListener('input', () => { saveActiveName(); update(); });
  $('btn-encode').addEventListener('click', onEncode);
  $('btn-cancel').addEventListener('click', onCancel);
  $('btn-check').addEventListener('click', onCheckSource);
  setupDrop();
  setupGuards();
  onTicks(); // nothing ticked yet
  window.__app = { state, engine, loadFile, onTick, setActive, onEncode, onCheckSource, setSetting }; // handy for testing
}
init();
