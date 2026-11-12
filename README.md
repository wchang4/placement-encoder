# Placement Encoder

Internal CAA NEO tool. Drop in a finished ad, choose every placement it is running on, and get the fewest files that cover them all, each made to spec and checked. Everything runs in the browser (ffmpeg.wasm). Videos never leave the computer. There is no server, account or tracking.

The check is technical only. It is not a guarantee a placement will accept the file, and every file needs a person to review it before it is sent.

## What is in this folder

| File or folder | What it is |
|---|---|
| `index.html` | The tool. |
| `guide.html` | How it works, for teammates. Linked from the tool. |
| `check.html` | The placement list check, for whoever looks after `placements.json`. |
| `placements.json` | Every placement and what it accepts. **This is the file you edit.** |
| `css/app.css` | The look, including the light and dark themes. |
| `js/plan.js` | Works out the files: which placements share, and each file's settings and messages. |
| `js/app.js` | The page. `js/check.js` is the check page. |
| `js/args.js`, `level.js`, `analyze.js`, `verify.js`, `engine.js`, `media.js` | Encoder command, sound leveling, video analysis, the final report, the ffmpeg wrapper, helpers. |
| `tools/plan-test.mjs` | Tests for the planner: `node tools/plan-test.mjs`. Run after changing `placements.json` or `plan.js`. |
| `fonts/` | Atkinson Hyperlegible Next (SIL Open Font License, see `fonts/OFL-LICENSE.txt`). Bundled so the page makes no outside requests. |
| `logos/` | Optional placement logos for the tiles (see `logos/README.txt`). |
| `vendor/` | The encoder, pinned and self-hosted: `@ffmpeg/ffmpeg` 0.12.15, `@ffmpeg/core` 0.12.10. Do not update casually. |
| `serve.py` | Local test server (`python serve.py`, then open http://127.0.0.1:8080). |

## How files are worked out

Each placement in `placements.json` only says what it **accepts**, copied from its spec sheet. Nothing says how to group them. For the placements someone chooses, `js/plan.js`:

1. Finds every group of placements whose rules overlap (file type, frame rates, bitrate range, size limit for the spot's length, sample rate, sound rule, black at the end).
2. Picks the fewest files that cover them all. Ties go to the layout that gives each placement the lightest file type it accepts.
3. Sets each file's encoder settings inside everyone's limits: for example the video bitrate starts from `encoding.videoKbps` (18 Mbps) and is moved inside the shared range and under any size limit.
4. Writes the plain-language lists on each file slip: what the tool will change, what the person needs to do, and what is good to know.

Placements in one file with different file name rules get their own copy of the same file, each with its own name. A shared file never moves a placement from H.264 to ProRes or back.

Once the video has been checked, `checkSource()` in `js/plan.js` tests the video exactly as it is against each file's rules (file names excluded). A file it already meets is shown as "Already good to go" and is not made unless the person asks for it.

## Adding or changing a placement

1. Open `placements.json` in any text editor. Copy one placement entry (from its `{` to the matching `}`), paste it after the last one, with a comma between entries.
2. Change it to match the spec sheet. Only fill in what the sheet says; leave a field out when the sheet is silent.
3. Open **check.html** (from the local server or the live site). Paste the entry into "Try a new placement" first: it lists anything missing or misspelt, which placements it can share a file with (and why not, for the others), and what changes for any file it joins. Then save `placements.json` and reload: the entry appears under "Every placement".
4. Run `node tools/plan-test.mjs`. It checks the groupings worked out so far still hold.

### Placement fields

| Field | Meaning |
|---|---|
| `id` | Unique, no spaces. |
| `name` | Full name, shown on file slips ("Rogers Sports & Media: digital video"). |
| `short` | Short name used in messages ("Rogers"). |
| `tile` | `title` (word on the badge), `sub` (where the ad runs), `color` (dark enough for white text), optional `colors` (several brand colours shown as stripes), optional `logo` path. |
| `status`, `verifiedDate` | `"verified"` and a date once confirmed with the placement; otherwise `"unverified"`. |
| `source` | `label` (which spec sheet, which date) and `url` if public. |
| `notes` | Anything a person should know, in plain words. |
| `naming` | Optional file name rule: `maxLength`, `allowedChars`, `pattern` (a regular expression) with `patternLabel` (the same in words), `example` and `note`. |
| `safeZones` | Optional areas drawn on a frame: `label`, `type` (`safe` or `avoid`), `x`, `y`, `w`, `h` on a `refW` x `refH` frame. |
| `accepts.formats` | File types it accepts: `mp4-h264`, `mov-h264`, `mov-prores-422`, `mov-prores-hq` (defined in the `formats` block). |
| `accepts.shortEdge` | Picture size on the short side, usually 1080. The file keeps the video's shape. |
| `accepts.minShortEdge` | Smallest short side it accepts. |
| `accepts.frameRates` | Frame rates it accepts, for example `[23.976, 29.97]`. Leave out for any. |
| `accepts.videoKbps` | `{ "min": 10000, "max": 40000 }` in kbps (10000 kbps = 10 Mbps). Either may be left out. |
| `accepts.maxSizeMB` | Largest file size in MB. The bitrate is lowered to fit the spot's length. |
| `accepts.h264Profiles` | Allowed H.264 profiles, for example `["High", "Main"]`. |
| `accepts.sampleRates` | For example `[48000]`. |
| `accepts.audioKbps` | `{ "min": 192 }`, or an exact value as `{ "min": 128, "max": 128 }`. |
| `accepts.audioRequired` | `true` if the ad must have sound. |
| `accepts.loudness` | `{ "mode": "lufs", "target": -24, "peak": -2 }` (set to a level), `{ "mode": "max", "average": -12, "peak": -8 }` (limits only; quieter sound is left alone), or `{ "mode": "rms", "target": -14, "peak": -1 }` (average level target). |
| `accepts.tailBlackSec` | Seconds of black and silence added at the end (CTV local stations: 10). |
| `accepts.letterbox` | `"allowed"` or `"not allowed"` (black bars). |
| `accepts.duplicateFrames` | `"not allowed"` for placements that reject repeated frames. |

The entry with `"custom": true` is the Custom tile, where the person picks the settings.

### Other blocks in placements.json

- `formats`: the file types the tool can make. `formatPreference` is the order tried, lightest first.
- `encoding`: defaults (video and audio bitrate, sample rate, H.264 details, `sizeSafety` margin under size limits, `assumeLengthSec` before a video is loaded). Files at `quickPresetFromKbps` (10 Mbps) or more use the quicker `x264PresetQuick` setting, about twice as fast and identical at those bitrates.
- `spotLengths`: standard lengths (6, 15, 30, 60). A video within `snapWithinSec` of one is made exactly that long, counted in frames like broadcast timecode (15 s at 29.97 fps is 450 frames, 00:00:15:00).
- `strictness`: how the final report decides pass, look at, and fail. `limits`: memory warnings. `grain`: the light grain strength (4, tested; use even numbers).

### Frame rates

A video at a rate the file does not accept is changed to the closest accepted rate. 30 to 29.97, 24 to 23.976 and 60 to 59.94 are conformed: every frame is kept and retimed, and the sound stretched to match. Lower rates drop frames evenly, like Media Encoder's default. Higher rates repeat frames and add light grain.

## Deploying to GitHub Pages

Account `wchang4`, repository `placement-encoder`, branch `main`, folder `/ (root)`. Push with git from this folder; `vendor/core/ffmpeg-core.wasm` is about 31 MB, more than the website's upload button allows. The repository is public, so `placements.json` (specs and notes) is publicly readable: keep logins, passwords and anything confidential out of it.

## Known limits

- Edge and Chrome are supported. Firefox and Safari are untested.
- Single-threaded encoder, so encoding is slow (a 15 s ProRes file takes a few minutes).
- The finished file is held in memory before saving. About 0.8 GB and up is risky on 8 GB computers; 1.5 GB and up is blocked.
- The tool never crops or reframes, and does not add captions or described video.
- All placements are unverified until confirmed with the placement. Open questions: Cineplex average level (-12 vs -10 dB), Cineplex 8-bit vs 10-bit ProRes wording, the Disney+ "Main profile 4:2:2" contradiction, the Rogers self-serve specs (RSM Ad Manager help pages could not be reached), and how Landmark's "-12" audio wording should be read.
- `#0b4ea2` in `css/app.css` stands in for CAA blue until Marketing confirms the exact value.
