// plan.js
// The heart of the tool. No browser or encoder access, so it can be tested on its own.
//
// placements.json says what each placement ACCEPTS (copied from its spec sheet).
// From that, this file works out:
//   1. combine()     whether several placements can take the same file, and the rules that file must meet
//   2. planFiles()   the fewest files that cover the chosen placements (exact search, not by hand)
//   3. fileSettings() the encoder settings for one file
//   4. describeFile() what the tool will change, what the person needs to do, and what is good to know
// The page, the encoder and the final report all read the same plan.

import { targetFormat, spotLength, outDuration } from './args.js';
import { fmtFps, fmtBytes, estimateOutputBytes, aspectLabel } from './media.js';
import { describeBars, describeBlackEnds } from './analyze.js';
import { checkName } from './verify.js';

const near = (a, b, tol = 0.0005) => Math.abs(a - b) / b <= tol;
const joinAnd = (a) => { const u = [...new Set(a)]; return u.length <= 1 ? (u[0] || '') : u.slice(0, -1).join(', ') + ' and ' + u[u.length - 1]; };

// ---------- 1. combining placements ----------

// Lists: null means "anything". The result keeps only values every list allows.
function intersect(a, b, same = (x, y) => x === y) {
  if (a == null) return b == null ? null : b.slice();
  if (b == null) return a.slice();
  return a.filter(x => b.some(y => same(x, y)));
}
// Ranges: { min, max }, either may be missing.
function overlap(a = {}, b = {}) {
  const min = Math.max(a.min ?? -Infinity, b.min ?? -Infinity);
  const max = Math.min(a.max ?? Infinity, b.max ?? Infinity);
  return { min: isFinite(min) ? min : null, max: isFinite(max) ? max : null };
}

// Sound rules can be shared only when they are the same kind. Two "set to -24 LKFS"
// rules combine (strictest peak); two "no louder than" rules combine (strictest limits).
function combineLoudness(a, b) {
  if (!a) return { ok: true, value: b || null };
  if (!b) return { ok: true, value: a };
  if (a.mode !== b.mode) return { ok: false, why: 'they ask for different kinds of sound level' };
  if (a.mode === 'max') return { ok: true, value: { mode: 'max', average: Math.min(a.average, b.average), peak: Math.min(a.peak, b.peak) } };
  if (Math.abs(a.target - b.target) > 0.5) return { ok: false, why: `they ask for different sound levels (${a.target} and ${b.target})` };
  return { ok: true, value: { mode: a.mode, target: a.target, peak: Math.min(a.peak, b.peak) } };
}

