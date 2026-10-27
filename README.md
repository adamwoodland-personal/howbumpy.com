# How Bumpy? — howbumpy.com

**Live: <https://howbumpy.com/>**

How bumpy was your train, tram, bus, car, bike, plane or boat? Fix your phone in place (in a phone
holder or mount, a seat-back pocket, or clipped to the handlebars), tap Start, and find out. A free, **just-for-fun** ride comfort meter
that runs entirely in the browser.

> It uses the comfort weightings from ISO 2631-1:1997, but a phone isn't a calibrated instrument
> and this isn't a certified measurement. It is best for comparing your own rides, with the same
> phone in the same spot. Never use it for safety, health or work-exposure decisions.

## What it does

- **Live gauge** while you ride: comfort over the last few seconds, the ride so far and the biggest
  jolt, with a two-minute chart.
- **Report** at the end: a verdict in the standard's own comfort descriptions, the overall weighted
  vibration in m/s², up-and-down vs sideways, the roughest 5 seconds, the five biggest jolts, a
  timeline of the ride and a seasickness dose.
- **Share** the result as an image card, download the resampled signals as CSV, and keep up to 60
  rides in the browser to compare, smoothest or roughest first.
- **Works offline** once opened (a PWA), so it keeps going in tunnels, at sea and in flight mode.
- A simulated **sample tram ride** for devices without a motion sensor.

## How it works

`comfort.js` holds all the maths and has no DOM, so it runs in the page and under Node:

1. The browser's `devicemotion` readings are placed on an even grid at the phone's own rate.
2. Gravity is tracked, so the shaking splits into up-and-down (along gravity) and horizontal,
   whichever way the phone lies.
3. Each continuous stretch of readings is weighted in the frequency domain with ISO 2631-1's Wk
   (vertical), Wd (horizontal) and Wf (motion sickness) weightings, with a short settling time
   left out after every break.
4. Moments when the phone is picked up are detected from how fast the gravity direction swings,
   and left out.

`app.js` runs the sensor, the live gauge, the report, saved rides, the share card and the CSV.
`sw.js` caches the app for offline use.

## Privacy

Everything is worked out on your phone. Nothing is uploaded, no location is used, and there are no
cookies or analytics. Saved rides stay in the browser's local storage.

## Running it locally

There is no build step. Serve the folder over HTTP (ES modules don't load from `file://`) and open
it; the motion sensor needs HTTPS on a real phone, but the sample ride works anywhere.

## Licence

MIT, see [LICENSE](LICENSE). Made by [Adam Woodland](https://adamwoodland.com/); more tools at
[Adam's Arcade](https://games.adamwoodland.com/).

Design, code and content developed with the assistance of AI (Anthropic Claude).
