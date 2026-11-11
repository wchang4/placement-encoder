// verify.js
// Compares a probed file against the spec and returns PASS / WARN / FAIL rows.
//
// IMPORTANT: this is a technical check against the documented values only.
// It does NOT guarantee a placement will accept the file.
//
// Inputs:
//   summary  - summarize(ffprobe JSON) of the file being checked
//   settings - the settings on screen (what we asked for)
//   preset   - the chosen preset (its "spec" holds ranges and limits)
//   opts     - { source: summary of the original file (or null when checking
//                       a source file directly), fileName, strictness,
//                extra: optional measurements { audio, video } from analyze.js }

import { fmtFps, fmtKbps, fmtBytes, aspectLabel, aspectValue } from './media.js';
import { describeBars, describeBlackEnds } from './analyze.js';

const PRORES_NAMES = { proxy: 'proxy', lt: 'lt', '422': 'standard', hq: 'hq', '4444': '4444' };

export function verify(summary, settings, preset, opts) {
  const spec = preset.spec, st = opts.strictness;
  const rows = [];
  const add = (label, expected, actual, status, note = '') => rows.push({ label, expected, actual, status, note });
  const v = summary.video, a = summary.audio, src = opts.source;

  // 1. Container
  add('Container', settings.container.toUpperCase(), (summary.container || '?').toUpperCase(),
    summary.container === settings.container ? 'pass' : 'fail');

  // 2. Video tracks
  add('Video tracks', '1', String(summary.videoCount), summary.videoCount === 1 ? 'pass' : 'fail',
    summary.videoCount === 1 ? '' : 'Placements usually require a single video track.');

  if (!v) { add('Video', 'present', 'none', 'fail'); return rows; }

  // 3. Video codec (+ ProRes flavour)
  const wantCodec = settings.vcodec;
  let codecOk = v.codec === wantCodec;
  let wantLabel = wantCodec === 'h264' ? 'H.264' : 'ProRes ' + PRORES_NAMES[settings.proresProfile];
  let gotLabel = v.codec === 'h264' ? 'H.264' : v.codec === 'prores' ? 'ProRes ' + (v.profile || '?') : v.codec;
  if (codecOk && wantCodec === 'prores') codecOk = v.profile.toLowerCase() === PRORES_NAMES[settings.proresProfile];
  add('Video codec', wantLabel, gotLabel, codecOk ? 'pass' : 'fail');

  // 4. H.264 profile
  if (v.codec === 'h264' && spec.h264ProfilesAllowed) {
    add('H.264 profile', spec.h264ProfilesAllowed.join(' / '), v.profile || '?',
      spec.h264ProfilesAllowed.includes(v.profile) ? 'pass' : 'warn');
  }

  // 5. Resolution
  const wantW = settings.width, wantH = settings.height;
  if (wantW && wantH) {
    add('Resolution', `${wantW} x ${wantH}`, `${v.width} x ${v.height}`, v.width === wantW && v.height === wantH ? 'pass' : 'fail');
  } else {
    add('Resolution', 'keep source', `${v.width} x ${v.height}`, 'info');
  }
  if (spec.minShortEdge) {
    const edge = Math.min(v.width, v.height);
    add('Short edge', `at least ${spec.minShortEdge} px`, `${edge} px`, edge >= spec.minShortEdge ? 'pass' : 'fail');
  }

  // 6. Aspect ratio
  const aspects = spec.allowedAspects || (spec.aspect ? [spec.aspect] : null);
  if (aspects) {
    const got = v.width / v.height;
    const ok = aspects.some(l => Math.abs(got - aspectValue(l)) / aspectValue(l) < 0.01);
    add('Aspect ratio', aspects.join(' or '), aspectLabel(v.width, v.height), ok ? 'pass' : 'fail',
      ok ? '' : 'This tool does not crop or reframe. A file with the right shape must be supplied.');
  }

  // 7. Frame rate
  const fpsTol = st.fpsTolerancePercent / 100;
  const close = (x, y) => Math.abs(x - y) / y <= Math.max(fpsTol, 0.0005);
  if (spec.allowedFps) {
    const ok = spec.allowedFps.some(f => close(v.fps, f));
    add('Frame rate', spec.allowedFps.map(fmtFps).join(' / ') + ' fps', fmtFps(v.fps) + ' fps', ok ? 'pass' : 'fail');
  } else if (settings.fps === 'native' && src?.video) {
    add('Frame rate', 'same as source (' + fmtFps(src.video.fps) + ')', fmtFps(v.fps) + ' fps', close(v.fps, src.video.fps) ? 'pass' : 'fail');
  } else if (settings.fps !== 'native') {
    add('Frame rate', fmtFps(+settings.fps) + ' fps', fmtFps(v.fps) + ' fps', close(v.fps, +settings.fps) ? 'pass' : 'fail');
  } else {
    add('Frame rate', 'any', fmtFps(v.fps) + ' fps', 'info');
  }
  if (v.cfrLikely != null) {
    add('Constant frame rate', 'constant', v.cfrLikely ? 'constant' : 'possibly variable',
      v.cfrLikely ? 'pass' : 'warn', v.cfrLikely ? '' : 'Base rate differs from average rate. A full frame-by-frame check arrives in Phase 2.');
  }

  // 8. Scan type
  const prog = ['progressive', 'unknown', ''].includes(v.fieldOrder);
  add('Scan type', 'progressive', v.fieldOrder === 'unknown' || v.fieldOrder === '' ? 'progressive (not flagged interlaced)' : v.fieldOrder, prog ? 'pass' : 'warn');

  // 9. Pixel format
  const wantPix = settings.vcodec === 'prores' ? (settings.proresProfile === '4444' ? 'yuv444p12le' : 'yuv422p10le') : settings.pixFmt;
  add('Pixel format', wantPix, v.pixFmt, v.pixFmt === wantPix ? 'pass' : 'fail');

  // 10. Colour tags
  if (settings.tagBt709) {
    const ok = v.colorSpace === 'bt709' && v.colorPrimaries === 'bt709' && v.colorTransfer === 'bt709';
    add('Colour tags', 'BT.709', [v.colorSpace, v.colorPrimaries, v.colorTransfer].filter(Boolean).join(' / ') || 'none', ok ? 'pass' : 'warn');
  }

  // 11. Video bitrate range
  if (v.kbps != null && (spec.minKbps != null || spec.maxKbps != null)) {
    const lo = spec.minKbps, hi = spec.maxKbps, k = v.kbps;
    const range = (lo != null ? fmtK(lo) : '0') + ' to ' + (hi != null ? fmtK(hi) : 'no limit');
    let status = 'pass', note = '';
    const warnBand = st.bitrateWarnPercent / 100;
    if (lo != null && k < lo) { status = k >= lo * (1 - warnBand) ? 'warn' : 'fail'; }
    if (hi != null && k > hi) { status = k <= hi * (1 + warnBand) ? 'warn' : 'fail'; }
    if (v.kbpsEstimated) note = 'Estimated from the whole file.';
    add('Video bitrate', range, fmtKbps(k), status, note);
  } else if (v.kbps != null) {
    add('Video bitrate', 'no range set', fmtKbps(v.kbps), 'info');
  }

  // 12. Audio
  if (!a) {
    add('Audio', spec.audioRequired ? 'required' : 'optional', 'none', spec.audioRequired ? 'fail' : 'info',
      spec.audioRequired ? 'This placement requires audio.' : '');
  } else {
    add('Audio tracks', spec.audioRequired ? '1' : '0 or 1', String(summary.audioCount), summary.audioCount <= 1 ? 'pass' : 'warn');
    const wantA = settings.acodec === 'pcm' ? (settings.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le') : 'aac';
    add('Audio codec', wantA, a.codec, a.codec === wantA ? 'pass' : 'fail');
    add('Sample rate', (settings.sampleRate / 1000) + ' kHz', (a.sampleRate / 1000) + ' kHz', a.sampleRate === settings.sampleRate ? 'pass' : 'fail');
    add('Channels', settings.channels === 2 ? 'stereo (2)' : String(settings.channels), String(a.channels), a.channels === settings.channels ? 'pass' : 'fail');
    if (a.codec === 'aac' && a.kbps != null && spec.minAudioKbps != null) {
      const ok = a.kbps >= spec.minAudioKbps * 0.97; // AAC reports a hair under its target
      add('Audio bitrate', 'at least ' + spec.minAudioKbps + ' kbps', Math.round(a.kbps) + ' kbps', ok ? 'pass' : 'fail');
    }
    if (a.codec.startsWith('pcm') && settings.acodec === 'pcm') {
      const bits = a.codec === 'pcm_s24le' ? 24 : 16;
      add('Bit depth', settings.bitDepth + '-bit', bits + '-bit', bits === settings.bitDepth ? 'pass' : 'fail');
    }
  }

  // 13. Duration
  if (src && src.durationSec) {
    const d = Math.abs(summary.durationSec - src.durationSec);
    add('Duration', src.durationSec.toFixed(2) + ' s (same as source)', summary.durationSec.toFixed(2) + ' s',
      d <= st.durationToleranceSec ? 'pass' : d <= 0.5 ? 'warn' : 'fail');
  }
  if (spec.maxDurationSec) {
    const dur = summary.durationSec;
    add('Max duration', `${spec.maxDurationSec} s or less`, dur.toFixed(2) + ' s',
      dur <= spec.maxDurationSec ? 'pass' : 'fail');
  }
  if (spec.minDurationSec) {
    const dur = summary.durationSec;
    add('Min duration', `${spec.minDurationSec} s or more`, dur.toFixed(2) + ' s',
      dur >= spec.minDurationSec - st.durationToleranceSec ? 'pass' : 'fail');
  }

  // 14. File size
  if (spec.maxSizeMB) {
    const mb = summary.sizeBytes / 1048576;
    const status = mb > spec.maxSizeMB ? 'fail' : mb >= spec.maxSizeMB * (1 - st.sizeWarnPercent / 100) ? 'warn' : 'pass';
    add('File size', `${spec.maxSizeMB} MB or less`, fmtBytes(summary.sizeBytes), status);
  } else {
    add('File size', 'no limit set', fmtBytes(summary.sizeBytes), 'info');
  }

  // 15. Measured extras: loudness, duplicate frames, black bars, black frames
  if (opts.extra) extraRows(summary, settings, preset, opts.extra, st, add, opts.source);

  // 16. File name rule
  const nameRule = checkName(opts.fileName, preset.naming);
  if (nameRule) add('File name', nameRule.expected, nameRule.actual, nameRule.ok ? 'pass' : 'warn', nameRule.ok ? '' : preset.naming.note);

  return rows;
}

function fmtK(k) { return (k / 1000).toFixed(k % 1000 ? 1 : 0) + ' Mbps'; }

// Returns null when the preset has no naming rule.
export function checkName(fileName, naming) {
  if (!fileName || !naming || (!naming.maxLength && !naming.allowedChars && !naming.pattern)) return null;
  const base = fileName.replace(/\.[^.]+$/, '');
  const problems = [];
  if (naming.maxLength && base.length > naming.maxLength) problems.push(`${base.length} characters`);
  if (naming.allowedChars && !new RegExp('^[' + naming.allowedChars + ']+$').test(base)) problems.push('has other characters');
  if (naming.pattern && !new RegExp(naming.pattern).test(base)) problems.push(`does not follow ${naming.patternLabel || 'the naming pattern'}`);
  const exp = [naming.maxLength ? `max ${naming.maxLength} characters` : null, naming.allowedChars ? 'letters and numbers only' : null, naming.pattern ? (naming.patternLabel || 'naming pattern') : null].filter(Boolean).join(', ');
  return { ok: problems.length === 0, expected: exp, actual: problems.length ? problems.join(', ') : `${base.length} characters, OK` };
}

// Overall result: worst status wins.
export function overall(rows) {
  if (rows.some(r => r.status === 'fail')) return 'fail';
  if (rows.some(r => r.status === 'warn')) return 'warn';
  return 'pass';
}

// Rows that come from analysis passes rather than the file's headers.
function extraRows(summary, settings, preset, extra, st, add, source) {
  const a = extra.audio, vid = extra.video, spec = preset.spec;
  const fmt = (x) => (x == null ? 'n/a' : !isFinite(x) ? '-inf' : x.toFixed(1));

  // Loudness against the target
  if (a && settings.loudMode === 'max' && !a.silent) {
    const over = a.rms - settings.loudTarget;
    add('Average level (RMS)', `${settings.loudTarget} dB or lower`, `${fmt(a.rms)} dB`,
      over <= 0.05 ? 'pass' : over <= st.loudnessWarnDb ? 'warn' : 'fail',
      over <= 0.05 ? '' : 'Louder than the placement allows.');
    const pkOver = a.samplePeak - settings.loudPeak;
    add('Peak level', `${settings.loudPeak} dB or lower`, `${fmt(a.samplePeak)} dB`,
      pkOver <= 0.05 ? 'pass' : pkOver <= st.peakWarnDb ? 'warn' : 'fail');
  } else if (a && settings.loudMode && settings.loudMode !== 'off' && !a.silent) {
    const measured = settings.loudMode === 'lufs' ? a.lufs : a.rms;
    const unit = settings.loudMode === 'lufs' ? 'LUFS' : 'dB';
    const diff = Math.abs(measured - settings.loudTarget);
    add(settings.loudMode === 'lufs' ? 'Loudness (integrated)' : 'Average level (RMS)', `${settings.loudTarget} ${unit}`, `${fmt(measured)} ${unit}`,
      diff <= st.loudnessPassDb ? 'pass' : diff <= st.loudnessWarnDb ? 'warn' : 'fail',
      diff <= st.loudnessPassDb ? '' : 'Off target. When the peak limit is close to the average target, audio with big peaks cannot reach the average without compression, which this tool does not apply. Check whether the spec really means these two numbers together.');
    const pk = settings.loudMode === 'lufs' ? a.truePeak : a.samplePeak;
    const over = pk - settings.loudPeak;
    add(settings.loudMode === 'lufs' ? 'True peak' : 'Peak level', `${settings.loudPeak} dB or lower`, `${fmt(pk)} dB`,
      over <= 0.05 ? 'pass' : over <= st.peakWarnDb ? 'warn' : 'fail');
  } else if (a && !a.silent && settings.loudMode === 'off') {
    add('Loudness (measured)', 'no target set', `${fmt(a.lufs)} LUFS, true peak ${fmt(a.truePeak)} dB, average ${fmt(a.rms)} dB`, 'info');
  } else if (a && a.silent) {
    add('Audio level', 'not silent', 'silent', spec.audioRequired ? 'fail' : 'warn', 'The audio track contains no sound.');
  }

  if (vid) {
    // Duplicate frames
    const d = vid.dups, n = Math.max(1, d.frames - 1);
    const pct = d.percent;
    let status = pct <= st.dupPassPercent ? 'pass' : pct <= st.dupWarnPercent ? 'warn' : 'fail';
    // Only placements known to reject repeats (spec.noDuplicateFrames), or files where grain
    // was asked for, are judged on this; elsewhere repeats are reported for information.
    if (status !== 'pass' && !spec.noDuplicateFrames && !settings.noiseOn && !d.conversion) status = 'info';
    let note = `Longest repeat: ${d.longestRun} frames (${d.longestRunSec.toFixed(2)} s).`;
    if (source?.dupPercent != null) note += ` Source had ${source.dupPercent.toFixed(1)}%.`;
    // Grain can hide a converted source's repeats, but a placement may still see the stutter.
    if (status === 'pass' && source?.conversion) {
      status = 'warn';
      note += ` Your video was converted from another frame rate (a repeat every ${source.conversion.every} frames). Grain removed the exact repeats, but the motion still stutters and a placement may still reject it. A native-frame-rate export is safer.`;
    } else if (status === 'info') {
      note += ' This placement is not known to reject repeated frames.';
    } else if (status !== 'pass') {
      if (d.conversion) note += ` The repeats follow a frame rate conversion pattern (one every ${d.conversion.every} frames). Ask the editor for a native-frame-rate export.`;
      if (settings.noiseOn) note += ' Grain was on but repeats remain: the encoder can smooth light grain away. Try strength 6 (even numbers only) or a higher bitrate.';
      else note += ' Turn on "Add light grain" and encode again.';
    }
    add('Duplicate frames', `under ${st.dupPassPercent}% of frames`, `${d.duplicates} of ${n} (${pct.toFixed(1)}%)`, status, note);

    // Black bars
    if (vid.crop) {
      const bars = describeBars(vid.crop, summary.video.width, summary.video.height, st.barTolerancePx);
      add('Black bars', spec.barsAllowed ? 'allowed' : 'none', bars || 'none detected', bars ? (spec.noLetterbox ? 'fail' : spec.barsAllowed ? 'info' : 'warn') : 'pass',
        bars && spec.noLetterbox ? 'This placement does not allow letterboxing or pillarboxing. The picture must fill the frame; this needs fixing in the edit.'
          : bars && spec.barsAllowed ? 'This placement accepts black bars. The picture will not fill the whole screen.' : '');
    }
    // Black frames at start / end
    const ends = describeBlackEnds(vid.black, summary.durationSec);
    const parts = [];
    if (ends.start) parts.push(`${ends.start.toFixed(2)} s at the start`);
    if (ends.end) parts.push(`${ends.end.toFixed(2)} s at the end`);
    add('Black frames at start/end', 'none', parts.join(', ') || 'none detected', parts.length ? 'warn' : 'pass');
    // Interlacing
    if (vid.idet && (vid.idet.progressive + vid.idet.tff + vid.idet.bff) > 0) {
      add('Interlacing (frame analysis)', 'progressive', vid.idet.interlacedPercent < 5 ? 'progressive' : vid.idet.interlacedPercent.toFixed(0) + '% interlaced frames', vid.idet.interlacedPercent < 5 ? 'pass' : 'warn');
    }
  }
}