// The rules a file must meet to suit every placement in `list`, or { ok: false, why }.
// `lengthSec` is how long the file will be (needed for size limits).
export function combine(list, cfg, lengthSec) {
  const a = { formats: null, shortEdge: null, minShortEdge: null, frameRates: null, videoKbps: {}, maxSizeMB: null,
    h264Profiles: null, sampleRates: null, audioKbps: {}, audioRequired: false, loudness: null, tailBlackSec: 0,
    noLetterbox: false, barsAllowed: true, noDuplicateFrames: false, by: {} };
  const who = (k, p) => { (a.by[k] ||= []).push(p.short); };
  for (let i = 0; i < list.length; i++) {
    const p = list[i], x = p.accepts || {};
    a.formats = intersect(a.formats, x.formats ?? null);
    if (a.formats && !a.formats.length) return { ok: false, why: 'they accept different file types' };
    if (x.shortEdge != null) {
      if (a.shortEdge != null && a.shortEdge !== x.shortEdge) return { ok: false, why: 'they ask for different picture sizes' };
      a.shortEdge = x.shortEdge;
    }
    if (x.minShortEdge != null) a.minShortEdge = Math.max(a.minShortEdge ?? 0, x.minShortEdge);
    a.frameRates = intersect(a.frameRates, x.frameRates ?? null, (f, g) => near(f, g));
    if (a.frameRates && !a.frameRates.length) return { ok: false, why: 'they accept different frame rates' };
    a.videoKbps = overlap(a.videoKbps, x.videoKbps);
    if (x.videoKbps?.min != null && a.videoKbps.min === x.videoKbps.min) a.by.videoMin = p.short;
    if (x.videoKbps?.max != null && a.videoKbps.max === x.videoKbps.max) a.by.videoMax = p.short;
    if (x.maxSizeMB != null && (a.maxSizeMB == null || x.maxSizeMB < a.maxSizeMB)) { a.maxSizeMB = x.maxSizeMB; a.by.size = p.short; }
    a.h264Profiles = intersect(a.h264Profiles, x.h264Profiles ?? null);
    a.sampleRates = intersect(a.sampleRates, x.sampleRates ?? null);
    if (a.sampleRates && !a.sampleRates.length) return { ok: false, why: 'they ask for different audio sample rates' };
    a.audioKbps = overlap(a.audioKbps, x.audioKbps);
    if (a.audioKbps.min != null && a.audioKbps.max != null && a.audioKbps.min > a.audioKbps.max) return { ok: false, why: 'their audio bitrate ranges do not overlap' };
    if (x.audioRequired) { a.audioRequired = true; who('audio', p); }
    const L = combineLoudness(a.loudness, x.loudness || null);
    if (!L.ok) return { ok: false, why: L.why };
    a.loudness = L.value;
    if (x.loudness) who('loud', p);
    const tail = x.tailBlackSec || 0;
    if (i > 0 && tail !== a.tailBlackSec) return { ok: false, why: 'only some of them want black added at the end' };
    a.tailBlackSec = tail;
    if (x.letterbox === 'not allowed') { a.noLetterbox = true; who('noLetterbox', p); }
    if (x.letterbox !== 'allowed') a.barsAllowed = false;
    if (x.duplicateFrames === 'not allowed') { a.noDuplicateFrames = true; who('noDup', p); }
  }

  // File type: the first one in the preference list that everyone accepts.
  const formats = a.formats ?? cfg.formatPreference;
  a.format = cfg.formatPreference.find(f => formats.includes(f)) || formats[0];
  const F = cfg.formats[a.format];
  if (!F) return { ok: false, why: `unknown file type "${a.format}"` };

  // Sound bitrate: the default, moved inside everyone's range.
  const E = cfg.encoding;
  a.audioOut = F.acodec === 'aac' ? clamp(E.audioKbps, a.audioKbps.min, a.audioKbps.max) : null;
  a.sampleRate = a.sampleRates ? (a.sampleRates.includes(E.sampleRate) ? E.sampleRate : a.sampleRates[0]) : E.sampleRate;

  // Video bitrate (H.264): the quality default, moved inside everyone's range, and low
  // enough that the file fits the strictest size limit for its length.
  if (F.vcodec === 'h264') {
    let lo = a.videoKbps.min, hi = a.videoKbps.max != null ? a.videoKbps.max * 0.9 : null;
    if (a.maxSizeMB != null && lengthSec > 0) {
      const fit = a.maxSizeMB * 8000 / lengthSec * E.sizeSafety - (a.audioOut || 0);
      hi = hi == null ? fit : Math.min(hi, fit);
      if (hi === fit) a.by.videoMax = a.by.size;
    }
    if (lo != null && hi != null && lo > hi) {
      return { ok: false, why: a.maxSizeMB != null && hi < (a.videoKbps.max ?? Infinity) * 0.9
        ? `${a.by.size}'s ${a.maxSizeMB} MB limit cannot hold a ${Math.round(lengthSec)} s file at ${a.by.videoMin}'s minimum of ${fmtK(lo)}`
        : 'their video bitrate ranges do not overlap' };
    }
    const floor = lo != null ? lo * 1.1 : null;
    let k = E.videoKbps;
    if (floor != null && hi != null && floor > hi) k = (lo + hi) / 2;
    else k = clamp(k, floor, hi);
    a.videoOut = Math.round(k / 100) * 100;
    a.h264Profile = !a.h264Profiles || a.h264Profiles.includes('High') ? 'high' : 'main';
  }
  return { ok: true, rules: a };
}

const clamp = (x, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, x));
const fmtK = (k) => (k / 1000).toFixed(k % 1000 ? 1 : 0) + ' Mbps';

