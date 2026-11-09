// level.js
// Audio leveling: measure first, then build the ffmpeg audio filter that brings
// the sound to the target. Two methods:
//   "lufs": two-pass loudnorm (integrated loudness + true-peak limiter). The
//           standard approach for broadcast and streaming targets.
//   "rms":  measure the average (RMS) level, apply the gain that reaches the
//           target, then a peak limiter. Used for specs written as "average
//           level and peak" (for example Cineplex, Spotify).
// The finished file is measured again afterwards and the report shows the real result.

import { measureAudio, measureLoudnorm } from './analyze.js';

// Returns { filter, info } where filter is an ffmpeg -af string (or null if
// nothing should be applied) and info is a plain-language description.
export async function planLeveling(engine, path, s, onTime) {
  if (s.loudMode === 'lufs') {
    const m = await measureLoudnorm(engine, path, { i: s.loudTarget, tp: s.loudPeak, lra: 11 }, onTime);
    if (!m || !isFinite(m.i)) return { filter: null, info: 'The audio is silent or could not be measured, so no leveling was applied.' };
    const filter = `loudnorm=I=${s.loudTarget}:TP=${s.loudPeak}:LRA=11:measured_I=${m.i}:measured_LRA=${m.lra}:measured_TP=${m.tp}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true:print_format=summary,aresample=${s.sampleRate}`;
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
  return { filter: null, info: '' };
}
