// args.js
// Turns the settings on screen into an ffmpeg command line.
// Pure function: no browser or encoder access, so it is easy to read and test.

const PRORES_PROFILE_NUM = { proxy: 0, lt: 1, '422': 2, hq: 3, '4444': 4 };

// Work out the output picture size and frame rate the settings will produce.
// The file always keeps the shape of the uploaded video (wide, square or vertical).
// A preset's width x height is its size for its own shape; any other shape gets the
// same short edge (1080 for a 1920 x 1080 preset), so a square becomes 1080 x 1080
// and a vertical 1080 x 1920. Nothing is ever stretched, cropped or reframed.
export function targetFormat(settings, src) {
  const v = src.video;
  let w = settings.width || v.width;
  let h = settings.height || v.height;
  const srcRatio = v.width / v.height;
  if (Math.abs(w / h - srcRatio) / srcRatio > 0.01) {
    const short = Math.min(w, h);
    const even = (x) => Math.max(2, 2 * Math.round(x / 2));
    if (srcRatio >= 1) { h = short; w = even(short * srcRatio); }
    else { w = short; h = even(short / srcRatio); }
  }
  const fps = settings.fps === 'native' ? v.fps : Number(settings.fps);
  const convertsFps = settings.fps !== 'native' && Math.abs(fps - v.fps) / v.fps > 0.001;
  const scales = w !== v.width || h !== v.height;
  return { w, h, fps, convertsFps, scales };
}

// Standard spot lengths: a video that is close to 6, 15, 30 or 60 seconds is made
// exactly that long. Length is counted in frames, the way broadcast timecode counts it:
// 6 s is 180 frames at 29.97 fps (timecode 00:00:06:00) and 144 frames at 23.976.
// Returns null when the video is not close to a standard length (it is then kept as is).
export function spotLength(durationSec, fps, cfg) {
  if (!cfg || !cfg.lengths?.length || !(durationSec > 0) || !(fps > 0)) return null;
  const within = cfg.snapWithinSec ?? 0.5;
  const L = cfg.lengths.slice().sort((a, b) => Math.abs(a - durationSec) - Math.abs(b - durationSec))[0];
  if (Math.abs(L - durationSec) > within) return null;
  const frames = Math.round(L * Math.round(fps));
  const exactSec = frames / fps;
  const diff = durationSec - exactSec;
  return { seconds: L, frames, exactSec, cut: diff > 0.0005 ? diff : 0, pad: diff < -0.0005 ? -diff : 0 };
}

