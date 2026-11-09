// media.js
// Small helpers shared by the other modules: turn ffprobe's raw JSON into a
// simple summary, format numbers for display, and estimate output size.

// "30000/1001" -> 29.97
export function parseRate(str) {
  if (!str || str === '0/0') return null;
  const [a, b] = String(str).split('/').map(Number);
  if (!b) return a || null;
  return a / b;
}

// 29.97003 -> "29.97", 24 -> "24", 23.976 -> "23.976"
export function fmtFps(x) {
  if (x == null) return 'unknown';
  const near = [23.976, 29.97, 59.94, 47.952].find(n => Math.abs(n - x) < 0.01);
  if (near) return String(near);
  return String(Math.round(x * 1000) / 1000);
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return 'unknown';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  return (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB';
}

export function fmtKbps(k) {
  if (k == null || isNaN(k)) return 'unknown';
  return Math.round(k).toLocaleString('en-US') + ' kbps (' + (k / 1000).toFixed(1) + ' Mbps)';
}

export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '--:--';
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

// Reduce 1920x1080 -> "16:9" (only returns a label for common shapes).
export function aspectLabel(w, h) {
  if (!w || !h) return 'unknown';
  const r = w / h;
  const known = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '4:3': 4 / 3, '21:9': 21 / 9 };
  for (const [k, v] of Object.entries(known)) if (Math.abs(r - v) / v < 0.01) return k;
  return r.toFixed(3) + ':1';
}

export function aspectValue(label) {
  const [a, b] = label.split(':').map(Number);
  return a / b;
}

// Which container did the file really use? MOV and MP4 share a family name in
// ffprobe, so we look at the "major brand" tag instead.
export function containerOf(probe) {
  const brand = (probe.format?.tags?.major_brand || '').trim().toLowerCase();
  if (brand === 'qt') return 'mov';
  if (/mp4|isom|m4v|m4a|iso|avc1|dash/.test(brand)) return 'mp4';
  if (/mov|mp4/.test(probe.format?.format_name || '')) return brand ? 'mp4' : 'mov';
  return probe.format?.format_name || 'unknown';
}

// Turn ffprobe JSON into the simple object the rest of the app uses.
export function summarize(probe) {
  const streams = probe.streams || [];
  const vs = streams.filter(s => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const as = streams.filter(s => s.codec_type === 'audio');
  const ds = streams.filter(s => s.codec_type !== 'video' && s.codec_type !== 'audio');
  const v = vs[0], a = as[0];
  const dur = +probe.format?.duration || (v ? +v.duration : 0) || 0;
  const out = {
    container: containerOf(probe),
    formatName: probe.format?.format_name,
    durationSec: dur,
    sizeBytes: +probe.format?.size || 0,
    overallKbps: probe.format?.bit_rate ? +probe.format.bit_rate / 1000 : null,
    videoCount: vs.length, audioCount: as.length, otherCount: ds.length,
    video: null, audio: null
  };
  if (v) {
    const fps = parseRate(v.r_frame_rate), avg = parseRate(v.avg_frame_rate);
    out.video = {
      codec: v.codec_name, profile: v.profile || '',
      width: v.width, height: v.height, sar: v.sample_aspect_ratio || '1:1',
      fps, avgFps: avg,
      // r_frame_rate is the "base" rate; if the average differs it is probably variable
      cfrLikely: fps && avg ? Math.abs(fps - avg) / fps < 0.001 : null,
      fieldOrder: v.field_order || 'unknown',
      pixFmt: v.pix_fmt, bitDepth: +v.bits_per_raw_sample || null,
      kbps: v.bit_rate ? +v.bit_rate / 1000 : null,
      colorSpace: v.color_space || '', colorPrimaries: v.color_primaries || '',
      colorTransfer: v.color_transfer || '', colorRange: v.color_range || ''
    };
  }
  if (a) {
    out.audio = {
      codec: a.codec_name, profile: a.profile || '',
      sampleRate: +a.sample_rate, channels: a.channels,
      kbps: a.bit_rate ? +a.bit_rate / 1000 : null,
      bitDepth: +a.bits_per_raw_sample || +a.bits_per_sample || null
    };
  }
  // If the video stream has no bitrate of its own, estimate from the whole file.
  if (out.video && out.video.kbps == null && out.overallKbps != null) {
    out.video.kbps = Math.max(0, out.overallKbps - (out.audio?.kbps || 0));
    out.video.kbpsEstimated = true;
  }
  return out;
}

// Rough ProRes data rates for 1920x1080 at 29.97 fps (Apple's published nominal
// figures). Real files are usually lower, so this errs on the safe side.
const PRORES_NOMINAL_KBPS = { proxy: 45000, lt: 102000, '422': 147000, hq: 220000, '4444': 330000 };

// Estimate how big the output file will be, in bytes.
export function estimateOutputBytes(settings, w, h, fps, durationSec) {
  let vKbps;
  if (settings.vcodec === 'prores') {
    const scale = (w * h * (fps || 29.97)) / (1920 * 1080 * 29.97);
    vKbps = (PRORES_NOMINAL_KBPS[settings.proresProfile] || 220000) * scale;
  } else {
    vKbps = settings.bitrateKbps;
  }
  const aKbps = settings.acodec === 'pcm'
    ? settings.sampleRate * settings.channels * settings.bitDepth / 1000
    : settings.audioKbps;
  return ((vKbps + aKbps) * 1000 / 8) * durationSec;
}

// Bits per sample from an ffmpeg pixel format name: "yuv422p10le" -> 10, "yuv420p" -> 8.
export function pixDepth(pixFmt) {
  const m = /(\d+)(le|be)$/.exec(pixFmt || '');
  return m ? +m[1] : 8;
}
