// How Bumpy? (howbumpy.com) - works out a finished ride off the page's main thread, so the screen keeps
// responding, and shows progress, while a slow phone works through a long ride. app.js runs the same
// analyse() in the page instead if this worker can't start.
import { analyse } from './comfort.js';

self.onmessage = (e) => {
  const { rec, opts } = e.data;
  let shown = -1;
  const r = analyse(rec, { ...opts, progress: (p) => { const pc = Math.floor(p * 100); if (pc > shown) { shown = pc; self.postMessage({ progress: p }); } } });
  // Hand the big arrays back without copying them.
  const buffers = new Set();
  if (r) for (const x of [r.secE, r.secN, r.secJ, r.e, r.jolt, r.timeline, ...(r.series ? Object.values(r.series) : [])]) if (x && x.buffer) buffers.add(x.buffer);
  self.postMessage({ result: r }, [...buffers]);
};
