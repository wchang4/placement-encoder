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
  // Frame rate: "native" keeps the video's own rate when the placement accepts it.
  // When it does not, the closest accepted rate is picked automatically (see pickFps).
  let fps = settings.fps === 'native' ? v.fps : Number(settings.fps);
  let autoFps = false;
  const allowed = settings.allowedFps;
  if (settings.fps === 'native' && allowed?.length && !allowed.some(a => Math.abs(a - v.fps) / a < 0.0005)) {
    fps = pickFps(v.fps, allowed); autoFps = true;
  }
  const convertsFps = Math.abs(fps - v.fps) / v.fps > 0.0005;
  // 30 to 29.97 (and 24 to 23.976, 60 to 59.94, or back) differ by only 0.1%. These are
  // "conformed": every frame is kept and simply shown 0.1% slower (or faster), with the
  // sound stretched to match. Nothing is dropped or repeated, and the change cannot be
  // seen or heard. A 15 s spot at 30 fps becomes 450 frames at 29.97 (15:00 in timecode).
  const conform = convertsFps && Math.abs(fps / v.fps - 1) < 0.0015;
  const raises = convertsFps && !conform && fps > v.fps;   // repeats frames
  const lowers = convertsFps && !conform && fps < v.fps;   // drops frames evenly
  const scales = w !== v.width || h !== v.height;
  return { w, h, fps, convertsFps, conform, raises, lowers, autoFps, scales };
}

// Closest accepted frame rate: first one that can be conformed (0.1% away), then the
// highest rate below the video's (frames are dropped evenly, nothing repeats), and
// only then the lowest rate above it (frames repeat; grain is offered).
export function pickFps(src, allowed) {
  const near = allowed.find(a => Math.abs(a / src - 1) < 0.0015);
  if (near) return near;
  const below = allowed.filter(a => a < src).sort((a, b) => b - a)[0];
  if (below) return below;
  return allowed.slice().sort((a, b) => a - b)[0];
}

// How long the new file runs before any spot trimming: a conformed video is 0.1% longer
// or shorter than the source.
export function outDuration(src, t) {
  return t.conform ? src.durationSec * src.video.fps / t.fps : src.durationSec;
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
  const rate = t.fps === 29.97 ? '30000/1001' : t.fps === 23.976 ? '24000/1001' : t.fps === 59.94 ? '60000/1001' : String(t.fps);
  if (t.conform) vf.push(`setpts=PTS*${(src.video.fps / t.fps).toFixed(9)}`, `fps=${rate}`);   // same frames, new timing
  else if (t.convertsFps) vf.push(`fps=${rate}`);
  // Optional light noise layer for duplicate-frame prevention: temporal (changes on
  // every frame) and uniform. Applied after any scaling or frame rate change so every
  // output frame gets different noise.
  // A video slightly shorter than its spot length gets its last frame held.
  const spot = opts.spot || null;
  if (spot && spot.pad) vf.push(`tpad=stop_mode=clone:stop_duration=${(spot.pad + 0.2).toFixed(3)}`);
  if (s.noiseOn) vf.push(`noise=alls=${Math.round(s.noiseStrength)}:allf=t+u`);
  // Black at the end (local CTV stations ask for 10 s): cut the spot to its exact
  // length first, then add pure black (after the grain, so the black stays clean).
  const tail = s.tailBlackSec > 0 ? s.tailBlackSec : 0;
  const mainSec = spot ? spot.exactSec : outDuration(src, t);
  if (tail) {
    vf.push(spot ? `trim=end_frame=${spot.frames}` : `trim=end=${mainSec.toFixed(6)}`, 'setpts=PTS-STARTPTS');
    vf.push(`tpad=stop_mode=add:stop_duration=${tail}:color=black`);
  }
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
    // A conformed video's sound is stretched by the same 0.1% (pitch kept).
    const af = [t.conform ? `atempo=${(t.fps / src.video.fps).toFixed(9)}` : null, opts.audioFilter, tail ? `atrim=end=${mainSec.toFixed(6)},asetpts=PTS-STARTPTS` : null, (spot || tail) ? 'apad' : null].filter(Boolean).join(',');
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
  if (spot) args.push('-t', (spot.exactSec + tail).toFixed(6));
  else if (src.durationSec > 0) args.push('-t', (outDuration(src, t) + tail).toFixed(3));
  args.push('-y', outName);
  return { args, notes };
}
