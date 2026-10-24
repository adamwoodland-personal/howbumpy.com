// How Bumpy? (howbumpy.com) - the measurement maths, after ISO 2631-1:1997 (whole-body vibration).
// No DOM, so the same file runs in the page and under Node for ReferenceFiles/howbumpy/ tests.
//
// A recording is the phone's raw devicemotion samples. analyse() resamples them onto an even grid,
// splits the motion into up-and-down (along gravity) and horizontal parts, applies the ISO frequency
// weightings exactly in the frequency domain (FFT x the analogue weighting), and reports:
//   av    total vibration value, sqrt(awz^2 + awx^2 + awy^2), k = 1 (seated comfort), m/s^2
//   VDV   vibration dose value, (integral of a^4 dt)^(1/4), for jolty rides, m/s^1.75
//   MSDV  motion sickness dose value, vertical, Wf weighting, m/s^1.5; ISO's estimate of the share
//         of people who may vomit is MSDV / 3 percent (Km = 1/3, mixed adult population)
// Spans where the page slept (sample gaps) or the phone was picked up (fast tilting) are left out.

export const G = 9.80665;

// Frequency-weighting parameters (ISO 2631-1:1997, Annex A). Infinity leaves a section out.
export const WEIGHTINGS = {
  Wk: { f1: 0.4, f2: 100, f3: 12.5, f4: 12.5, Q4: 0.63, f5: 2.37, Q5: 0.91, f6: 3.35, Q6: 0.91 }, // vertical, comfort
  Wd: { f1: 0.4, f2: 100, f3: 2.0, f4: 2.0, Q4: 0.63, f5: Infinity, Q5: 1, f6: Infinity, Q6: 1 },   // horizontal, comfort
  Wf: { f1: 0.08, f2: 0.63, f3: Infinity, f4: 0.25, Q4: 0.86, f5: 0.0625, Q5: 0.8, f6: 0.1, Q6: 0.8 }, // vertical, motion sickness
};
// Unweighted band used only to find jolts: 0.5-20 Hz, so tilt drift and sensor fuzz don't count.
const JOLT = { f1: 0.5, f2: 20, f3: Infinity, f4: Infinity, Q4: 1, f5: Infinity, Q5: 1, f6: Infinity, Q6: 1 };

// ISO 2631-1 Annex C comfort reactions. The ranges overlap on purpose (people differ); `cut` is where
// this page switches its single label: the geometric middle of each overlap.
export const BANDS = [
  { key: 'not', label: 'Not uncomfortable', range: [0, 0.315], cut: 0.315 },
  { key: 'little', label: 'A little uncomfortable', range: [0.315, 0.63], cut: Math.sqrt(0.5 * 0.63) },
  { key: 'fairly', label: 'Fairly uncomfortable', range: [0.5, 1.0], cut: Math.sqrt(0.8 * 1.0) },
  { key: 'unc', label: 'Uncomfortable', range: [0.8, 1.6], cut: Math.sqrt(1.25 * 1.6) },
  { key: 'very', label: 'Very uncomfortable', range: [1.25, 2.5], cut: Math.sqrt(2.0 * 2.5) },
  { key: 'extreme', label: 'Extremely uncomfortable', range: [2.0, Infinity], cut: Infinity },
];
export function bandOf(av) {
  if (!Number.isFinite(av) || av < 0) return -1; // no band: never let a bad number read as "extremely"
  for (let i = 0; i < BANDS.length; i++) if (av < BANDS[i].cut) return i;
  return BANDS.length - 1;
}

// ---------- weighting responses ----------
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const quad = (w, c1, c2) => [1 - c2 * w * w, c1 * w]; // 1 + c1 s + c2 s^2 at s = jw
const inv = (f) => (f === Infinity ? 0 : 1 / (2 * Math.PI * f));

