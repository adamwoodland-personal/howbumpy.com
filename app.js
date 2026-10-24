// How Bumpy? (howbumpy.com) - page logic. The measurement maths lives in comfort.js.
import { analyse, emptyRecord, slice, BANDS, bandOf, G, SETTLE, synth, tramProfile } from './comfort.js';

const $ = (id) => document.getElementById(id);
const MODES = { train: ['🚆', 'Train'], tram: ['🚊', 'Tram'], bus: ['🚌', 'Bus'], car: ['🚗', 'Car'], bike: ['🚲', 'Bike'], plane: ['✈️', 'Plane'], boat: ['⛴️', 'Boat'], other: ['🧭', 'Ride'] };
const BAND_VARS = ['--b0', '--b1', '--b2', '--b3', '--b4', '--b5'];
const RIDES_KEY = 'rcm-rides-v1', PREFS_KEY = 'rcm-prefs-v1';
// Stop on our own, by the wall clock (performance.now), after two hours or after five minutes with no
// readings, so a phone whose sensor stops reporting can't hold the screen awake indefinitely. A dark
// screen can pause the page entirely; then the check runs when it wakes. Tests may shorten these.
const LIMITS = { maxMs: 2 * 3600 * 1000, quietMs: 5 * 60 * 1000 };
const TRIM_START = 1, TRIM_END = 2; // seconds dropped at each end (setting the phone down, tapping Stop)
const MIN_SECONDS = 20;

const S = {
  mode: 'train', rec: null, listening: false, recording: false, starting: false, gotEvent: false,
  session: 0, startedAt: 0, lastT: -Infinity, lastEventAt: 0, tick: null, wake: null, live: null,
  report: null, cardBlob: null,
};

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const bandColour = (i) => css(BAND_VARS[i]);
const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const mmss = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };
const human = (s) => { s = Math.round(s); if (s < 90) return `${s} s`; const m = Math.round(s / 60); return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

// ---------- storage ----------
function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } }

// ---------- views ----------
function show(view) {
  closeSheet(false);
  for (const id of ['setup', 'rec', 'report']) $(id).hidden = id !== view;
  document.body.classList.toggle('recording', view === 'rec');
  renderHistory();
  barHeight();
  if (view !== 'rec') window.scrollTo({ top: 0 });
}

// ---------- phone layout: pinned bar and bottom sheets ----------
// Same query as style.css. On wide screens the sheets (#about, #history, #rMore) are ordinary inline sections.
const PHONE = matchMedia('(max-width: 699.98px), (max-height: 540px)');
// The content keeps clear of the pinned bar, however tall the bar turns out.
function barHeight() {
  const b = document.querySelector('main > section:not([hidden]) .bar');
  document.body.style.setProperty('--bar-h', `${PHONE.matches && b ? b.offsetHeight : 0}px`);
}
let sheet = null; // { el, opener } while one is open
// Everything outside the sheet goes inert while it is open (the scrim stays clickable).
function inertAround(el, on) {
  for (let n = el; n.parentElement && n !== document.body; n = n.parentElement)
    for (const sib of n.parentElement.children) if (sib !== n && sib.id !== 'scrim' && sib.tagName !== 'SCRIPT') sib.inert = on;
}
function openSheet(id, opener) {
  if (!PHONE.matches) return;
  closeSheet(false);
  const el = $(id);
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.scrollTop = 0; el.classList.add('open');
  $('scrim').hidden = false; document.body.classList.add('sheet-open');
  inertAround(el, true);
  sheet = { el, opener };
  el.querySelector('.sheet-x').focus({ preventScroll: true });
}
function closeSheet(restore = true) {
  if (!sheet) return;
  const { el, opener } = sheet; sheet = null;
  el.classList.remove('open', 'dragging'); el.style.transform = '';
  el.removeAttribute('role'); el.removeAttribute('aria-modal');
  $('scrim').hidden = true; document.body.classList.remove('sheet-open');
  inertAround(el, false);
  if (restore && opener && opener.offsetParent) opener.focus({ preventScroll: true });
}
// Drag a sheet down by its head to close it. Presses on its buttons are left alone, and the release is
// heard on window without pointer capture, so the close button's click still arrives.
function dragSheet(e) {
  if (!sheet || !sheet.el.contains(e.target) || e.button > 0 || e.target.closest('button')) return;
  const el = sheet.el, y0 = e.clientY; let dy = 0;
  el.classList.add('dragging');
  const move = (ev) => { dy = Math.max(0, ev.clientY - y0); el.style.transform = `translateY(${dy}px)`; };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    el.classList.remove('dragging'); el.style.transform = '';
    if (dy > 70) closeSheet();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}