// ---------- 2. fewest files ----------

// Exact search: every subset that can share a file is found first, then the partition
// with the fewest files (ties go to the one that keeps the placement list order).
// With up to 14 placements this is a few hundred thousand cheap steps.
export function planFiles(chosen, cfg, ctx = {}) {
  const n = chosen.length;
  if (!n) return [];
  if (n > 16) throw new Error('Too many placements chosen at once (16 is the limit).');
  const length = (tail) => (ctx.lengthSec ?? cfg.encoding.assumeLengthSec) + tail;
  const full = (1 << n) - 1;
  const ok = new Map();
  const sub = (mask) => chosen.filter((_, i) => mask & (1 << i));
  for (let m = 1; m <= full; m++) {
    const list = sub(m);
    const tail = list[0].accepts?.tailBlackSec || 0;
    const r = combine(list, cfg, length(tail));
    if (r.ok) ok.set(m, { rules: r.rules });
    // A placement that cannot be made even on its own still gets its own (blocked) file,
    // so the page can say why.
    else if (list.length === 1) ok.set(m, { rules: null, why: r.why });
  }
  // Tie-break: among layouts with the same number of files, prefer the one that gives
  // each placement the lightest file type it accepts (YouTube should not be handed
  // Cineplex's ProRes master just because YouTube would accept it).
  const rank = (f) => { const i = cfg.formatPreference.indexOf(f); return i < 0 ? cfg.formatPreference.length : i; };
  const own = chosen.map(p => { const r = combine([p], cfg, length(p.accepts?.tailBlackSec || 0)); return r.ok ? rank(r.rules.format) : 0; });
  const penalty = (s) => { const g = ok.get(s); if (!g.rules) return 0; let x = 0; for (let i = 0; i < n; i++) if (s & (1 << i)) x += rank(g.rules.format) - own[i]; return x; };
  // best[m] = [fewest files, then least penalty] covering the set m
  const best = new Array(full + 1).fill(null), pick = new Array(full + 1).fill(0);
  best[0] = [0, 0];
  for (let m = 1; m <= full; m++) {
    const low = m & -m; // the first placement still uncovered must be in the next file
    for (let s = m; s; s = (s - 1) & m) {
      if (!(s & low) || !ok.has(s) || !best[m ^ s]) continue;
      const c = [best[m ^ s][0] + 1, best[m ^ s][1] + penalty(s)];
      if (!best[m] || c[0] < best[m][0] || (c[0] === best[m][0] && c[1] < best[m][1])) { best[m] = c; pick[m] = s; }
    }
  }
  const files = [];
  for (let m = full; m; m ^= pick[m]) {
    const s = pick[m];
    files.push({ members: sub(s), ...ok.get(s) });
  }
  files.sort((x, y) => chosen.indexOf(x.members[0]) - chosen.indexOf(y.members[0]));
  return files.map((f, i) => ({ ...f, key: f.members.map(p => p.id).join('+'), index: i }));
}

// Why two placements cannot share a file ('' when they can). Used by the spec check page.
export function whyApart(p, q, cfg, lengthSec) {
  const r = combine([p, q], cfg, (lengthSec ?? cfg.encoding.assumeLengthSec) + (p.accepts?.tailBlackSec || 0));
  return r.ok ? '' : r.why;
}

// ---------- 3. encoder settings for one file ----------