// Complex response of a weighting at frequency f (Hz): high-pass x low-pass x a-v transition x upward step.
export function response(W, f) {
  if (f <= 0) return [0, 0];
  const w = 2 * Math.PI * f;
  const r1 = (2 * Math.PI * W.f1) / w;
  let H = cdiv([1, 0], [1 - r1 * r1, -Math.SQRT2 * r1]); // s^2 / (s^2 + sqrt2 w1 s + w1^2)
  const i2 = inv(W.f2), i3 = inv(W.f3), i4 = inv(W.f4), i5 = inv(W.f5), i6 = inv(W.f6);
  H = cdiv(H, quad(w, Math.SQRT2 * i2, i2 * i2)); // w2^2 / (s^2 + sqrt2 w2 s + w2^2)
  H = cmul(H, cdiv([1, w * i3], quad(w, i4 / W.Q4, i4 * i4))); // (1 + s/w3) / (1 + s/(Q4 w4) + s^2/w4^2)
  if (i5 && i6) {
    H = cmul(H, cdiv(quad(w, i5 / W.Q5, i5 * i5), quad(w, i6 / W.Q6, i6 * i6)));
    const k = (i6 / i5) ** 2; // (f5/f6)^2
    H = [H[0] * k, H[1] * k];
  }
  return H;
}
export const gain = (W, f) => Math.hypot(...response(W, f));

