// level.js
// Audio leveling: measure first, then build the ffmpeg audio filter that brings
// the sound to the target. Two methods:
//   "lufs": two-pass loudnorm (integrated loudness + true-peak limiter). The
//           standard approach for broadcast and streaming targets.
//   "rms":  measure the average (RMS) level, apply the gain that reaches the
//           target, then a peak limiter. Used for specs written as "average
//           level and peak" as a target to reach (for example Spotify).
//   "max":  limits only, for specs written as "no higher than" (for example
//           Cineplex: average no higher than -12 dB, peaks no higher than -8 dB).
//           Audio that is already within the limits is left exactly as it is.
//           Audio that is too loud is turned down; peaks over the limit are limited.
// The finished file is measured again afterwards and the report shows the real result.

import { measureAudio, measureLoudnorm } from './analyze.js';

// Returns { filter, info } where filter is an ffmpeg -af string (or null if
// nothing should be applied) and info is a plain-language description.
export async function planLeveling(engine, path, s, onTime) {
  if (s.loudMode === 'lufs') {
    // AAC encoding can push peaks a little above where the limiter held them
    // (a test landed 0.2 dB over), so aim 0.5 dB lower when the output is AAC.
    // loudnorm only accepts -9 to 0 dBTP; below that, an extra limiter does the rest.
    // (It must sit before aresample: the browser's ffmpeg cannot link them the other way round.)
    const want = s.acodec === 'aac' ? s.loudPeak - 0.5 : s.loudPeak;
    const tp = Math.min(0, Math.max(-9, want));
    const extraLimit = want < tp ? `,alimiter=limit=${Math.pow(10, want / 20).toFixed(4)}:attack=5:release=50:level=0` : '';
    const m = await measureLoudnorm(engine, path, { i: s.loudTarget, tp, lra: 11 }, onTime);
    if (!m || !isFinite(m.i)) return { filter: null, info: 'The audio is silent or could not be measured, so no leveling was applied.' };
    const filter = `loudnorm=I=${s.loudTarget}:TP=${tp}:LRA=11:measured_I=${m.i}:measured_LRA=${m.lra}:measured_TP=${m.tp}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary${extraLimit},aresample=${s.sampleRate}`;
    return { filter, info: `Measured ${m.i.toFixed(1)} LUFS (true peak ${m.tp.toFixed(1)} dB). Adjusted toward ${s.loudTarget} LUFS with a ${s.loudPeak} dBTP limit.` };
  }
  if (s.loudMode === 'rms') {
    const m = await measureAudio(engine, path, onTime);
    if (m.silent || m.rms == null || !isFinite(m.rms)) return { filter: null, info: 'The audio is silent or could not be measured, so no leveling was applied.' };
    const gain = s.loudTarget - m.rms;
    // AAC compression can nudge peaks slightly above where the limiter held them
    // (a test landed 0.1 dB over), so leave 0.3 dB of headroom when the output is AAC.
    const margin = s.acodec === 'aac' ? 0.3 : 0;
    const lin = Math.min(1, Math.max(0.0625, Math.pow(10, (s.loudPeak - margin) / 20)));
    const filter = `volume=${gain.toFixed(2)}dB,alimiter=limit=${lin.toFixed(4)}:attack=5:release=50:level=0`;
    const room = s.loudPeak - s.loudTarget, crest = m.samplePeak - m.rms;
    const hard = crest > room + 1
      ? ` Warning: the target leaves only ${room.toFixed(1)} dB between average and peak, but this audio has ${crest.toFixed(1)} dB. The limiter cannot close that gap, so the average will fall short unless the audio is compressed (this tool does not compress).`
      : '';
    return { filter, info: `Measured average ${m.rms.toFixed(1)} dB (peak ${m.samplePeak.toFixed(1)} dB). Gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB toward ${s.loudTarget} dB, with a peak limiter at ${s.loudPeak} dB. Limiting can leave the average slightly below target; the report shows the real result.${hard}` };
  }
  if (s.loudMode === 'max') {
    const m = await measureAudio(engine, path, onTime);
    if (m.silent || m.rms == null || !isFinite(m.rms)) return { filter: null, info: 'The audio is silent or could not be measured, so no leveling was applied.' };
    const cut = Math.min(0, s.loudTarget - m.rms); // never turn up, only down
    const margin = s.acodec === 'aac' ? 0.3 : 0;
    const limitDb = s.loudPeak - margin;
    const needLimit = m.samplePeak + cut > limitDb;
    const parts = [];
    if (cut < -0.05) parts.push(`volume=${cut.toFixed(2)}dB`);
    if (needLimit) {
      const lin = Math.min(1, Math.max(0.0625, Math.pow(10, limitDb / 20)));
      parts.push(`alimiter=limit=${lin.toFixed(4)}:attack=5:release=50:level=0`);
    }
    const avg = cut < -0.05
      ? `Average ${m.rms.toFixed(1)} dB was louder than the ${s.loudTarget} dB limit, so it was turned down ${(-cut).toFixed(1)} dB.`
      : `Average ${m.rms.toFixed(1)} dB is within the ${s.loudTarget} dB limit, so the volume was not changed.`;
    const pk = needLimit
      ? ` Peaks (${m.samplePeak.toFixed(1)} dB) were held to ${s.loudPeak} dB.`
      : ` Peaks (${m.samplePeak.toFixed(1)} dB) are within the ${s.loudPeak} dB limit.`;
    return { filter: parts.length ? parts.join(',') : null, info: avg + pk };
  }
  return { filter: null, info: '' };
}