export function fileSettings(file, cfg, custom = {}) {
  const a = file.rules, F = cfg.formats[a.format], E = cfg.encoding;
  const s = {
    container: F.container, vcodec: F.vcodec, proresProfile: F.proresProfile || 'hq',
    h264Profile: a.h264Profile || E.h264Profile, pixFmt: E.pixFmt,
    width: a.shortEdge ? Math.round(a.shortEdge * 16 / 9) : null, height: a.shortEdge || null, // targetFormat keeps the video's shape
    fps: 'native', allowedFps: a.frameRates,
    bitrateMode: 'cbr', bitrateKbps: a.videoOut || E.videoKbps, // Generous bitrates look the same with the quicker setting (about twice as fast);
    // tight ones (Bell's 25 MB, Corus's 8 Mbps) keep the more careful one.
    x264Preset: (a.videoOut || E.videoKbps) >= (E.quickPresetFromKbps ?? Infinity) ? (E.x264PresetQuick || E.x264Preset) : E.x264Preset, bframes: E.bframes,
    gopSeconds: E.gopSeconds, closedGop: E.closedGop, faststart: F.faststart, stripEditLists: F.stripEditLists,
    tagBt709: E.tagBt709, acodec: F.acodec, sampleRate: a.sampleRate, bitDepth: F.bitDepth || 16, channels: E.channels,
    audioKbps: a.audioOut || E.audioKbps,
    loudMode: a.loudness?.mode || 'off',
    loudTarget: a.loudness ? (a.loudness.mode === 'max' ? a.loudness.average : a.loudness.target) : -14,
    loudPeak: a.loudness?.peak ?? -1,
    noiseOn: false, noiseStrength: cfg.grain?.strength ?? 4, dupCheck: false, // set in describeFile
    tailBlackSec: a.tailBlackSec || 0,
  };
  return Object.assign(s, custom);
}

// ---------- 4. describing one file ----------