// ---------- FFT (radix 2, in place) ----------
const twiddles = new Map();
function table(n) {
  let t = twiddles.get(n);
  if (!t) {
    t = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) { t.c[k] = Math.cos((2 * Math.PI * k) / n); t.s[k] = Math.sin((2 * Math.PI * k) / n); }
    twiddles.set(n, t);
  }
  return t;
}
export function fft(re, im, inverse = false) {
  const n = re.length, { c, s } = table(n), sign = inverse ? 1 : -1;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = c[k * step], wi = sign * s[k * step], a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// Spectrum of up to two real channels packed as one complex signal (a + jb), zero-padded.
function spectrum(a, b, n2) {
  const re = new Float64Array(n2), im = new Float64Array(n2);
  re.set(a); if (b) im.set(b);
  fft(re, im);
  return { re, im, n2 };
}
// Apply a real filter to a packed spectrum and return the two filtered channels (first n samples).
function filtered(spec, W, fs, n) {
  const { n2 } = spec, re = new Float64Array(spec.re), im = new Float64Array(spec.im);
  for (let k = 0; k <= n2 / 2; k++) {
    const H = response(W, (k * fs) / n2);
    let x = re[k], y = im[k];
    re[k] = x * H[0] - y * H[1]; im[k] = x * H[1] + y * H[0];
    if (k > 0 && k < n2 / 2) { // mirror bin gets the conjugate, so the filter stays real
      const m = n2 - k; x = re[m]; y = im[m];
      re[m] = x * H[0] + y * H[1]; im[m] = y * H[0] - x * H[1];
    }
  }
  fft(re, im, true);
  return [re.subarray(0, n), im.subarray(0, n)];
}

// ---------- helpers ----------
// Zero-phase one-pole low-pass (forward then backward), cut-off fc Hz.
function smooth(x, fs, fc) {
  const n = x.length, y = new Float64Array(n), a = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  if (!n) return y;
  let v = x[0];
  for (let i = 0; i < n; i++) { v += a * (x[i] - v); y[i] = v; }
  v = y[n - 1];
  for (let i = n - 1; i >= 0; i--) { v += a * (y[i] - v); y[i] = v; }
  return y;
}
const median = (arr) => { const s = Float64Array.from(arr).sort(); return s.length ? s[s.length >> 1] : NaN; };

// The raw record: parallel arrays, one entry per devicemotion event.
//   t: ms (any origin), ix/iy/iz: accelerationIncludingGravity, lx/ly/lz: acceleration (NaN where a
//   component was missing). Every component is nullable in the W3C API, so analyse() checks them all.
//   Rotation rate is not recorded: pick-ups are found from the gravity direction instead, which does
//   not depend on how a browser maps rotationRate's alpha/beta/gamma to the device axes.
export function emptyRecord() {
  return { t: [], ix: [], iy: [], iz: [], lx: [], ly: [], lz: [] };
}
export function slice(rec, from, to) {
  const out = {};
  for (const k of Object.keys(rec)) out[k] = rec[k].slice(from, to);
  return out;
}

// Filter settling (seconds) left out at the start of every continuous stretch of readings: the weighting
// filters start from rest at each stretch, and their first moments are not the ride. Measured by
// ReferenceFiles/howbumpy/settle-calibrate.mjs (abruptly started sines, sine and cosine phase):
// Wk/Wd are within 1% after 1 s and 0.15% after 2 s; Wf within 1% after 6 s and 0.33% after 10 s.
// 'comfort' covers Wk, Wd and the jolt band, 'sickness' covers Wf.
export const SETTLE = { comfort: 2, sickness: 10 };
// Skipped grid slots inside a run of readings are interpolated only up to this many; a longer hole is a gap.
const MAX_FILL = 3;

// ---------- the analysis ----------
// opts: trimStart / trimEnd (s) drop the ends; gap (s) is the largest step still treated as continuous;
// live: true skips the motion-sickness, VDV and timeline work (for the once-a-second readout).
// Returns null when there is too little to work with, { error } when the readings make no sense.
export function analyse(rec, opts = {}) {
  const { trimStart = 0, trimEnd = 0, gap = 0.5, live = false, tiltLimit = 30, settle = SETTLE } = opts;
  const N0 = rec.t.length;
  if (N0 < 10) return null;

  // A reading counts only when its time and all three including-gravity components are numbers.
  // Linear acceleration is used only when all three of its components are present in nearly every
  // reading; then readings without it are dropped as well, so no NaN ever reaches the filters.
  const fin = (k, i) => Number.isFinite(rec[k][i]);
  const inclOk = (i) => Number.isFinite(rec.t[i]) && fin('ix', i) && fin('iy', i) && fin('iz', i);
  const linOk = (i) => fin('lx', i) && fin('ly', i) && fin('lz', i);
  let nIncl = 0, nLin = 0;
  for (let i = 0; i < N0; i++) if (inclOk(i)) { nIncl++; if (linOk(i)) nLin++; }
  const useLinear = nIncl > 0 && nLin > 0.9 * nIncl;
  const keep = [];
  for (let i = 0; i < N0; i++) if (inclOk(i) && (!useLinear || linOk(i))) keep.push(i);
  const N = keep.length, dropped = N0 - N;
  if (N < 10) return null;
  const keys = useLinear ? ['ix', 'iy', 'iz', 'lx', 'ly', 'lz'] : ['ix', 'iy', 'iz'];
  const R = {}; for (const k of keys) R[k] = keep.map((i) => rec[k][i]);
  const t0 = rec.t[keep[0]], ts = new Float64Array(N);
  for (let i = 0; i < N; i++) ts[i] = (rec.t[keep[i]] - t0) / 1000;
  const dts = [];
  for (let i = 1; i < N; i++) { const d = ts[i] - ts[i - 1]; if (d > 0 && d < gap) dts.push(d); }
  if (dts.length < 5) return null;
  const fs = Math.min(200, Math.max(5, Math.round(1 / median(dts))));
  const start = trimStart, end = ts[N - 1] - trimEnd;
  const M = Math.floor((end - start) * fs);
  if (M < fs * 2) return null;

  // Sensor sanity, from the raw readings: a ceiling that readings keep hitting (a sensor at the end
  // of its range; fixed thresholds miss ±2 g parts) and, below, the size of gravity itself.
  let peak = 0;
  for (const k of ['ix', 'iy', 'iz']) for (const x of R[k]) peak = Math.max(peak, Math.abs(x));
  let atPeak = 0;
  for (let i = 0; i < N; i++) if (Math.max(Math.abs(R.ix[i]), Math.abs(R.iy[i]), Math.abs(R.iz[i])) >= peak - 1e-6) atPeak++;
  const clipped = peak > 15 && atPeak >= 3 ? { level: peak, count: atPeak } : null;

  // Put the readings on an even grid. Phones take readings at a steady rate but stamp them when they
  // are delivered, so each reading goes into its nearest slot rather than being interpolated: linear
  // interpolation between off-grid readings blurs fast shaking (by about a quarter at 15 Hz). Up to
  // MAX_FILL skipped slots inside a run are interpolated; anything longer, and every slot outside a
  // run, is a gap.
  const ch = {}; for (const k of keys) ch[k] = new Float64Array(M);
  const gapMask = new Uint8Array(M).fill(1);
  for (let i = 0; i < N;) {
    let e = i + 1;
    while (e < N && ts[e] - ts[e - 1] < gap) e++; // one continuous run: readings i .. e-1
    const base = Math.round((ts[i] - start) * fs);
    let prevSlot = -Infinity, prev = -1;
    for (let s = i; s < e; s++) {
      let slot = base + Math.round((ts[s] - ts[i]) * fs);
      if (slot <= prevSlot) slot = prevSlot + 1; // a burst of deliveries: keep them in order
      if (slot >= 0 && slot < M) {
        for (const k of keys) ch[k][slot] = R[k][s];
        gapMask[slot] = 0;
        if (prev >= 0 && slot - prevSlot - 1 <= MAX_FILL) {
          for (let q = Math.max(0, prevSlot + 1); q < slot; q++) {
            const u = (q - prevSlot) / (slot - prevSlot);
            for (const k of keys) ch[k][q] = R[k][prev] + u * (R[k][s] - R[k][prev]);
            gapMask[q] = 0;
          }
        }
      }
      prevSlot = slot; prev = s;
    }
    i = e;
  }
  // Fill gap samples with the last good value so the smoothing below doesn't see zeros.
  for (let i = 0; i < M; i++) if (gapMask[i]) for (const k of keys) ch[k][i] = i ? ch[k][i - 1] : 0;

  // Gravity. With the OS's linear acceleration, gravity = including-gravity minus linear (sensor-fused,
  // so it follows tilts quickly and ignores braking); without it, a smoothed including-gravity vector.
  const gx = new Float64Array(M), gy = new Float64Array(M), gz = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    gx[i] = useLinear ? ch.ix[i] - ch.lx[i] : ch.ix[i];
    gy[i] = useLinear ? ch.iy[i] - ch.ly[i] : ch.iy[i];
    gz[i] = useLinear ? ch.iz[i] - ch.lz[i] : ch.iz[i];
  }
  const gmag = [];
  for (let i = 0; i < M; i++) if (!gapMask[i]) gmag.push(Math.hypot(gx[i], gy[i], gz[i]));
  const gravity = median(gmag);
  const fcG = useLinear ? 0.5 : 0.05;
  const sgx = smooth(gx, fs, fcG), sgy = smooth(gy, fs, fcG), sgz = smooth(gz, fs, fcG);
  const ux = new Float64Array(M), uy = new Float64Array(M), uz = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const m = Math.hypot(sgx[i], sgy[i], sgz[i]) || 1;
    ux[i] = sgx[i] / m; uy[i] = sgy[i] / m; uz[i] = sgz[i] / m;
  }

  // "Vertical" is along gravity, not along the seat or the body: in a reclined seat, or a vehicle
  // banking or pitching, the split between up-and-down and horizontal is only approximate.
  // Horizontal basis: the device axis least aligned with gravity, made square to it at each sample.
  const mx = Math.abs(median(ux)), my = Math.abs(median(uy)), mz = Math.abs(median(uz));
  const ref = mx <= my && mx <= mz ? [1, 0, 0] : my <= mz ? [0, 1, 0] : [0, 0, 1];
  const v = new Float64Array(M), h1 = new Float64Array(M), h2 = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const g = [ux[i], uy[i], uz[i]];
    const d = useLinear ? [ch.lx[i], ch.ly[i], ch.lz[i]] : [ch.ix[i], ch.iy[i], ch.iz[i]];
    const dv = d[0] * g[0] + d[1] * g[1] + d[2] * g[2];
    v[i] = dv; // without linear data this still holds gravity; each stretch's mean is removed below
    const hx = d[0] - dv * g[0], hy = d[1] - dv * g[1], hz = d[2] - dv * g[2];
    const rd = ref[0] * g[0] + ref[1] * g[1] + ref[2] * g[2];
    let e1 = [ref[0] - rd * g[0], ref[1] - rd * g[1], ref[2] - rd * g[2]];
    const em = Math.hypot(...e1) || 1; e1 = [e1[0] / em, e1[1] / em, e1[2] / em];
    const e2 = [g[1] * e1[2] - g[2] * e1[1], g[2] * e1[0] - g[0] * e1[2], g[0] * e1[1] - g[1] * e1[0]];
    h1[i] = hx * e1[0] + hy * e1[1] + hz * e1[2];
    h2[i] = hx * e2[0] + hy * e2[1] + hz * e2[2];
  }

  // Phone handling: the gravity direction swinging faster than tiltLimit deg/s. That is the phone
  // tilting; the vehicle turning is rotation about gravity and doesn't move it. Without the OS's
  // gravity, the smoothed including-gravity vector also swings under hard braking, so allow twice as
  // much. Each moment found is widened by 1.5 s either side.
  const fcT = useLinear ? 3 : 2;
  const fx = smooth(gx, fs, fcT), fy = smooth(gy, fs, fcT), fz = smooth(gz, fs, fcT);
  const lag = Math.max(1, Math.round(fs / 4)), tilt = new Float64Array(M);
  for (let i = lag; i < M; i++) {
    if (gapMask[i] || gapMask[i - lag]) continue;
    const a = [fx[i], fy[i], fz[i]], b = [fx[i - lag], fy[i - lag], fz[i - lag]];
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1);
    tilt[i] = (Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI) * (fs / lag);
  }
  const tiltS = smooth(tilt, fs, 3);
  const limit = useLinear ? tiltLimit : tiltLimit * 2;
  const handled = new Uint8Array(M), widen = Math.round(1.5 * fs);
  for (let i = 0, next = 0; i < M; i++) {
    if (tiltS[i] > limit && !gapMask[i]) {
      for (let k = Math.max(next, i - widen); k <= Math.min(M - 1, i + widen); k++) handled[k] = 1;
      next = i + widen + 1;
    }
  }
  const valid = new Uint8Array(M);
  let nValid = 0, nGap = 0, nHandled = 0;
  for (let i = 0; i < M; i++) {
    if (gapMask[i]) nGap++; else if (handled[i]) nHandled++;
    if (!gapMask[i] && !handled[i]) { valid[i] = 1; nValid++; }
  }
  const base = { fs, M, start, tg0: t0 + start * 1000, useLinear, dropped, gravity, clipped,
    excludedGap: nGap / fs, excludedHandled: nHandled / fs, handledNow: !!handled[M - 1] };

  // Weight each continuous stretch on its own, so nothing rings across a gap or a pick-up into the
  // readings either side, and leave out each stretch's settling time. `use` marks the samples counted
  // in the comfort figures and jolts; `useF` those counted in the motion-sickness dose.
  const vz = new Float64Array(M), hx = new Float64Array(M), hy = new Float64Array(M);
  const jv = new Float64Array(M), jh1 = new Float64Array(M), jh2 = new Float64Array(M), vf = new Float64Array(M);
  const use = new Uint8Array(M), useF = new Uint8Array(M);
  const gC = Math.round(settle.comfort * fs), gF = Math.round(settle.sickness * fs);
  const pad = Math.round((live ? 10 : 60) * fs);
  for (let a = 0; a < M;) {
    if (!valid[a]) { a++; continue; }
    let b = a; while (b < M && valid[b]) b++;
    const len = b - a;
    if (len > gC) {
      const seg = (x) => { let m = 0; for (let i = a; i < b; i++) m += x[i]; m /= len; const s = new Float64Array(len); for (let i = 0; i < len; i++) s[i] = x[a + i] - m; return s; };
      const n2 = pow2(len + pad);
      const sv = spectrum(seg(v), null, n2), sh = spectrum(seg(h1), seg(h2), n2);
      const [z] = filtered(sv, WEIGHTINGS.Wk, fs, len); vz.set(z, a);
      const [x1, x2] = filtered(sh, WEIGHTINGS.Wd, fs, len); hx.set(x1, a); hy.set(x2, a);
      const [j0] = filtered(sv, JOLT, fs, len); jv.set(j0, a);
      const [j1, j2] = filtered(sh, JOLT, fs, len); jh1.set(j1, a); jh2.set(j2, a);
      for (let i = a + gC; i < b; i++) use[i] = 1;
      if (!live && len > gF) {
        const [f] = filtered(sv, WEIGHTINGS.Wf, fs, len); vf.set(f, a);
        for (let i = a + gF; i < b; i++) useF[i] = 1;
      }
    }
    a = b;
  }
  let nUse = 0, nUseF = 0;
  for (let i = 0; i < M; i++) { nUse += use[i]; nUseF += useF[i]; }
  base.excludedSettle = (nValid - nUse) / fs;
  if (nUse < fs) return { ...base, nValid, nUse, duration: nUse / fs };

  let sz = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < M; i++) if (use[i]) { sz += vz[i] * vz[i]; s1 += hx[i] * hx[i]; s2 += hy[i] * hy[i]; }
  const awz = Math.sqrt(sz / nUse), awx = Math.sqrt(s1 / nUse), awy = Math.sqrt(s2 / nUse);
  const awh = Math.hypot(awx, awy), av = Math.hypot(awz, awh);
  if (![awz, awh, av].every(Number.isFinite)) return { ...base, error: 'The motion readings could not be turned into a result.' };

  // Per-second energy (for the timeline and the live readout) and jolts.
  const secs = Math.ceil(M / fs);
  const secE = new Float64Array(secs), secN = new Float64Array(secs), secJ = new Float64Array(secs), secJi = new Int32Array(secs).fill(-1);
  const jolt = new Float64Array(M), e = new Float64Array(M).fill(NaN);
  for (let i = 0; i < M; i++) {
    if (!use[i]) continue;
    const s = Math.floor(i / fs);
    e[i] = vz[i] * vz[i] + hx[i] * hx[i] + hy[i] * hy[i];
    secE[s] += e[i]; secN[s]++;
    jolt[i] = Math.sqrt(jv[i] * jv[i] + jh1[i] * jh1[i] + jh2[i] * jh2[i]);
    if (jolt[i] > secJ[s]) { secJ[s] = jolt[i]; secJi[s] = i; }
  }
  const out = { ...base, nValid, nUse, duration: nUse / fs, span: M / fs, av, awz, awh, band: bandOf(av),
    secE, secN, secJ, e, jolt }; // e: per-sample weighted energy (NaN = not counted)
  // Last 5 seconds (live gauge).
  { let en = 0, n = 0; for (let i = Math.max(0, M - 5 * fs); i < M; i++) if (use[i]) { en += e[i]; n++; }
    out.last5 = n > fs ? Math.sqrt(en / n) : null; }
  if (live) return out;

  // The 5-second value for each second (the window ending with that second), and the roughest
  // 5 seconds. A window counts only when at least 90% of it was usable.
  const timeline = new Float32Array(secs).fill(NaN);
  let worst = 0, worstEnd = -1;
  for (let s = 4; s < secs; s++) {
    let en = 0, n = 0;
    for (let k = s - 4; k <= s; k++) { en += secE[k]; n += secN[k]; }
    if (n >= 4.5 * fs) { timeline[s] = Math.sqrt(en / n); if (timeline[s] > worst) { worst = timeline[s]; worstEnd = s; } }
  }
  out.timeline = timeline; out.worst5 = worstEnd >= 0 ? worst : null;
  out.worst5From = worstEnd >= 0 ? start + worstEnd - 4 : null; out.worst5To = worstEnd >= 0 ? start + worstEnd + 1 : null;

  // Vibration dose values (over the usable time) and the crest factor of each axis.
  let qz = 0, q1 = 0, q2 = 0, pz = 0, p1 = 0, p2 = 0;
  for (let i = 0; i < M; i++) if (use[i]) {
    qz += vz[i] ** 4; q1 += hx[i] ** 4; q2 += hy[i] ** 4;
    pz = Math.max(pz, Math.abs(vz[i])); p1 = Math.max(p1, Math.abs(hx[i])); p2 = Math.max(p2, Math.abs(hy[i]));
  }
  const vdvz = (qz / fs) ** 0.25, vdv1 = (q1 / fs) ** 0.25, vdv2 = (q2 / fs) ** 0.25;
  out.vdvz = vdvz; out.vdv = (vdvz ** 4 + vdv1 ** 4 + vdv2 ** 4) ** 0.25; out.doseSeconds = nUse / fs;
  const crests = [['up and down', pz, awz], ['horizontal', p1, awx], ['horizontal', p2, awy]]
    .filter(([, , rms]) => rms > 0.005).map(([axis, p, rms]) => ({ axis, value: p / rms }));
  const top = crests.sort((a, b) => b.value - a.value)[0];
  out.crest = top ? top.value : 0; out.crestAxis = top ? top.axis : null;

  // Motion sickness (vertical, Wf), over the time usable for it (its filter settles slowly).
  let sf = 0; for (let i = 0; i < M; i++) if (useF[i]) sf += vf[i] * vf[i];
  out.msdvSeconds = nUseF / fs;
  out.msdv = nUseF ? Math.sqrt(sf / fs) : null; out.msi = out.msdv == null ? null : out.msdv / 3;

  // Biggest jolts: the largest peaks at least 5 s apart.
  const order = [...secJ.keys()].filter((s) => secJi[s] >= 0).sort((a, b) => secJ[b] - secJ[a]);
  const jolts = [];
  for (const s of order) {
    if (jolts.length >= 5 || secJ[s] < 0.3) break;
    if (jolts.some((p) => Math.abs(p.s - s) < 5)) continue;
    const i = secJi[s];
    jolts.push({ s, t: start + i / fs, g: secJ[s] / G, vertical: Math.abs(jv[i]) >= Math.hypot(jh1[i], jh2[i]) });
  }
  out.jolts = jolts.sort((a, b) => a.t - b.t).map(({ s, ...p }) => p);
  out.peakJolt = jolts.length ? Math.max(...jolts.map((p) => p.g)) : (Math.max(0, ...secJ) / G);

  // The resampled signals, for the CSV export.
  out.series = { v, h1, h2, used: use };
  return out;
}

