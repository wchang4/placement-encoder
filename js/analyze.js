// analyze.js
// Preflight and post-encode measurements. Each function runs one or two ffmpeg
// "analysis only" passes (output goes to a null sink) and turns the log text
// into plain numbers. The parsing functions are separate and pure, so they are
// easy to read and test.

// ---------- parsing helpers ----------
const num = (s) => (s == null ? null : /inf/i.test(s) ? (/-/.test(s) ? -Infinity : Infinity) : parseFloat(s));
const lastMatch = (text, re) => { let m, last = null; const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = r.exec(text))) last = m; return last; };

// Loudness from ebur128 (LUFS, LRA, true peak) plus astats (RMS and sample peak).
export function parseAudioMeasure(lines) {
  const text = lines.join('\n');
  const I = lastMatch(text, /\bI:\s+(-?[\d.]+|-?inf)\s+LUFS/i);
  const LRA = lastMatch(text, /\bLRA:\s+(-?[\d.]+)\s+LU\b/i);
  const tp = lastMatch(text, /True peak:\s*\n?\s*Peak:\s+(-?[\d.]+|-?inf)\s+dBFS/i);
  const ov = text.lastIndexOf('Overall');
  const tail = ov >= 0 ? text.slice(ov) : '';
  const rms = /RMS level dB:\s*(-?[\d.]+|-?inf)/i.exec(tail);
  const pk = /Peak level dB:\s*(-?[\d.]+|-?inf)/i.exec(tail);
  const out = {
    lufs: I ? num(I[1]) : null, lra: LRA ? num(LRA[1]) : null, truePeak: tp ? num(tp[1]) : null,
    rms: rms ? num(rms[1]) : null, samplePeak: pk ? num(pk[1]) : null
  };
  out.silent = out.lufs === -Infinity || out.rms === -Infinity;
  return out;
}

// Pass-1 numbers from loudnorm (needed for accurate two-pass leveling).
export function parseLoudnorm(lines) {
  const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(lines.join('\n'));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return { i: +j.input_i, tp: +j.input_tp, lra: +j.input_lra, thresh: +j.input_thresh, offset: +j.target_offset };
  } catch (e) { return null; }
}

// Per-frame "how different is this frame from the one before" (average luma
// difference on a 0 to 255 scale). Near zero means the frame is a repeat.
// bitDepth: 10-bit video reports differences on a 0 to 1023 scale, so we scale back to 0 to 255.
export function parseFrameDiffs(lines, bitDepth = 8) {
  const out = [], k = 1 / Math.pow(2, Math.max(0, bitDepth - 8));
  for (const l of lines) { const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(l); if (m) out.push(+m[1] * k); }
  return out;
}

// Turn the diff list into duplicate-frame statistics.
export function dupStats(diffs, fps, threshold) {
  const total = diffs.length + 1; // N frames give N-1 comparisons
  let dups = 0, run = 0, longest = 0, held = 0;
  const singles = []; // positions of repeats that last exactly one frame
  diffs.forEach((d, i) => {
    if (d < threshold) { dups++; run++; longest = Math.max(longest, run); }
    else { if (run === 1) singles.push(i - 1); else if (run > 1) held += run; run = 0; }
  });
  if (run === 1) singles.push(diffs.length - 1); else if (run > 1) held += run;
  return {
    frames: total, duplicates: dups, percent: total > 1 ? 100 * dups / (total - 1) : 0,
    longestRun: longest, longestRunSec: fps ? longest / fps : 0,
    heldFrames: held,                     // repeats that belong to held stills (2+ frames in a row)
    conversion: conversionPattern(singles, total)
  };
}

// Frame rate conversion leaves a tell-tale rhythm: a single repeated frame every
// 4 to 6 frames (for example 23.976 to 29.97 repeats every 5th frame). Disney's
// "duplicate frames" rejection is about exactly this. Returns { every: N } or null.
function conversionPattern(singles, total) {
  if (singles.length < 8 || singles.length < 0.08 * total) return null;
  const gaps = {};
  for (let i = 1; i < singles.length; i++) { const g = singles[i] - singles[i - 1]; gaps[g] = (gaps[g] || 0) + 1; }
  const [best, count] = Object.entries(gaps).sort((a, b) => b[1] - a[1])[0] || [];
  if (!best || +best < 3 || +best > 12 || count < 0.6 * (singles.length - 1)) return null;
  return { every: +best };
}

export function parseCrop(lines) {
  const m = lastMatch(lines.join('\n'), /crop=(\d+):(\d+):(\d+):(\d+)/);
  return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
}

export function parseBlack(lines) {
  const segs = [];
  for (const l of lines) {
    const m = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/.exec(l);
    if (m) segs.push({ start: +m[1], end: +m[2], dur: +m[3] });
  }
  return segs;
}

