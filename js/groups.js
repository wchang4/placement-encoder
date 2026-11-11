// groups.js
// Several placements often take the same file (Amazon, Disney+ and YouTube all
// accept a high-quality MP4). Presets that share a "file" key in presets.json are
// made as ONE file, checked against the strictest rules of every placement in it.
//
// buildGroups(config, ids) turns the ticked placement ids into a list of files:
//   [{ key, label, tag, members: [preset, ...], preset }]
// "preset" is what the rest of the page works with. For a file with one placement
// it is that placement's own preset, unchanged. For several placements it is a
// combined preset: settings from the file's "settingsFrom" preset (plus any
// overrides), and a spec that keeps the strictest value of every member.

// "Cineplex" from "Cineplex: cinema pre-show", "YouTube Shorts" from "YouTube Shorts (vertical, unverified)"
export const shortName = (p) => p.name.split(':')[0].replace(/\s*\([^)]*\)\s*$/, '').trim();

// "A", "A and B", "A, B and C" (duplicates removed)
export function joinNames(names) {
  const u = [...new Set(names)];
  return u.length <= 1 ? (u[0] || '') : u.slice(0, -1).join(', ') + ' and ' + u[u.length - 1];
}

export function buildGroups(config, ids) {
  const files = config.files || {};
  const byKey = new Map();
  for (const p of config.presets) {          // keep the order of presets.json
    if (!ids.includes(p.id)) continue;
    const key = p.file || p.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const out = [];
  for (const [key, members] of byKey) {
    const f = files[key] || {};
    if (members.length === 1) {
      const p = members[0];
      out.push({ key, label: f.label ? `${f.label}` : p.name, tag: f.tag || '', members, preset: p });
      continue;
    }
    const lead = config.presets.find(p => p.id === f.settingsFrom) || members[0];
    out.push({ key, label: f.label || joinNames(members.map(shortName)), tag: f.tag || key.toUpperCase(), members, preset: combine(key, f, lead, members) });
  }
  return out;
}

function combine(key, f, lead, members) {
  const names = members.map(shortName);
  const specs = members.map(m => m.spec || {});
  const pick = (k) => specs.map(s => s[k]).filter(v => v != null);
  const minOf = (k) => (pick(k).length ? Math.min(...pick(k)) : null);
  const maxOf = (k) => (pick(k).length ? Math.max(...pick(k)) : null);
  const whoHas = (k, test) => joinNames(members.filter(m => m.spec && test(m.spec[k])).map(shortName));

  // Lists: a value is allowed only if every placement that sets a list allows it.
  const intersect = (k, same = (a, b) => a === b) => {
    const lists = pick(k);
    if (!lists.length) return null;
    return lists.reduce((acc, l) => acc.filter(v => l.some(w => same(v, w))));
  };
  const allowedFps = intersect('allowedFps', (a, b) => Math.abs(a - b) / b < 0.001);
  const maxDur = minOf('maxDurationSec');

  const spec = {
    minKbps: maxOf('minKbps'), maxKbps: minOf('maxKbps'),
    allowedFps,
    aspect: specs.find(s => s.aspect)?.aspect ?? null,
    allowedAspects: intersect('allowedAspects'),
    minShortEdge: maxOf('minShortEdge'),
    audioRequired: specs.some(s => s.audioRequired),
    minAudioKbps: maxOf('minAudioKbps'),
    maxSizeMB: minOf('maxSizeMB'),
    maxDurationSec: maxDur,
    h264ProfilesAllowed: intersect('h264ProfilesAllowed'),
    noLetterbox: specs.some(s => s.noLetterbox),
    barsAllowed: specs.every(s => s.barsAllowed),
    noDuplicateFrames: specs.some(s => s.noDuplicateFrames),
    // who sets the strict rules, so messages can name the placement
    noLetterboxBy: whoHas('noLetterbox', v => v === true),
    noDuplicateFramesBy: whoHas('noDuplicateFrames', v => v === true),
    maxDurationBy: maxDur == null ? '' : whoHas('maxDurationSec', v => v === maxDur)
  };
  if (spec.allowedAspects && !spec.allowedAspects.length) spec.allowedAspects = null;

  // File name: the strictest rule wins.
  const rules = members.map(m => m.naming).filter(n => n && (n.maxLength || n.allowedChars || n.pattern));
  let naming = null;
  if (rules.length) {
    const maxLength = Math.min(...rules.map(n => n.maxLength || Infinity));
    const chars = rules.map(n => n.allowedChars).filter(Boolean).sort((a, b) => a.length - b.length)[0] || null;
    const strictest = rules.slice().sort((a, b) => (a.maxLength || Infinity) - (b.maxLength || Infinity))[0];
    const pat = rules.find(n => n.pattern);
    naming = { maxLength: isFinite(maxLength) ? maxLength : null, allowedChars: chars, pattern: pat?.pattern || null, patternLabel: pat?.patternLabel || '', note: (pat || strictest).note || '' };
  }

  // Safe-zone guides from every placement (same label only once).
  const zones = [];
  for (const m of members) for (const z of (m.safeZones || [])) if (!zones.some(y => y.label === z.label)) zones.push({ ...z, label: `${shortName(m)}: ${z.label}` });

  return {
    id: 'file:' + key,
    name: joinNames(names),
    combined: true,
    members: members.map(m => m.id),
    status: members.every(m => m.status === 'verified') ? 'verified' : 'unverified',
    verifiedDate: '',
    source: { label: members.map(m => `${shortName(m)}: ${m.source?.label || 'none'}`).join(' · '), url: '' },
    notes: [
      `One file for ${joinNames(names)}. It is made with the ${lead.name} settings and checked against the strictest rule of each placement.`,
      ...(f.notes || []),
      ...members.flatMap(m => (m.notes || []).map(n => `${shortName(m)}: ${n}`))
    ],
    settings: { ...JSON.parse(JSON.stringify(lead.settings)), ...(f.settings || {}) },
    loudness: lead.loudness,
    noise: lead.noise,
    spec,
    naming,
    safeZones: zones
  };
}