// ---------- mode picker ----------
// Setup steps and countdown wording: on the seat for every vehicle except a bike, which needs a handlebar mount.
const TIPS = {
  seat: ['Sit down and lay the phone flat on the seat, in the same spot each time so your rides compare fairly.', 'Tap Start: you get 3 seconds to put it down.', 'Leave it still, and tap Stop when you arrive.', 'Put the phone down'],
  bike: ['Clip the phone firmly into a handlebar mount. It feels the bars rather than the saddle, so compare bike rides with each other.', 'Tap Start: you get 3 seconds to clip it in.', 'Ride, and tap Stop when you finish. Quick leans into corners may be left out, like picking the phone up.', 'Clip the phone in'],
};
function setMode(m) {
  S.mode = MODES[m] ? m : 'train';
  for (const b of $('modes').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.mode === S.mode));
  const t = TIPS[S.mode === 'bike' ? 'bike' : 'seat'];
  $('tips').querySelectorAll('li').forEach((li, i) => { li.textContent = t[i]; });
  $('cdText').textContent = t[3];
  store(PREFS_KEY, { ...load(PREFS_KEY, {}), mode: S.mode });
}

// ---------- gauge ----------
const G_MIN = 0.1, G_MAX = 3.2; // log scale of the dial, m/s^2
const angleOf = (v) => { const x = Math.log(Math.max(G_MIN, Math.min(G_MAX, v)) / G_MIN) / Math.log(G_MAX / G_MIN); return -90 + 180 * x; };
function buildGauge() {
  const g = $('gaugeArcs'), cx = 110, cy = 115, r = 88;
  const pt = (deg) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  let lo = G_MIN;
  BANDS.forEach((b, i) => {
    const hi = Math.min(G_MAX, b.cut);
    if (hi <= lo) return;
    const [x1, y1] = pt(angleOf(lo) + 0.6), [x2, y2] = pt(angleOf(hi) - 0.6);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`);
    p.setAttribute('stroke', bandColour(i));
    g.appendChild(p);
    lo = hi;
  });
}
function setGauge(v) {
  const i = bandOf(v), ok = i >= 0; // anything that isn't a sensible number shows as "–", with no label
  $('needle').style.transform = `rotate(${ok ? angleOf(v) : -90}deg)`;
  $('nowVal').textContent = ok ? fmt(v) : '–';
  const lbl = $('nowLabel');
  if (!ok) return;
  lbl.textContent = BANDS[i].label;
  lbl.style.color = bandColour(i);
}

// ---------- charts ----------
// values: comfort (m/s^2) per point, NaN = no data; step = seconds per point; jolts: [{t}] seconds.
function drawChart(canvas, values, { step = 1, jolts = [], offset = 0 } = {}) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 300, H = canvas.clientHeight || 150;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const L = 34, R = 6, T = 8, B = 20, pw = W - L - R, ph = H - T - B;
  let top = 0; for (const v of values) if (Number.isFinite(v)) top = Math.max(top, v);
  const ymax = Math.max(0.7, top * 1.15);
  const y = (v) => T + ph - (Math.min(v, ymax) / ymax) * ph;
  // band backgrounds
  let lo = 0;
  BANDS.forEach((b, i) => {
    const hi = Math.min(ymax, b.cut);
    if (hi > lo) { c.fillStyle = bandColour(i); c.globalAlpha = 0.13; c.fillRect(L, y(hi), pw, y(lo) - y(hi)); c.globalAlpha = 1; }
    lo = Math.max(lo, hi);
  });
  // axes
  c.fillStyle = css('--muted'); c.font = '11px system-ui, sans-serif'; c.textAlign = 'right'; c.textBaseline = 'middle';
  const yStep = ymax > 2 ? 1 : ymax > 1 ? 0.5 : 0.25;
  for (let v = 0; v <= ymax + 1e-9; v += yStep) { c.fillText(v.toFixed(v < 1 && yStep < 0.5 ? 2 : 1), L - 5, y(v)); c.globalAlpha = 0.15; c.fillRect(L, y(v), pw, 1); c.globalAlpha = 1; }
  const n = values.length, span = Math.max(1, n * step);
  const x = (s) => L + (s / span) * pw;
  c.textAlign = 'center'; c.textBaseline = 'top';
  const tStep = span > 7200 ? 1800 : span > 2400 ? 600 : span > 900 ? 300 : span > 300 ? 60 : span > 120 ? 30 : 10;
  for (let s = 0; s <= span; s += tStep) c.fillText(mmss(s + offset), x(s), H - B + 4);
  // line, coloured by band
  c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
  let prev = null;
  for (let k = 0; k < n; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) { prev = null; continue; }
    const px = x((k + 0.5) * step), py = y(v);
    if (prev) { c.strokeStyle = bandColour(bandOf(v)); c.beginPath(); c.moveTo(prev[0], prev[1]); c.lineTo(px, py); c.stroke(); }
    else { c.fillStyle = bandColour(bandOf(v)); c.fillRect(px - 1, py - 1, 2, 2); }
    prev = [px, py];
  }
  // jolt markers
  c.fillStyle = css('--text');
  for (const j of jolts) { const px = x(j.t - offset); if (px < L || px > L + pw) continue; c.beginPath(); c.moveTo(px, T + 7); c.lineTo(px - 5, T - 2); c.lineTo(px + 5, T - 2); c.closePath(); c.fill(); }
}
// Shrink a per-second series to at most `max` points, keeping each slot's highest value.
function shrink(values, max) {
  if (values.length <= max) return { values: Array.from(values, (v) => (Number.isFinite(v) ? +v.toFixed(3) : null)), step: 1 };
  const k = Math.ceil(values.length / max), out = [];
  for (let i = 0; i < values.length; i += k) {
    let m = -1; for (let j = i; j < Math.min(values.length, i + k); j++) if (Number.isFinite(values[j]) && values[j] > m) m = values[j];
    out.push(m < 0 ? null : +m.toFixed(3));
  }
  return { values: out, step: k };
}

// ---------- recording ----------
// Every motion component is nullable in the W3C API. A reading is kept only with all three
// including-gravity components; the linear (gravity-removed) vector is kept only when complete.
// Rotation rate isn't used (see comfort.js).
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || ![a.x, a.y, a.z].every((c) => Number.isFinite(num(c)))) return;
  S.gotEvent = true;
  S.lastEventAt = performance.now();
  if (!S.recording) return;
  const t = typeof e.rcmTime === 'number' ? e.rcmTime : e.timeStamp; // rcmTime: test hook
  if (!(t > S.lastT)) return;
  S.lastT = t;
  const l = e.acceleration, R = S.rec;
  const lin = l ? [num(l.x), num(l.y), num(l.z)] : [NaN, NaN, NaN];
  const full = lin.every(Number.isFinite);
  R.t.push(t); R.ix.push(a.x); R.iy.push(a.y); R.iz.push(a.z);
  R.lx.push(full ? lin[0] : NaN); R.ly.push(full ? lin[1] : NaN); R.lz.push(full ? lin[2] : NaN);
}

// A wake lock that arrives after the session it was asked for has ended is let go at once.
async function lockScreen(sess) {
  try {
    if (!navigator.wakeLock || document.visibilityState !== 'visible' || S.wake) return;
    const w = await navigator.wakeLock.request('screen');
    if (sess !== S.session || !S.listening) { w.release().catch(() => {}); return; }
    S.wake = w;
    w.addEventListener('release', () => { if (S.wake === w) S.wake = null; });
  } catch { /* not allowed here, or not supported */ }
}

async function start() {
  if (S.starting || S.listening) return; // a second tap while starting or measuring
  S.starting = true; $('startBtn').disabled = true;
  try {
    $('sensorMsg').hidden = true;
    // Ask inside the tap. iOS asks the user; Chrome 151+ only reports its Motion sensors setting.
    // Only an explicit "denied" stops us.
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      let answer = 'unknown';
      try { answer = await DME.requestPermission(); } catch { /* not allowed here, carry on and see */ }
      if (answer === 'denied') return sensorProblem('denied');
    }
    const sess = ++S.session; // anything still running from an earlier start checks this and gives up
    S.rec = emptyRecord(); S.lastT = -Infinity; S.gotEvent = false; S.recording = false;
    S.live = { E: 0, n: 0, finalUntil: -Infinity, jolt: 0, values: [] };
    window.addEventListener('devicemotion', onMotion); S.listening = true;
    show('rec');
    setGauge(null); $('nowLabel').textContent = 'Waiting for the first readings…'; $('nowLabel').style.color = '';
    $('elapsed').textContent = '0:00'; $('soFar').textContent = '–'; $('joltNow').textContent = '–'; $('recStatus').textContent = '';
    drawChart($('liveChart'), []);
    lockScreen(sess);
    // Countdown, then record. No readings within the countdown means there is no usable motion sensor.
    const cd = $('countdown'); cd.hidden = false;
    $('stopBtn').textContent = 'Cancel';
    for (let k = 3; k > 0; k--) {
      $('countNum').textContent = String(k);
      await new Promise((r) => setTimeout(r, 1000));
      if (sess !== S.session) return; // stopped during the countdown
    }
    cd.hidden = true; $('stopBtn').textContent = 'Stop';
    if (!S.gotEvent) { stopListening(); show('setup'); return sensorProblem('none'); }
    S.recording = true; S.startedAt = S.lastEventAt = performance.now();
    clearInterval(S.tick); S.tick = setInterval(liveTick, 1000);
  } finally {
    S.starting = false; $('startBtn').disabled = false;
  }
}

function stopListening() {
  S.session++; // ends the session: a pending countdown or wake-lock request now gives up
  if (S.listening) { window.removeEventListener('devicemotion', onMotion); S.listening = false; }
  clearInterval(S.tick); S.tick = null; S.recording = false;
  $('countdown').hidden = true; $('stopBtn').textContent = 'Stop';
  if (S.wake) { S.wake.release().catch(() => {}); S.wake = null; }
}

function sensorProblem(kind) {
  const m = $('sensorMsg');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  m.textContent = kind === 'denied'
    ? (ios ? 'Motion access was turned down. To allow it, close this tab, open it again and tap Allow. If it isn\'t offered again, go to Settings › Apps › Safari › Advanced › Website Data, delete this site\'s data, and try again.'
      : 'Motion sensors are blocked for this site. Allow them in the browser\'s site settings (Motion sensors), then try again.')
    : 'No motion readings came through. This device may not have a motion sensor (most laptops don\'t), so try it on a phone, or see the sample ride below.';
  m.hidden = false;
  m.scrollIntoView({ block: 'nearest' });
}

function liveTick() {
  const now = performance.now(), R = S.rec, n = R.t.length;
  const wall = (now - S.startedAt) / 1000, quiet = now - S.lastEventAt;
  $('elapsed').textContent = mmss(wall);
  // The limits come first and use the wall clock, so they still fire when readings have stopped.
  if (now - S.startedAt >= LIMITS.maxMs) return stop('limit');
  if (quiet >= LIMITS.quietMs) return stop('quiet');
  if (quiet > 1500) $('recStatus').textContent = 'No motion readings right now. Keep this page open with the screen on.';
  if (n < 30) return;
  const tEnd = R.t[n - 1], elapsed = wall;
  let i0 = n - 1;
  while (i0 > 0 && R.t[i0 - 1] > tEnd - 20000) i0--;
  const r = analyse(slice(R, i0, n), { live: true });
  if (!r || r.error || !r.e) return;
  // Add samples to the running total once they are 3 s old (settled, and past any pick-up widening).
  const L = S.live, cutoff = tEnd - 3000, step = 1000 / r.fs;
  for (let i = 0; i < (r.M || 0); i++) {
    const t = r.tg0 + i * step;
    if (t <= L.finalUntil || t > cutoff) continue;
    if (Number.isFinite(r.e[i])) { L.E += r.e[i]; L.n++; if (r.jolt[i] > L.jolt) L.jolt = r.jolt[i]; }
  }
  L.finalUntil = Math.max(L.finalUntil, cutoff);
  if (Number.isFinite(r.last5)) { setGauge(r.last5); L.values.push(r.last5); } else L.values.push(NaN);
  if (L.values.length > 120) L.values.shift();
  const soFar = L.n > r.fs * 5 ? Math.sqrt(L.E / L.n) : NaN;
  if (Number.isFinite(soFar)) $('soFar').textContent = fmt(soFar);
  if (L.jolt > 0.3) $('joltNow').textContent = `${fmt(L.jolt / G)} g`;
  drawChart($('liveChart'), L.values, { offset: Math.max(0, elapsed - L.values.length) });
  let status = '';
  if (r.handledNow) status = 'Phone moving: hold it still. These seconds are left out.';
  else if (quiet > 1500) status = 'No motion readings right now. Keep this page open with the screen on.';
  else if (r.fs < 20) status = `This phone only reports motion ${r.fs} times a second: faster shaking isn't measured and may show up as slower shaking.`;
  $('recStatus').textContent = status;
}

// reason: 'user' (Stop), 'limit' (two hours) or 'quiet' (no readings for five minutes).
function stop(reason) {
  const rec = S.rec;
  stopListening();
  const r = rec && analyse(rec, { trimStart: TRIM_START, trimEnd: TRIM_END });
  if (!r || r.error || !Number.isFinite(r.av) || !(r.duration >= MIN_SECONDS)) {
    show('setup');
    const m = $('sensorMsg');
    m.textContent = r && r.error ? `${r.error} If it keeps happening, this phone's motion readings may not be usable here.`
      : reason === 'quiet' ? 'Measuring stopped on its own: no motion readings came through for five minutes (the screen may have gone off, or the page into the background), and there wasn\'t enough before that to measure.'
      : r && r.excludedHandled > r.duration ? 'The phone was moving most of the time, so there wasn\'t enough to measure. Lay it down and leave it still.'
      : `That was too short to measure. Leave it running for at least ${MIN_SECONDS + TRIM_START + TRIM_END + SETTLE.comfort} seconds.`;
    m.hidden = false;
    m.scrollIntoView({ block: 'nearest' });
    return;
  }
  const sum = summarise(r, { mode: S.mode, name: $('rideName').value.trim(), sample: false, stopped: reason });
  const rides = load(RIDES_KEY, []);
  rides.unshift(sum);
  if (!store(RIDES_KEY, rides.slice(0, 60))) sum.unsaved = true;
  openReport(sum, r);
}

function summarise(r, { mode, name, sample, stopped }) {
  const tl = shrink(r.timeline, 600);
  // v2 (2026-10-23): roughest window start/end, crest axis, settling time, dose durations, sensor checks.
  // Saved v1 rides still open: openReport copes with their older fields.
  return {
    v: 2, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: new Date().toISOString(),
    mode, name: name || '', sample: !!sample, stopped: stopped || '',
    duration: r.duration, span: r.span, av: r.av, awz: r.awz, awh: r.awh, band: r.band,
    worst5: r.worst5, worst5From: r.worst5From, worst5To: r.worst5To, peakJolt: r.peakJolt, jolts: r.jolts,
    vdv: r.vdv, doseSeconds: r.doseSeconds, crest: r.crest, crestAxis: r.crestAxis,
    msdv: r.msdv, msi: r.msi, msdvSeconds: r.msdvSeconds, fs: r.fs,
    excludedGap: r.excludedGap, excludedHandled: r.excludedHandled, excludedSettle: r.excludedSettle,
    useLinear: r.useLinear, gravity: r.gravity, clipped: r.clipped, dropped: r.dropped,
    timeline: tl.values, step: tl.step, offset: r.start,
  };
}

// ---------- report ----------
function scaleRows(av) {
  const box = $('rScale'); box.textContent = '';
  const lo = 0.1, hi = 4, pos = (v) => (Math.log(Math.max(lo, Math.min(hi, v)) / lo) / Math.log(hi / lo)) * 100;
  BANDS.forEach((b, i) => {
    const row = document.createElement('div'); row.className = 'row';
    const bar = document.createElement('div'); bar.className = 'bar';
    const a = pos(Math.max(lo, b.range[0])), z = pos(Math.min(hi, b.range[1]));
    bar.style.left = `${a}%`; bar.style.width = `${z - a}%`; bar.style.background = bandColour(i);
    const tag = document.createElement('span'); tag.textContent = b.label;
    if (i === bandOf(av)) tag.className = 'on';
    if (a > 50) tag.style.right = `${100 - a}%`; else tag.style.left = `${z}%`; // beside the bar, on the roomier side
    row.append(bar, tag); box.appendChild(row);
  });
  const mark = document.createElement('div'); mark.className = 'mark'; mark.style.left = `${pos(av)}%`; box.appendChild(mark);
  const ticks = document.createElement('div'); ticks.className = 'ticks';
  for (const v of [0.1, 0.315, 0.63, 1, 1.6, 2.5, 4]) { const s = document.createElement('span'); s.style.left = `${pos(v)}%`; s.textContent = String(v); ticks.appendChild(s); }
  box.appendChild(ticks);
}

function openReport(sum, analysis = null) {
  S.report = { sum, analysis };
  const [em, nm] = MODES[sum.mode] || MODES.other;
  $('sampleBadge').hidden = !sum.sample;
  const when = new Date(sum.date).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('rMeta').textContent = `${em} ${sum.name || nm} · ${human(sum.duration)} measured${sum.sample ? '' : ` · ${when}`}`;
  const v = $('rVerdict'); v.textContent = BANDS[sum.band].label; v.style.color = bandColour(sum.band);
  $('rAv').textContent = fmt(sum.av);
  scaleRows(sum.av);
  $('rZ').textContent = `${fmt(sum.awz)} m/s²`;
  $('rH').textContent = `${fmt(sum.awh)} m/s²`;
  // v1 rides saved before 2026-10-23 have worst5At (the window's last second) instead of From/To.
  $('rWorst').textContent = sum.worst5 == null ? 'no full 5 seconds to judge'
    : sum.worst5From != null ? `${fmt(sum.worst5)} m/s², ${mmss(sum.worst5From)} to ${mmss(sum.worst5To)}`
    : `${fmt(sum.worst5)} m/s², around ${mmss(sum.worst5At)}`;
  $('rJolt').textContent = sum.peakJolt > 0.03 ? `about ${fmt(sum.peakJolt)} g` : 'none to speak of';
  const notes = [], left = [];
  if (sum.excludedHandled >= 1) left.push(`${human(sum.excludedHandled)} while the phone was being moved`);
  if (sum.excludedGap >= 1) left.push(`${human(sum.excludedGap)} with no readings (screen off or page in the background)`);
  if (left.length && sum.excludedSettle >= 1) left.push(`${human(sum.excludedSettle)} of settling time after each break`);
  if (left.length) notes.push(`Left out: ${left.length > 1 ? left.slice(0, -1).join(', ') + ' and ' + left[left.length - 1] : left[0]}.`);
  if (sum.crest > 9) {
    const axis = sum.crestAxis ? `${sum.crestAxis} ` : '';
    notes.push(`This ride was jolty: its sharpest ${axis}peaks were ${fmt(sum.crest, 0)} times its typical level. ISO 2631-1 suggests that above 9 the vibration dose value (${fmt(sum.vdv)} m/s^1.75${sum.doseSeconds ? `, over ${human(sum.doseSeconds)}` : ''}) describes a ride better than the average.`);
  }
  if (sum.gravity && Math.abs(sum.gravity - G) > 0.5) notes.push(`Sensor check: this phone read gravity as ${fmt(sum.gravity)} m/s² instead of about 9.81, so its readings may be off by about ${Math.round(Math.abs(sum.gravity / G - 1) * 100)}%.`);
  if (sum.clipped) notes.push(`Some readings hit the sensor's limit (${fmt(sum.clipped.level, 1)} m/s²), so the biggest jolts were probably bigger than shown.`);
  if (sum.stopped === 'limit') notes.push('Measuring stopped on its own after two hours.');
  if (sum.stopped === 'quiet') notes.push('Measuring stopped on its own: no motion readings came through for five minutes.');
  if (sum.unsaved) notes.push('This browser wouldn\'t let the page save the ride.');
  $('rNote').textContent = notes.join(' '); $('rNote').hidden = !notes.length;
  drawChart($('rChart'), sum.timeline.map((x) => (x == null ? NaN : x)), { step: sum.step, jolts: sum.jolts, offset: sum.offset });
  const jl = $('rJolts'); jl.textContent = '';
  for (const j of sum.jolts) {
    const li = document.createElement('li');
    li.textContent = `About ${fmt(j.g)} g at ${mmss(j.t)}, ${j.vertical ? 'mostly up and down' : 'mostly sideways or front to back'}`;
    jl.appendChild(li);
  }
  $('rJoltsWrap').hidden = !sum.jolts.length;
  const sickFor = sum.msdvSeconds ? ` over the ${human(sum.msdvSeconds)} usable for it` : '';
  if (sum.msdv == null) $('rSick').textContent = 'Not enough continuous readings for a seasickness dose.';
  else {
    const pct = sum.msi < 0.1 ? 'under 0.1%' : sum.msi < 10 ? `about ${fmt(sum.msi, 1)}%` : `about ${fmt(sum.msi, 0)}%`;
    $('rSick').textContent = `Dose ${fmt(sum.msdv)} m/s^1.5${sickFor}. ISO 2631-1's rough rule says that much slow up-and-down motion would make ${pct} of adults vomit.`
      + ((sum.msdvSeconds || sum.duration) < 1200 ? ' The dose keeps building on longer rides, so it means most after 20 minutes or more.' : '')
      + (sum.mode === 'car' || sum.mode === 'bus' ? ' Car sickness comes mostly from braking and cornering, which this dose doesn\'t count.' : '')
      + (sum.mode === 'bike' ? ' On a bike it means little: it is meant for passengers swaying slowly, as on a boat.' : '');
  }
  const tech = [
    ['Sampling', `${sum.fs} readings a second: shaking up to about ${Math.floor(sum.fs / 2)} times a second is measured; faster shaking isn't, and can show up as slower shaking (aliasing)`],
    ['Sensor', sum.useLinear ? 'motion with gravity removed by the phone' : 'motion including gravity (gravity worked out here)'],
    ['Sensor check', sum.gravity ? `gravity read as ${fmt(sum.gravity)} m/s² (expected about 9.81)` : null],
    ['Readings set aside', sum.dropped ? `${sum.dropped} with missing values` : null],
    ['Pick-up detection', 'how fast the phone\'s gravity direction swings'],
    ['Measured', `${human(sum.duration)} of ${human(sum.span)}${sum.excludedSettle >= 1 ? ` (including ${human(sum.excludedSettle)} of filter settling left out)` : ''}`],
    ['Up and down, Wk', `${fmt(sum.awz, 3)} m/s²`],
    ['Horizontal, Wd', `${fmt(sum.awh, 3)} m/s²`],
    ['Total (weighted)', `${fmt(sum.av, 3)} m/s²`],
    ['Vibration dose value', `${fmt(sum.vdv)} m/s^1.75${sum.doseSeconds ? ` over ${human(sum.doseSeconds)}` : ''}`],
    ['Crest factor', `${fmt(sum.crest, 1)}${sum.crestAxis ? ` (sharpest axis: ${sum.crestAxis})` : ' (up and down only, older ride)'}`],
    ['Motion sickness dose, Wf', sum.msdv == null ? 'not enough continuous readings' : `${fmt(sum.msdv, 3)} m/s^1.5${sickFor}`],
    ['Method', 'The frequency weightings of ISO 2631-1:1997 (Wk, Wd, Wf), applied to each continuous stretch of readings, k = 1 on every axis. "Up and down" means along gravity, so in a reclined seat or a banking vehicle the split is approximate. A just-for-fun estimate from a phone: not calibrated, validated or certified, and not a measurement to ISO 2631.'],
  ];
  const td = $('rTech'); td.textContent = '';
  for (const [k, val] of tech) {
    if (val == null) continue;
    const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = val; td.append(dt, dd);
  }
  const saved = !sum.sample && load(RIDES_KEY, []).some((x) => x.id === sum.id);
  for (const b of document.querySelectorAll('.act-csv')) b.hidden = !analysis;
  for (const b of document.querySelectorAll('.act-del')) b.hidden = !saved;
  show('report');
  // Draw the card now, so Send can run inside the tap (iOS needs that). On phones one button
  // shares the image where the browser can, and saves it where it can't.
  S.cardBlob = null; $('shareBtn').textContent = 'Save image';
  makeCard(sum).then((b) => {
    if (S.report.sum !== sum) return;
    S.cardBlob = b; $('sendBtn').hidden = !canSend(b); $('shareBtn').textContent = canSend(b) ? 'Share' : 'Save image';
  });
}

function canSend(blob) {
  try { return !!(blob && navigator.canShare && navigator.canShare({ files: [new File([blob], 'ride.png', { type: 'image/png' })] })); } catch { return false; }
}

// ---------- share card ----------
function makeCard(sum) {
  const W = 1080, H = 1080, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), col = bandColour(sum.band);
  x.fillStyle = css('--bg'); x.fillRect(0, 0, W, H);
  x.fillStyle = css('--card'); x.fillRect(48, 48, W - 96, H - 96);
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const [em, nm] = MODES[sum.mode] || MODES.other;
  x.fillStyle = css('--muted'); x.font = font(600, 34); x.fillText('HOW BUMPY?', 96, 130);
  x.fillStyle = css('--text'); x.font = font(700, 52);
  const title = `${em} ${sum.name || nm}`; x.fillText(title.length > 30 ? title.slice(0, 29) + '…' : title, 96, 205);
  x.fillStyle = css('--muted'); x.font = font(400, 32);
  x.fillText(`${human(sum.duration)} measured${sum.sample ? ' · simulated' : ' · ' + new Date(sum.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`, 96, 255);
  x.fillStyle = col; x.font = font(800, 78); x.fillText(BANDS[sum.band].label, 96, 400);
  x.fillStyle = css('--text'); x.font = font(800, 150); x.fillText(fmt(sum.av), 96, 570);
  const w = x.measureText(fmt(sum.av)).width; x.font = font(500, 44); x.fillStyle = css('--muted'); x.fillText('m/s²', 116 + w, 570);
  // band strip with marker
  const lo = 0.1, hi = 4, X0 = 96, XW = W - 192, pos = (v) => X0 + (Math.log(Math.max(lo, Math.min(hi, v)) / lo) / Math.log(hi / lo)) * XW;
  let a = lo;
  BANDS.forEach((b, i) => { const z = Math.min(hi, b.cut); x.fillStyle = bandColour(i); x.fillRect(pos(a), 630, pos(z) - pos(a) - 3, 26); a = z; });
  x.fillStyle = css('--text'); x.fillRect(pos(sum.av) - 4, 616, 8, 54);
  // timeline
  const vals = sum.timeline.filter((v) => v != null), top = Math.max(0.7, ...vals) * 1.1, Y0 = 720, YH = 220;
  x.fillStyle = css('--bg'); x.fillRect(96, Y0, XW, YH);
  x.lineWidth = 5; x.lineCap = 'round'; let prev = null;
  sum.timeline.forEach((v, k) => {
    if (v == null) { prev = null; return; }
    const px = 96 + ((k + 0.5) / sum.timeline.length) * XW, py = Y0 + YH - (Math.min(v, top) / top) * YH;
    if (prev) { x.strokeStyle = bandColour(bandOf(v)); x.beginPath(); x.moveTo(prev[0], prev[1]); x.lineTo(px, py); x.stroke(); }
    prev = [px, py];
  });
  // The scope goes on the card itself: it travels without the page's caveats.
  x.fillStyle = css('--muted'); x.font = font(400, 26);
  x.fillText('Just for fun: a phone estimate using ISO 2631-1:1997’s comfort weightings,', 96, 975);
  x.fillText('not a calibrated or certified measurement · howbumpy.com', 96, 1010);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
}

function download(blob, name) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const fileStem = (sum) => `howbumpy-${(sum.name || sum.mode).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ride'}-${sum.date.slice(0, 10)}`;

function csv(analysis, sum) {
  const { v, h1, h2, used } = analysis.series, fs = analysis.fs, start = analysis.start;
  const lines = ['time_s,vertical_m_s2,horizontal_1_m_s2,horizontal_2_m_s2,used'];
  for (let i = 0; i < v.length; i++) lines.push(`${(start + i / fs).toFixed(3)},${v[i].toFixed(4)},${h1[i].toFixed(4)},${h2[i].toFixed(4)},${used[i]}`);
  return new Blob([`# How Bumpy? (howbumpy.com; just for fun, not a calibrated measurement), ${sum.name || sum.mode}, ${sum.date}, ${fs} Hz. Unweighted; vertical = along gravity; horizontal axes are any two at right angles; used = 1 where counted in the comfort figures (not a gap, pick-up or settling time)\n` + lines.join('\n') + '\n'], { type: 'text/csv' });
}

// ---------- history ----------
function renderHistory() {
  const rides = load(RIDES_KEY, []).filter((r) => r && (r.v === 1 || r.v === 2) && BANDS[r.band]);
  $('history').hidden = !rides.length || !$('rec').hidden;
  $('ridesBtn').hidden = !rides.length; $('ridesCount').textContent = String(rides.length);
  if (sheet && sheet.el.id === 'history' && $('history').hidden) closeSheet();
  const order = $('sortRides').value;
  if (order === 'smooth') rides.sort((a, b) => a.av - b.av);
  else if (order === 'rough') rides.sort((a, b) => b.av - a.av);
  const ul = $('rideList'); ul.textContent = '';
  for (const r of rides) {
    const [em, nm] = MODES[r.mode] || MODES.other;
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button';
    const e = document.createElement('span'); e.className = 'em'; e.textContent = em;
    const mid = document.createElement('span');
    const n = document.createElement('span'); n.className = 'nm'; n.textContent = r.name || nm;
    const sub = document.createElement('span'); sub.className = 'sub';
    sub.textContent = `${new Date(r.date).toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${human(r.duration)} · ${BANDS[r.band].label}`;
    mid.append(n, sub);
    const val = document.createElement('span'); val.className = 'val'; val.textContent = fmt(r.av); val.style.color = bandColour(r.band);
    const u = document.createElement('small'); u.textContent = 'm/s²'; val.appendChild(u);
    b.append(e, mid, val);
    b.addEventListener('click', () => openReport(r));
    li.appendChild(b); ul.appendChild(li);
  }
}

// ---------- sample ride ----------
function sample() {
  const rec = synth(tramProfile(11), { seconds: 240, fs: 60, seed: 5, quat: [0.08, -0.05, 0.38, 0.92], noise: 0.02 });
  const r = analyse(rec, { trimStart: TRIM_START, trimEnd: TRIM_END });
  openReport(summarise(r, { mode: 'tram', name: 'Sample tram ride', sample: true }), r);
}

// ---------- wiring ----------
document.addEventListener('DOMContentLoaded', () => {
  buildGauge();
  setMode(load(PREFS_KEY, {}).mode || 'train');
  $('modes').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('startBtn').addEventListener('click', start);
  $('stopBtn').addEventListener('click', () => (S.recording ? stop('user') : (stopListening(), show('setup'))));
  $('sampleBtn').addEventListener('click', sample);
  $('againBtn').addEventListener('click', () => { $('sensorMsg').hidden = true; show('setup'); });
  $('sortRides').addEventListener('change', renderHistory);
  // Save image, CSV and Delete appear twice: in the wide action row and in the phone Details sheet.
  const on = (sel, fn) => { for (const b of document.querySelectorAll(sel)) b.addEventListener('click', fn); };
  const saveImage = async () => { const s = S.report.sum; download(S.cardBlob || await makeCard(s), `${fileStem(s)}.png`); };
  const send = () => {
    const s = S.report.sum, file = new File([S.cardBlob], `${fileStem(s)}.png`, { type: 'image/png' });
    navigator.share({ files: [file], title: 'How Bumpy?', text: `${BANDS[s.band].label}: ${fmt(s.av)} m/s² (a just-for-fun ride comfort estimate from my phone, howbumpy.com).` }).catch(() => {});
  };
  on('.act-img', saveImage);
  $('sendBtn').addEventListener('click', send);
  $('shareBtn').addEventListener('click', () => (S.cardBlob && canSend(S.cardBlob) ? send() : saveImage()));
  $('moreBtn').addEventListener('click', (e) => openSheet('rMore', e.currentTarget));
  $('ridesBtn').addEventListener('click', (e) => openSheet('history', e.currentTarget));
  $('infoBtn').addEventListener('click', (e) => openSheet('about', e.currentTarget));
  on('.sheet-x', () => closeSheet());
  $('scrim').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet) closeSheet(); });
  document.addEventListener('pointerdown', (e) => { if (e.target.closest('.sheet-head')) dragSheet(e); });
  PHONE.addEventListener('change', () => { closeSheet(false); barHeight(); });
  if (window.ResizeObserver) { const ro = new ResizeObserver(barHeight); for (const b of document.querySelectorAll('.bar')) ro.observe(b); }
  // Delete every saved ride: the first tap asks, a second tap within 4 s does it.
  let delAllArmed = null;
  $('delAllBtn').addEventListener('click', () => {
    const b = $('delAllBtn');
    if (!delAllArmed) {
      b.textContent = 'Tap again to delete them all';
      delAllArmed = setTimeout(() => { delAllArmed = null; b.textContent = 'Delete all saved rides'; }, 4000);
      return;
    }
    clearTimeout(delAllArmed); delAllArmed = null; b.textContent = 'Delete all saved rides';
    try { localStorage.removeItem(RIDES_KEY); } catch { /* storage blocked */ }
    renderHistory();
  });
  on('.act-csv', () => { const { sum, analysis } = S.report; if (analysis) download(csv(analysis, sum), `${fileStem(sum)}.csv`); });
  on('.act-del', () => {
    const id = S.report.sum.id;
    store(RIDES_KEY, load(RIDES_KEY, []).filter((r) => r.id !== id));
    show('setup');
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.recording) lockScreen(S.session); });
  window.addEventListener('resize', () => {
    if (S.report && !$('report').hidden) { const s = S.report.sum; drawChart($('rChart'), s.timeline.map((x) => (x == null ? NaN : x)), { step: s.step, jolts: s.jolts, offset: s.offset }); }
    if (S.live && S.recording) drawChart($('liveChart'), S.live.values, { offset: Math.max(0, (performance.now() - S.startedAt) / 1000 - S.live.values.length) });
  });
  renderHistory();
  barHeight();
});

// Test hook: the page's own state and maths, for ReferenceFiles/howbumpy/page-test.js.
window.__RCM = { S, analyse, LIMITS, stop: () => stop('user') };

// Offline support (sw.js). Optional: the page works without it.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