// Everything the page shows about one file, given the source video (and the automatic
// check, once it has run). Returns plain-language lists plus the numbers for the slip.
export function describeFile(file, cfg, video, custom = {}) {
  const out = { changes: [], todo: [], good: [], blocked: false };
  const bad = (text, more) => { out.todo.push({ level: 'bad', text, more }); out.blocked = true; };
  const warn = (text, more) => out.todo.push({ level: 'warn', text, more });
  const info = (text, more) => out.good.push({ text, more });
  if (!file.rules) { bad(`These placements cannot share a file, and this one cannot be made on its own: ${file.why}.`); return out; }
  const a = file.rules, names = file.members.map(p => p.short);
  const s = fileSettings(file, cfg, custom);
  out.settings = s;
  out.format = cfg.formats[a.format].label;
  if (!video?.src) { out.waiting = true; return out; }

  const src = video.src, v = src.video, an = video.analysis, st = cfg.strictness;
  const t = targetFormat(s, src);
  const spot = spotLength(outDuration(src, t), t.fps, cfg.spotLengths);
  const mainSec = spot ? spot.exactSec : outDuration(src, t);
  const lengthSec = mainSec + (s.tailBlackSec || 0);
  Object.assign(out, { t, spot, mainSec, lengthSec });
  // "Rogers asks", "Rogers and Disney+ ask": who sets a rule, with the verb to match.
  const who = (key) => (a.by[key]?.length ? a.by[key] : names);
  const name = (key) => joinAnd(who(key));
  const say = (key, one, many) => `${name(key)} ${who(key).length > 1 ? many : one}`;
  const all = (one, many) => `${joinAnd(names)} ${names.length > 1 ? many : one}`;

  // Picture size
  if (t.scales) {
    out.changes.push({ text: `Resized from ${v.width} x ${v.height} to ${t.w} x ${t.h}` });
    if (t.w > v.width) warn(`Your video is smaller than ${t.w} x ${t.h}, so it will be enlarged and may look soft.`, 'A larger export from the editor will look sharper.');
  }
  if (a.minShortEdge && Math.min(t.w, t.h) < a.minShortEdge) warn(`The picture is ${Math.min(t.w, t.h)} px on its short side. ${all('wants', 'want')} at least ${a.minShortEdge} px.`);

  // Frame rate
  if (t.conform) out.changes.push({ text: `${fmtFps(v.fps)} fps to ${fmtFps(t.fps)} fps`, more: `Every frame is kept and played ${t.fps < v.fps ? '0.1% slower' : '0.1% faster'}, with the sound matched. Nothing is dropped or repeated.` });
  else if (t.lowers) {
    // Same as Adobe Media Encoder's default ("frame sampling"): frames are dropped evenly.
    const r = v.fps / t.fps, clean = Math.abs(r - Math.round(r)) < 0.01; // 60 to 30 drops every other frame
    out.changes.push({ text: `${fmtFps(v.fps)} fps to ${fmtFps(t.fps)} fps`, more: clean ? 'Every other frame is dropped, so nothing repeats.' : 'Frames are dropped evenly, so nothing repeats. This is what editing and encoding software does by default.' });
  }
  else if (t.raises) {
    out.changes.push({ text: `${fmtFps(v.fps)} fps to ${fmtFps(t.fps)} fps, with light grain`, more: 'Raising the frame rate repeats some frames. Grain hides the exact repeats.' });
    s.noiseOn = custom.noiseOn ?? true;
    if (a.noDuplicateFrames) warn(`${say('noDup', 'rejects', 'reject')} repeated frames, and raising ${fmtFps(v.fps)} fps to ${fmtFps(t.fps)} repeats some.`, `Grain hides exact repeats, but an export at ${fmtFps(t.fps)} fps from the editor is safer.`);
  }

  // Length
  if (spot && (spot.cut > 0.0005 || spot.pad > 0.0005) && !(t.conform && Math.abs(spot.exactSec - outDuration(src, t)) < 0.02)) {
    out.changes.push(spot.cut
      ? { text: `Trimmed to exactly ${spot.seconds} seconds`, more: `The last ${spot.cut.toFixed(2)} s of the video is cut.` }
      : { text: `Filled to exactly ${spot.seconds} seconds`, more: `The last frame is held for ${spot.pad.toFixed(2)} s, with silence.` });
  } else if (!spot) info(`${src.durationSec.toFixed(1)} seconds is not close to a standard ${cfg.spotLengths.lengths.join(', ')} second spot, so the length is kept as it is.`);
  if (s.tailBlackSec) out.changes.push({ text: `${s.tailBlackSec} seconds of black added at the end`, more: `With silence, as ${all('asks', 'ask')}.` });

  // Sound
  if (!src.audio) { if (a.audioRequired) bad(`Your video has no sound. ${say('audio', 'requires', 'require')} sound.`); else info('Your video has no sound, so the file will have none.'); }
  else if (an?.audio?.silent) { if (a.audioRequired) bad(`The sound track is silent. ${say('audio', 'requires', 'require')} audible sound.`); else warn('The sound track is silent.'); }
  else if (s.loudMode === 'max') {
    if (an?.audio) {
      const cut = an.audio.rms - s.loudTarget, peaky = an.audio.samplePeak > s.loudPeak + 0.05;
      if (cut > 0.05) out.changes.push({ text: `Sound turned down ${cut.toFixed(1)} dB`, more: `${say('loud', 'allows', 'allow')} an average of ${s.loudTarget} dB at most; yours is ${an.audio.rms.toFixed(1)} dB.` });
      else if (peaky) out.changes.push({ text: `Sound peaks held to ${s.loudPeak} dB`, more: `Your peaks reach ${an.audio.samplePeak.toFixed(1)} dB.` });
      else info(`Sound is within ${name('loud')}'s limits (average ${an.audio.rms.toFixed(1)} dB, peak ${an.audio.samplePeak.toFixed(1)} dB), so it is left as it is.`);
    } else out.changes.push({ text: `Sound kept within ${s.loudTarget} dB average, ${s.loudPeak} dB peak` });
  }
  else if (s.loudMode === 'lufs') out.changes.push({ text: `Sound set to ${s.loudTarget} LKFS`, more: (an?.audio?.lufs != null && isFinite(an.audio.lufs) ? `Yours measures ${an.audio.lufs.toFixed(1)}. ` : '') + `Peaks held under ${s.loudPeak} dB, as ${say('loud', 'asks', 'ask')}.` });
  else if (s.loudMode === 'rms') out.changes.push({ text: `Sound brought to ${s.loudTarget} dB average`, more: `Peaks held under ${s.loudPeak} dB, as ${say('loud', 'asks', 'ask')}.` });

  // What the automatic check found
  if (an?.video) {
    const d = an.video.dups;
    if (d.conversion) (a.noDuplicateFrames ? bad : warn)('Your video looks converted from another frame rate (a repeated frame every few frames).',
      `${a.noDuplicateFrames ? say('noDup', 'rejects', 'reject') + ' this as duplicate frames. ' : ''}Ask the editor for an export at the original frame rate.`);
    else if (d.percent > st.dupPassPercent) {
      if (a.noDuplicateFrames) {
        s.noiseOn = custom.noiseOn ?? true;
        out.changes.push({ text: 'Light grain added', more: `Your video holds some frames still (${d.percent.toFixed(1)}%, longest ${d.longestRunSec.toFixed(1)} s). ${say('noDup', 'rejects', 'reject')} exact repeats; grain makes each frame slightly different.` });
      } else info(`Some frames repeat (${d.percent.toFixed(1)}%, for example a held end card). That is fine for ${joinAnd(names)}.`);
    }
    const bars = describeBars(an.video.crop, v.width, v.height, st.barTolerancePx);
    if (bars) {
      if (a.noLetterbox) bad(`Black bars found (${bars}). ${say('noLetterbox', 'does not allow', 'do not allow')} them.`, 'The picture must fill the frame. This needs a new export from the editor.');
      else if (a.barsAllowed) info(`Black bars found (${bars}). ${all('accepts', 'accept')} them.`);
      else warn(`Black bars found (${bars}).`, 'Some placements reject black bars around the picture.');
    }
    const ends = describeBlackEnds(an.video.black, src.durationSec);
    if (ends.start) info(`Your video starts with ${ends.start.toFixed(1)} s of black.`, 'Some placements want the picture from the first frame.');
    if (an.video.idet && an.video.idet.interlacedPercent >= 5) warn('Your video is interlaced (an older TV format).', 'Ask the editor for a progressive export.');
  }
  if (v.cfrLikely === false) info('Your video may have a variable frame rate. The file is made at a constant rate.');
  if (s.tagBt709 && v.colorSpace && v.colorSpace !== 'bt709') info(`Your video is tagged "${v.colorSpace}". The file is labelled BT.709, but the colours are not converted.`);

  // Size
  const est = estimateOutputBytes(s, t.w, t.h, t.fps, lengthSec);
  out.estBytes = est;
  const estMB = est / 1e6, lim = cfg.limits;
  if (a.maxSizeMB != null && estMB > a.maxSizeMB) warn(`The file is expected to be about ${fmtBytes(est)}, over ${a.by.size}'s ${a.maxSizeMB} MB limit.`);
  if (estMB >= lim.memoryBlockMB) bad(`The file would be about ${fmtBytes(est)}, more than this browser tool can safely make.`, 'Use a shorter video or desktop encoding software.');
  else if (estMB >= lim.memoryWarnMB) warn(`The file will be large (about ${fmtBytes(est)}).`, 'Close other tabs and programs first. It may fail on computers with 8 GB of memory.');
  // Re-check every frame of the finished file only where it matters: placements that reject
  // repeated frames or black bars, files with grain, and files with black added at the end.
  // Elsewhere it would only add time.
  if (custom.dupCheck == null) s.dupCheck = !!(a.noDuplicateFrames || a.noLetterbox || s.noiseOn || s.tailBlackSec);
  out.settings = s;
  return out;
}

