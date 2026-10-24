// Service worker for howbumpy.com (same pattern as quickresponse.now / orrery.live).
//
// Strategy:
//  - Code and navigations: NETWORK-FIRST. Online visitors always get the freshly
//    deployed files; the cached copy only serves when the network is
//    unavailable. All the maths runs in the page, so once cached it measures
//    with no signal at all: tunnels, ferries, flight mode.
//  - Images/icons: CACHE-FIRST.
//  - Bump CACHE on deploys that change any precached file (activate deletes
//    every other cache version).
const CACHE = 'hb-v2';
const CORE = [
	'/',
	'/index.html',
	'/style.css',
	'/app.js',
	'/comfort.js',
	'/favicon.svg',
	'/manifest.json',
	'/icon-192.png'
];

self.addEventListener('install', (e) => {
	e.waitUntil(
		caches.open(CACHE)
			.then((c) => c.addAll(CORE))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

	if (req.destination === 'image') {
		e.respondWith(
			caches.open(CACHE).then(async (c) => {
				const hit = await c.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok) e.waitUntil(c.put(req, res.clone()));
				return res;
			})
		);
		return;
	}

	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) {
					const copy = res.clone();
					e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
				}
				return res;
			})
			.catch(async () => {
				const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
				if (hit) return hit;
				if (req.mode === 'navigate') {
					const shell = await caches.match('/index.html');
					if (shell) return shell;
				}
				return Response.error();
			})
	);
});
