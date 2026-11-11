# Placement Encoder

Internal CAA NEO tool. Drop in a finished video, pick a placement, get a correctly encoded file and a technical check against that placement's spec. Everything runs in the browser (ffmpeg.wasm). Videos never leave the computer. There is no server, account or tracking.

The check is technical only. It is not a guarantee a placement will accept the file.

## What is in this folder

| File or folder | What it is |
|---|---|
| `index.html` | The tool (one page). |
| `guide.html` | One-page user guide for teammates. Linked from the tool. |
| `presets.json` | All placement presets. **This is the file you edit.** |
| `js/` | The tool's code (comments in plain language). |
| `logos/` | Optional placement logos for the step 2 tiles (see `logos/README.txt`). Empty by default. |
| `vendor/` | The encoder library, pinned and self-hosted: `@ffmpeg/ffmpeg` 0.12.15, `@ffmpeg/core` 0.12.10. Do not edit or update casually. |
| `serve.py` | Local test server (`python serve.py`, then open http://127.0.0.1:8080). Not needed on GitHub Pages. |
| `SCOPE.md`, `PHASE0-REPORT.md` | Internal design notes. Kept on the local copy only and not published (see `.gitignore`), along with the `spike/` test code. |

## Editing presets (no coding needed)

Open `presets.json` in any text editor (Notepad is fine). The instructions are also at the top of the file.

1. Change a value by editing the number or text after the colon. Keep the quotes around text and keep the commas.
2. To add a placement: copy one whole preset block (from its `{` to the matching `}`), paste it after the last preset, put a comma between the blocks, then change `id` (unique, no spaces), `name`, `group` and the values.
3. Each preset has:
   - `settings`: what the form is filled with. Users can still change any of it on the page.
   - `spec`: what the report checks the finished file against (bitrate range, allowed frame rates, aspect, size and duration limits, `noLetterbox`).
   - `naming`: file name rule (`maxLength`, `allowedChars`, and optionally `pattern`, a regular expression the name must match, with `patternLabel` as the plain-language version, as used for Landmark).
   - `loudness`: `mode` is `off`, `lufs` (integrated loudness, as a target), `rms` (average level, as a target) or `max` (limits only: audio that is already quiet enough is left alone, louder audio is turned down; use this for specs worded "no higher than", such as Cineplex), with `targetDb` and `peakDb`.
   - `group`: a label for your own reference; every placement is shown in one grid, with versions of the same brand side by side. The preset with `"custom": true` is the Custom option, shown last.
   - `tile`: how the placement looks in step 2: `title`, a short `sub` line, an accent `color` (dark enough for white text) and an optional `logo` path, for example `"logos/cineplex.svg"`. See `logos/README.txt`. With no logo, the title is shown on a badge in the accent colour.
   - `file` (optional): placements with the same `file` value share ONE file. The top-level `files` block names each shared file (`label`, a short `tag` added to the file name) and says which preset's settings it is made with (`settingsFrom`, plus optional `settings` overrides). The shared file is checked against the strictest rule of every placement in it. Remove a placement's `file` line to give it its own file.
   - `spec.barsAllowed`: `true` when the placement is known to accept black bars (Cineplex). The check then shows bars as information instead of a warning. `spec.noLetterbox: true` makes bars a problem.
   - `spec.noDuplicateFrames`: `true` for placements known to reject repeated frames (Disney+). The check then treats repeats as a problem instead of information.
   - Grain (duplicate-frame prevention) is off by default and offered by the page when needed. Its strength is the top-level `grain.strength` (4, tested). Use even numbers only: 1 does nothing and 3 and 5 proved unreliable. A preset can override it with `"noise": {"strength": 6}`.
   - `safeZones` (optional): guides drawn on the preview frames. Each has `label`, `type` (`safe` = keep content inside, `avoid` = keep content out), `x`, `y`, `w`, `h` in pixels on a frame of `refW` x `refH`. Only add zones the placement documents.
4. When a spec is confirmed with the placement: set `status` to `"verified"`, fill in `verifiedDate` (for example `"2026-11-02"`) and put the link in `source.url`. Presets stay marked UNVERIFIED in the tool until you do this.
5. A value of `null` means "not specified, keep the source's value".
6. Bitrates are kilobits per second. 10000 kbps = 10 Mbps.
7. Save, reload the page (Ctrl+F5). A typo (missing comma or quote) makes the page say it could not read presets.json. Paste the file into https://jsonlint.com to find the error. That page is only a text checker, but do not paste anything confidential.

The `strictness` block sets how PASS / WARN / FAIL are decided, and `limits` sets the memory warnings.

Every file keeps the shape of the uploaded video. A preset's `width` x `height` is its size for its own shape; a different shape gets the same short edge (a 1920 x 1080 preset makes 1080 x 1080 from a square and 1080 x 1920 from a vertical). Shape is not checked.

`tile.colors` (optional) shows several brand colours as stripes on the badge, for example CTV's red, blue and green. `tile.color` is still used for the outline.

`settings.tailBlackSec` adds that many seconds of black and silence at the end of the file (CTV local stations: 10). It is added after the spot is cut to its exact length.

Frame rate: with `fps` set to `"native"`, a video at a rate the placement does not list in `spec.allowedFps` is changed to the closest listed rate automatically. 30 to 29.97, 24 to 23.976 and 60 to 59.94 (0.1% apart) are conformed: every frame is kept and retimed, and the sound is stretched to match, so nothing is dropped or repeated. Lower rates drop frames evenly; higher rates repeat frames and switch on light grain.

The `spotLengths` block lists the standard spot lengths (6, 15, 30 and 60 seconds). A video within `snapWithinSec` (0.5 s) of one of them is made exactly that long: a little extra is cut, and if it is a little short the last frame is held with silence. Length is counted in frames, the way broadcast timecode counts it, so 6 seconds at 29.97 fps is 180 frames (6.006 s on a clock), and at 25 or 30 fps it is exactly 6.000 s. Placement length limits are not checked.

## Deploying to GitHub Pages

The tool is plain static files. Account: `wchang4` (same as the GIF tool).

Important: `vendor/core/ffmpeg-core.wasm` is about 31 MB. The GitHub website's "upload files" button stops at 25 MB per file, so use **GitHub Desktop** or git on the command line instead.

Using git on the command line, from this folder:

```bash
git init -b main
git add index.html guide.html presets.json js vendor README.md .nojekyll
git commit -m "Placement Encoder"
git remote add origin https://github.com/wchang4/placement-encoder.git
git push -u origin main
```

Create the empty repository `placement-encoder` on github.com first (no README, no license). Then in the repository: Settings > Pages > Build and deployment > Source: "Deploy from a branch", Branch: `main`, folder `/ (root)`, Save. After a minute or two the tool is at https://wchang4.github.io/placement-encoder/.

Public vs private: a free personal account serves Pages from public repositories only. The page holds no secrets, but the presets (specs and notes) become publicly readable. Remove anything you would not want public from `presets.json` first.

## Updating

Edit `presets.json` (or any file), then commit and push again. Browsers cache the encoder after the first visit; presets and code are fetched fresh by the page, so a reload is enough. Changing the encoder version means replacing `vendor/` and the cache name in `js/engine.js`. Test locally first.

## Known limits

- Tested only in the built-in test browser on Windows. Edge and Chrome are the supported browsers. Firefox and Safari are untested.
- Single-threaded encoder, so encoding is slow (H.264 about 0.1 to 0.15x real time on a fast machine).
- The finished file is held in memory before saving. About 0.8 GB and up is risky on 8 GB computers; about 1.5 GB and up is blocked.
- The tool never crops or reframes. Vertical (9:16) files must be supplied.
- All presets are currently UNVERIFIED. Known open questions: Cineplex average level (-12 vs -10 dB), the Disney+ "Main profile 4:2:2" contradiction, the Cineplex 8-bit vs 10-bit ProRes wording, the Rogers self-serve specs (not yet checked against the RSM Ad Manager help pages), and how Landmark's "-12" audio wording should be read.
