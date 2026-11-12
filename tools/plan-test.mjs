// Planner tests: run with  node tools/plan-test.mjs
// Each case lists placements and the files the planner must produce. These are the
// groupings worked out by hand while building the tool; the planner must agree.
import { readFileSync } from 'node:fs';
import { planFiles, combine, describeFile, validatePlacement, checkSource } from '../js/plan.js';

const cfg = JSON.parse(readFileSync(new URL('../placements.json', import.meta.url), 'utf8'));
const by = Object.fromEntries(cfg.placements.map(p => [p.id, p]));
let failed = 0;
const check = (label, cond, detail = '') => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + label + (detail ? '  ' + detail : '')); };
const files = (ids, lengthSec) => planFiles(ids.map(i => by[i]), cfg, { lengthSec });
const shape = (fs) => fs.map(f => f.members.map(p => p.id).sort().join('+')).sort();

// 1. Every placement is valid on its own.
for (const p of cfg.placements) { const v = validatePlacement(p, cfg); check(`valid: ${p.id}`, !v.errors.length, v.errors.join(' ')); }

// 2. The seven-placement audit (SCO video): 5 files, with Rogers, Prime Video and YouTube sharing.
const seven = files(['cineplex', 'rogers', 'ctv-local', 'corus', 'prime-video', 'landmark', 'youtube'], 15);
check('7 placements make 5 files', seven.length === 5, JSON.stringify(shape(seven)));
check('Rogers + Prime Video + YouTube share', shape(seven).includes('prime-video+rogers+youtube'));
const stream = seven.find(f => f.members.some(p => p.id === 'rogers'));
check('shared streaming file is 18 Mbps MP4', stream.rules.videoOut === 18000 && stream.rules.format === 'mp4-h264', `${stream.rules.videoOut} ${stream.rules.format}`);
check('shared streaming file sets sound to -24 LKFS, -1 peak', stream.rules.loudness?.mode === 'lufs' && stream.rules.loudness.target === -24 && stream.rules.loudness.peak === -1);
check('shared streaming file must avoid repeated frames (Rogers)', stream.rules.noDuplicateFrames);

// 3. Single placements get the settings found by hand.
const one = (id, len = 30) => files([id], len)[0].rules;
check('Cineplex: ProRes HQ, sound limits -12/-8', one('cineplex').format === 'mov-prores-hq' && one('cineplex').loudness.mode === 'max');
check('Landmark: H.264 at 55 Mbps', one('landmark').videoOut === 55000, String(one('landmark').videoOut));
check('Corus: 7.2 Mbps (inside 4.5 to 8), 128 kbps audio', one('corus').videoOut === 7200 && one('corus').audioOut === 128, `${one('corus').videoOut} ${one('corus').audioOut}`);
const bell = one('crave-bell');
check('Crave / Bell: fits 25 MB at 30 s', bell.videoOut <= 5700 && bell.videoOut >= 5500, String(bell.videoOut));
check('Crave / Bell: 44.1 kHz', bell.sampleRate === 44100);
check('CTV local: 10 s black', one('ctv-local').tailBlackSec === 10);

// 4. Things that must never share.
check('CTV local never shares (black at the end)', files(['ctv-local', 'youtube']).length === 2);
check('Corus and Rogers cannot share (bitrate ranges)', files(['corus', 'rogers']).length === 2);
check('Cineplex and Landmark cannot share (ProRes vs H.264)', files(['cineplex', 'landmark']).length === 2);
check('Bell stays apart from streaming (44.1 kHz)', files(['crave-bell', 'prime-video']).length === 2);
check('Spotify and Rogers cannot share (different sound rules)', files(['spotify', 'rogers']).length === 2);