export function parseIdet(lines) {
  // idet can print the summary more than once (some empty); use the fullest one.
  const re = /Multi frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)\s*Undetermined:\s*(\d+)/g;
  const text = lines.join('\n');
  let m, best = null, bestTot = -1;
  while ((m = re.exec(text))) {
    const t = m.slice(1).reduce((a, b) => a + Number(b), 0);
    if (t > bestTot) { best = m; bestTot = t; }
  }
  if (!best) return null;
  const [tff, bff, prog, und] = best.slice(1).map(Number);
  const tot = tff + bff + prog + und;
  return { tff, bff, progressive: prog, undetermined: und, interlacedPercent: tot ? 100 * (tff + bff) / tot : 0 };
}

// ---------- passes (these talk to the encoder) ----------

// Analysis passes read numbers from the log, so a failed pass must not be mistaken
// for "silence" or "no problems". Throw instead.
async function run(engine, args, what, onTime) {
  const res = await engine.exec(args, onTime);
  if (res.code !== 0) throw new Error(`The ${what} step failed: ` + res.lines.slice(-4).join(' | '));
  return res.lines;
}

// Loudness of the audio in `path`. Fast: audio only.
export async function measureAudio(engine, path, onTime) {
  const chain = 'ebur128=peak=true,astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level';
  const lines = await run(engine, ['-i', path, '-map', '0:a:0', '-vn', '-af', chain, '-f', 'null', '-'], 'audio measurement', onTime);
  return parseAudioMeasure(lines);
}

// loudnorm measuring pass (first half of two-pass leveling).
export async function measureLoudnorm(engine, path, target, onTime) {
  const af = `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`;
  const lines = await run(engine, ['-i', path, '-map', '0:a:0', '-vn', '-af', af, '-f', 'null', '-'], 'loudness measurement', onTime);
  return parseLoudnorm(lines);
}

// Frame-by-frame duplicate scan only (used after encoding).
export async function scanDuplicates(engine, path, fps, threshold, bitDepth, onTime) {
  const vf = 'extractplanes=y,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG';
  const lines = await run(engine, ['-i', path, '-map', '0:v:0', '-an', '-vf', vf, '-f', 'null', '-'], 'duplicate-frame scan', onTime);
  return dupStats(parseFrameDiffs(lines, bitDepth), fps, threshold);
}

// Full video preflight in ONE decode: interlacing, black bars, black frames and duplicates.
// (We read the brightness plane directly with extractplanes. Converting to grey with
// 'format=gray' adds dither noise in newer ffmpeg builds and would hide real repeats.)
export async function scanVideo(engine, path, fps, threshold, bitDepth, onTime) {
  const vf = [
    'idet',
    'cropdetect=limit=24:round=2:reset=0',
    'blackdetect=d=0.05:pix_th=0.10',
    'extractplanes=y',
    'tblend=all_mode=difference',
    'signalstats',
    'metadata=print:key=lavfi.signalstats.YAVG'
  ].join(',');
  const lines = await run(engine, ['-i', path, '-map', '0:v:0', '-an', '-vf', vf, '-f', 'null', '-'], 'video analysis', onTime);
  return {
    idet: parseIdet(lines),
    crop: parseCrop(lines),
    black: parseBlack(lines),
    dups: dupStats(parseFrameDiffs(lines, bitDepth), fps, threshold)
  };
}

// Small still frames (first, about 1 s in, last) so a person can spot slates,
// countdowns or colour bars. Returns [{label, url}].
export async function grabFrames(engine, path, durationSec) {
  const times = [['First frame', 0], ['At 1 second', Math.min(1, durationSec / 2)], ['Near the end', Math.max(0, durationSec - 0.5)]];
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const name = `thumb${i}.png`;
    try {
      const { code } = await engine.exec(['-ss', String(times[i][1]), '-i', path, '-frames:v', '1', '-vf', 'scale=480:-2', '-y', name]);
      if (code !== 0) continue;
      const data = await engine.takeOutput(name);
      out.push({ label: times[i][0], url: URL.createObjectURL(new Blob([data], { type: 'image/png' })) });
    } catch (e) { /* skip a frame we cannot grab */ }
  }
  return out;
}

// ---------- interpreting the numbers ----------

// Describe black bars: returns null when there are none worth reporting.
export function describeBars(crop, w, h, tol = 4) {
  if (!crop) return null;
  const top = crop.y, bottom = h - crop.h - crop.y, left = crop.x, right = w - crop.w - crop.x;
  if (Math.max(top, bottom, left, right) < tol) return null;
  const parts = [];
  if (top >= tol || bottom >= tol) parts.push(`top ${top} px, bottom ${bottom} px (letterbox)`);
  if (left >= tol || right >= tol) parts.push(`left ${left} px, right ${right} px (pillarbox)`);
  return parts.join('; ');
}

// Black at the very start or end of the file.
export function describeBlackEnds(segs, duration) {
  const out = {};
  for (const s of segs) {
    if (s.start <= 0.1) out.start = Math.max(out.start || 0, s.end);
    if (s.end >= duration - 0.1) out.end = Math.max(out.end || 0, s.dur);
  }
  return out; // {start: seconds of black at start, end: seconds of black at end}
}