// ---------- synthetic rides (the sample ride, and the tests) ----------
export function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Rotation matrix from a unit quaternion [x, y, z, w]; R maps device axes to world axes.
function rotm([x, y, z, w]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
function quatAxis(ax, deg) {
  const m = Math.hypot(...ax), h = (deg * Math.PI) / 360, s = Math.sin(h) / m;
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)];
}
function qmul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
// World-frame (east, north, up) dynamic acceleration for a tram-like ride: track roughness, sway,
// rail-joint knocks, a set of points, and pulling away and braking at stops.
export function tramProfile(seed = 7) {
  const r = rng(seed), tones = [];
  for (let k = 0; k < 14; k++) tones.push({ axis: k % 3, f: 0.7 + r() * 14, a: 0.06 + r() * 0.12, p: r() * 6.283 });
  const knocks = []; for (let t = 4; t < 3600; t += 3 + r() * 9) knocks.push({ t, a: 0.6 + r() * 1.8 });
  return (t) => {
    let e = 0, n = 0, u = 0;
    for (const s of tones) { const x = s.a * Math.sin(6.283 * s.f * t + s.p); if (s.axis === 0) e += x * 1.6; else if (s.axis === 1) n += x; else u += x * 1.5; }
    const cyc = t % 90; // 90 s between stops: pull away, cruise, brake, dwell
    n += cyc < 12 ? 1.1 * Math.sin((Math.PI * cyc) / 12) : cyc > 60 && cyc < 74 ? -1.2 * Math.sin((Math.PI * (cyc - 60)) / 14) : 0;
    e += 0.35 * Math.sin(6.283 * 0.9 * t) * (cyc > 20 && cyc < 55 ? 1 : 0.3);
    for (const k of knocks) { const d = t - k.t; if (d >= 0 && d < 0.06) u += k.a * Math.sin((Math.PI * d) / 0.06); if (d < 0) break; }
    const pts = t % 300 - 150; if (pts >= 0 && pts < 0.25) e += 3.2 * Math.sin((Math.PI * pts) / 0.25); // the points
    return [e, n, u];
  };
}
// Build a raw record from a world-frame profile, as a phone would report it.
// opts: seconds, fs, seed, quat (device orientation), flip (opposite sign convention), linear,
//       jitter (s, uniform +/-), gaps: [[from, to] s], noise (m/s^2),
//       handle: { at, dur, noise } - a 90 degree pick-up with hand shake of `noise` m/s^2 (default 1.5).
export function synth(profile, opts = {}) {
  const { seconds = 120, fs = 60, seed = 3, quat = [0, 0, 0, 1], flip = false, linear = true, jitter = 0, gaps = [], handle = null, noise = 0.02 } = opts;
  const r = rng(seed), rec = emptyRecord(), sgn = flip ? -1 : 1;
  const nrm = () => (r() + r() + r() - 1.5) * 2 * noise;
  for (let i = 0; i < seconds * fs; i++) {
    const tt = i / fs + (jitter ? (r() * 2 - 1) * jitter : 0);
    if (gaps.some(([a, b]) => tt >= a && tt < b)) continue;
    let q = quat, extra = 0;
    if (handle) {
      const u = Math.min(1, Math.max(0, (tt - handle.at) / handle.dur));
      q = qmul(quat, quatAxis([1, 0, 0], 90 * u));
      if (u > 0 && u < 1) extra = handle.noise ?? 1.5;
    }
    const R = rotm(q), dw = profile(tt), fw = [dw[0], dw[1], dw[2] + G];
    const toDev = (w) => [0, 1, 2].map((k) => R[0][k] * w[0] + R[1][k] * w[1] + R[2][k] * w[2]); // R^T w
    const dl = toDev(dw), di = toDev(fw);
    const nz = [nrm() + extra * (r() - 0.5), nrm() + extra * (r() - 0.5), nrm() + extra * (r() - 0.5)];
    rec.t.push(tt * 1000);
    rec.ix.push(sgn * (di[0] + nz[0])); rec.iy.push(sgn * (di[1] + nz[1])); rec.iz.push(sgn * (di[2] + nz[2]));
    rec.lx.push(linear ? sgn * (dl[0] + nz[0]) : NaN); rec.ly.push(linear ? sgn * (dl[1] + nz[1]) : NaN); rec.lz.push(linear ? sgn * (dl[2] + nz[2]) : NaN);
  }
  return rec;
}
