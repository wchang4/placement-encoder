// args.js
// Turns the settings on screen into an ffmpeg command line.
// Pure function: no browser or encoder access, so it is easy to read and test.

const PRORES_PROFILE_NUM = { proxy: 0, lt: 1, '422': 2, hq: 3, '4444': 4 };

// Work out the output picture size and frame rate the settings will produce.
export function targetFormat(settings, src) {
  const v = src.video;
  const w = settings.width || v.width;
  const h = settings.height || v.height;
  const fps = settings.fps === 'native' ? v.fps : Number(settings.fps);
  const convertsFps = settings.fps !== 'native' && Math.abs(fps - v.fps) / v.fps > 0.001;
  const scales = w !== v.width || h !== v.height;
  return { w, h, fps, convertsFps, scales };
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
    if (opts.audioFilter) args.push('-af', opts.audioFilter);
    args.push('-ar', String(s.sampleRate), '-ac', String(s.channels));
  } else {
    args.push('-an');
  }

  // ---- container flags ----
  if (s.faststart) args.push('-movflags', '+faststart');
  if (s.stripEditLists) args.push('-use_editlist', '0');
  args.push('-write_tmcd', '0'); // do not copy the timecode track
  args.push('-y', outName);
  return { args, notes };
}