// ---------- names ----------

// Placements that share a file but have different file name rules get their own copy of
// the same encode, each with its own name. Placements without a rule share one name.
export function nameSlots(file) {
  const slots = [];
  for (const p of file.members) {
    const rule = p.naming && (p.naming.pattern || p.naming.maxLength || p.naming.allowedChars) ? p.naming : null;
    const key = rule ? JSON.stringify([rule.pattern, rule.maxLength, rule.allowedChars]) : '';
    let slot = slots.find(x => x.key === key);
    if (!slot) slots.push(slot = { key, rule, for: [] });
    slot.for.push(p.short);
  }
  return slots;
}

// Problems with the names typed for every file (empty, illegal, against a rule, or used twice).
export function checkNames(files, ext) {
  const seen = new Map(), problems = new Map();
  const note = (k, level, text) => { (problems.get(k) || problems.set(k, []).get(k)).push({ level, text }); };
  files.forEach((f, i) => f.slots.forEach((slot, j) => {
    const k = `${i}:${j}`, nm = (slot.name || '').trim();
    if (!nm) { note(k, 'bad', 'Type a file name.'); return; }
    if (/[\\/:*?"<>|]/.test(nm)) note(k, 'bad', 'Remove these characters from the name: \\ / : * ? " < > |');
    const r = checkName(nm + '.' + ext(f), slot.rule);
    if (r && !r.ok) note(k, 'warn', `${joinAnd(slot.for)} ${slot.for.length > 1 ? 'need' : 'needs'} ${r.expected}${slot.rule.example ? `, for example ${slot.rule.example}` : ''}.`);
    const full = (nm + '.' + ext(f)).toLowerCase();
    if (seen.has(full)) { note(k, 'bad', 'Another file already has this name.'); }
    else seen.set(full, k);
  }));
  return problems;
}

// ---------- spec check (validation of placements.json) ----------

const KNOWN = ['formats', 'shortEdge', 'minShortEdge', 'frameRates', 'videoKbps', 'maxSizeMB', 'h264Profiles', 'sampleRates',
  'audioKbps', 'audioRequired', 'loudness', 'tailBlackSec', 'letterbox', 'duplicateFrames'];

export function validatePlacement(p, cfg) {
  const errors = [], gaps = [];
  if (!p.id || /\s/.test(p.id)) errors.push('Needs an "id" with no spaces.');
  if (!p.name) errors.push('Needs a "name".');
  if (!p.short) errors.push('Needs a "short" name (used in messages, for example "Rogers").');
  if (!p.tile?.title) errors.push('Needs "tile.title" (the word on the tile).');
  const a = p.accepts;
  if (!a) { errors.push('Needs an "accepts" block.'); return { errors, gaps }; }
  for (const k of Object.keys(a)) if (!KNOWN.includes(k)) errors.push(`"accepts.${k}" is not a field the tool knows. Check the spelling.`);
  if (!a.formats?.length) gaps.push('File types not given: any type is assumed.');
  else for (const f of a.formats) if (!cfg.formats[f]) errors.push(`Unknown file type "${f}". Known: ${Object.keys(cfg.formats).join(', ')}.`);
  if (a.frameRates == null) gaps.push('Frame rates not given: the video\'s own rate is kept.');
  if (a.loudness == null) gaps.push('No sound level rule: the sound is left as it is.');
  if (a.loudness && !['lufs', 'max', 'rms'].includes(a.loudness.mode)) errors.push('"loudness.mode" must be lufs, max or rms.');
  if (a.loudness?.mode === 'max' && (a.loudness.average == null || a.loudness.peak == null)) errors.push('A "max" sound rule needs "average" and "peak".');
  if (a.loudness && a.loudness.mode !== 'max' && (a.loudness.target == null || a.loudness.peak == null)) errors.push('A sound target needs "target" and "peak".');
  if (a.letterbox && !['allowed', 'not allowed'].includes(a.letterbox)) errors.push('"letterbox" must be "allowed" or "not allowed".');
  if (a.duplicateFrames && a.duplicateFrames !== 'not allowed') errors.push('"duplicateFrames" can only be "not allowed".');
  if (!p.source?.label) gaps.push('No source: say which spec sheet this came from.');
  const r = combine([p], cfg, cfg.encoding.assumeLengthSec + (a.tailBlackSec || 0));
  if (!r.ok) errors.push('Cannot be made on its own: ' + r.why + '.');
  return { errors, gaps, rules: r.rules };
}

// Report-friendly version of a file's rules, in the shape verify.js expects.
export function reportSpec(file) {
  const a = file.rules;
  return {
    name: file.members.map(p => p.name).join(', '),
    spec: {
      minKbps: a.videoKbps.min, maxKbps: a.videoKbps.max, allowedFps: a.frameRates, minShortEdge: a.minShortEdge,
      audioRequired: a.audioRequired, minAudioKbps: a.audioKbps.min, maxSizeMB: a.maxSizeMB,
      h264ProfilesAllowed: a.h264Profiles, noLetterbox: a.noLetterbox, barsAllowed: a.barsAllowed,
      noDuplicateFrames: a.noDuplicateFrames,
      noLetterboxBy: (a.by.noLetterbox || []).join(' and '), noDuplicateFramesBy: (a.by.noDup || []).join(' and ')
    },
    naming: null
  };
}

export { aspectLabel };