// Returns { args, notes }. inPath is the mounted source, outName the file the
// encoder will create in its own memory.
export function buildArgs(settings, src, inPath, outName, opts = {}) {
  const s = settings, notes = [];
  const t = targetFormat(s, src);
  const hasAudio = !!src.audio;
  const args = ['-i', inPath, '-map', '0:v:0'];
  if (hasAudio) args.push('-map', '0:a:0');

  // ---- video filters ----
  const vf = [];
  if (t.scales) vf.push(`scale=${t.w}:${t.h}:flags=lanczos`, 'setsar=1');
  if (t.convertsFps) vf.push(`fps=${t.fps === 29.97 ? '30000/1001' : t.fps === 23.976 ? '24000/1001' : t.fps === 59.94 ? '60000/1001' : t.fps}`);
  // Optional light noise layer for duplicate-frame prevention: temporal (changes on
  // every frame) and uniform. Applied after any scaling or frame rate change so every
  // output frame gets different noise.
  // A video slightly shorter than its spot length gets its last frame held.
  const spot = opts.spot || null;
  if (spot && spot.pad) vf.push(`tpad=stop_mode=clone:stop_duration=${(spot.pad + 0.2).toFixed(3)}`);
  if (s.noiseOn) vf.push(`noise=alls=${Math.round(s.noiseStrength)}:allf=t+u`);
  // Colour labels must also be set on the frames themselves: the -colorspace options
  // alone left ProRes files with "unknown" primaries/transfer when the source was untagged.
  if (s.tagBt709) vf.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  if (vf.length) args.push('-vf', vf.join(','));

  // ---- video codec ----
  if (s.vcodec === 'prores') {
    const prof = PRORES_PROFILE_NUM[s.proresProfile] ?? 3;
    args.push('-c:v', 'prores_ks', '-profile:v', String(prof), '-vendor', 'apl0');
    args.push('-pix_fmt', s.proresProfile === '4444' ? 'yuv444p12le' : 'yuv422p10le');
  } else {
    // 4:2:2 H.264 needs the "high422" profile; 4:2:0 must not use it.
    let prof = s.h264Profile;
    if (s.pixFmt === 'yuv422p' && prof !== 'high422') { prof = 'high422'; notes.push('4:2:2 needs the High 4:2:2 profile, so it was switched automatically.'); }
    if (s.pixFmt !== 'yuv422p' && prof === 'high422') prof = 'high';
    args.push('-c:v', 'libx264', '-preset', s.x264Preset, '-profile:v', prof, '-pix_fmt', s.pixFmt);

    const k = Math.round(s.bitrateKbps);
    if (s.bitrateMode === 'cbr') {
      // A short buffer (0.5 s) keeps the rate close to constant. Tested: a 2 s buffer
      // let the bitrate swing between 4 and 31 Mbps on a 20 Mbps target; 0.5 s held it to about 17 to 22.
      args.push('-b:v', k + 'k', '-minrate', k + 'k', '-maxrate', k + 'k', '-bufsize', Math.round(k / 2) + 'k');
    } else {
      args.push('-b:v', k + 'k', '-maxrate', Math.round(k * 1.5) + 'k', '-bufsize', (2 * k) + 'k');
    }
    args.push('-bf', String(s.bframes));
    if (s.gopSeconds > 0) args.push('-g', String(Math.max(1, Math.round(s.gopSeconds * t.fps))));

    const x264 = [];
    if (s.bitrateMode === 'cbr') x264.push('nal-hrd=cbr');
    if (s.closedGop) x264.push('open-gop=0');
    if (x264.length) args.push('-x264-params', x264.join(':'));
  }

  // Constant frame rate output (important for Disney+, Amazon).
  args.push('-fps_mode', 'cfr');

  // ---- colour tags (labels only; the picture is not converted) ----
  if (s.tagBt709) {
    args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
    const sp = src.video.colorSpace;
    if (sp && sp !== 'bt709') notes.push(`The source is tagged "${sp}". The output is labelled BT.709 but the colours are not converted.`);
  }

  // ---- audio ----
  if (hasAudio) {
    if (s.acodec === 'pcm') {
      args.push('-c:a', s.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le');
    } else {
      args.push('-c:a', 'aac', '-b:a', Math.round(s.audioKbps) + 'k');
    }
    // Silence fills any gap at the end, so the sound is exactly as long as the picture.
    const af = [opts.audioFilter, spot ? 'apad' : null].filter(Boolean).join(',');
    if (af) args.push('-af', af);
    args.push('-ar', String(s.sampleRate), '-ac', String(s.channels));
  } else {
    args.push('-an');
  }

  // ---- container flags ----
  if (s.faststart) args.push('-movflags', '+faststart');
  if (s.stripEditLists) args.push('-use_editlist', '0');
  args.push('-write_tmcd', '0'); // do not copy the timecode track
  // Keep the file exactly as long as the source. Leveling and AAC can add a few
  // hundredths of a second of audio, which pushed a 30.03 s spot over a 30 s limit.
  // A standard spot is cut to an exact number of frames. Only -t is used: -frames:v
  // closed the file as soon as the last picture was written, while the sound leveling
  // was still about 3 s behind, which cut the audio short (tested).
  if (spot) args.push('-t', spot.exactSec.toFixed(6));
  else if (src.durationSec > 0) args.push('-t', src.durationSec.toFixed(3));
  args.push('-y', outName);
  return { args, notes };
}