// 5. Things that should share.
check('Prime Video, Disney+ and YouTube share one file', files(['prime-video', 'disney', 'youtube']).length === 1);
check('Spotify, YouTube and Meta share one file', files(['spotify', 'youtube', 'meta']).length === 1);
check('Corus and YouTube share one file', files(['corus', 'youtube']).length === 1);
check('Landmark always has a file of its own (cinema spot)', files(['landmark', 'youtube']).length === 2 && files(['landmark', 'meta', 'youtube']).length === 2);
check('YouTube is never handed the Cineplex ProRes master', files(['cineplex', 'youtube']).length === 2);
check('CTV never shares with Cineplex (H.264 vs ProRes, and black)', files(['cineplex', 'ctv-local']).length === 2);

// 6. A 60 s spot is too long for Bell's 25 MB at 5 Mbps: the file is blocked and says why.
const bell60 = files(['crave-bell'], 60)[0];
check('Bell 60 s is blocked with a reason', !bell60.rules && /25 MB/.test(bell60.why), bell60.why);

// 7. All twelve together still plan without errors.
const all = files(cfg.placements.filter(p => !p.custom).map(p => p.id), 30);
check('all placements plan', all.length >= 6 && all.every(f => f.members.length), JSON.stringify(shape(all)));

// 8. describeFile with a 30 fps, 15 s video: Cineplex gets a 29.97 conform, no trim.
const src = { durationSec: 15, container: 'mp4', video: { width: 1920, height: 1080, fps: 30, fieldOrder: 'progressive', cfrLikely: true }, audio: { codec: 'aac' } };
const d = describeFile(files(['cineplex'])[0], cfg, { src, analysis: null });
check('Cineplex 30 fps: conform to 29.97', d.t.conform && d.t.fps === 29.97 && d.spot.frames === 450, JSON.stringify(d.changes.map(c => c.text)));
check('Cineplex 30 fps: nothing to do', d.todo.length === 0, JSON.stringify(d.todo));

// 9. "Already good to go": the SCO video (MP4, H.264 High, 30 fps, 10 Mbps, AAC 317 kbps,
//    exactly 15 s) suits YouTube as it is, but not Rogers (29.97 fps and -24 LKFS) or Cineplex (ProRes).
const sco = {
  file: { name: '15s_EN_SCO_Computer YT_V4_LM.mp4', size: 18.5e6 },
  src: { durationSec: 15, container: 'mp4', video: { codec: 'h264', profile: 'High', width: 1920, height: 1080, fps: 30, kbps: 9999, cfrLikely: true, fieldOrder: 'progressive' },
    audio: { codec: 'aac', sampleRate: 48000, channels: 2, kbps: 317 } },
  analysis: { audio: { rms: -22.7, samplePeak: -2.3, lufs: -19.6, truePeak: -2.1, silent: false },
    video: { dups: { percent: 0, duplicates: 0, frames: 450 }, crop: { frames: [] }, black: [], idet: null } }
};
const asIs = (ids) => checkSource(files(ids, 15)[0], cfg, sco);
check('SCO video is already good to go for YouTube', asIs(['youtube']).ok, JSON.stringify(asIs(['youtube']).misses));
check('SCO video is not good as is for Rogers (frame rate, sound level)', !asIs(['rogers']).ok && asIs(['rogers']).misses.length >= 2, JSON.stringify(asIs(['rogers']).misses));
check('SCO video is not good as is for Cineplex (needs ProRes)', !asIs(['cineplex']).ok && /ProRes/.test(asIs(['cineplex']).misses[0]), asIs(['cineplex']).misses[0]);
check('SCO video is not good as is for CTV (needs 10 s of black)', !asIs(['ctv-local']).ok && asIs(['ctv-local']).misses.some(m => /black/.test(m)));
const scoLong = { ...sco, src: { ...sco.src, durationSec: 15.04 } };
check('15.04 s is not good as is (spots must be exact)', !checkSource(files(['youtube'], 15)[0], cfg, scoLong).ok);
check('no answer before the video check finishes', checkSource(files(['youtube'], 15)[0], cfg, { ...sco, analysis: null }) === null);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
