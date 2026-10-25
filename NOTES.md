# Notes for Billy

## What this is

`mipmap-arcade` is an arcade racer called LodZero. The whole thing is an engine-free HTML5 canvas program: no game engine, no graphics library, zero dependencies, no build step. All logic is in `engine.js` (works in the browser and in Node), the page glue is in `app.js`, and the look is in `styles.css`.

Live: https://aariv.me/mipmap-arcade/ (served by GitHub Pages from `main`).

## Hack Club Mipmap rules, read on 2026-10-25 from https://mipmap.hackclub.com/

- The program is for ages 13 to 18. The challenge is a video game made without a game engine.
- Tier Quebec is custom 2D games without a real engine, for example the JavaScript canvas. Tier Romeo is low level graphics libraries. Tier Sierra is 3D games that use Vulkan, bare metal, or a software renderer with no GPU library.
- Hours come from Hackatime.
- The AI rule, as written on the page: you may use as much or as little AI as you like, but time spent AI coding counts for about a third less than time spent coding by hand, and simply retyping the code of an entire project that an LLM produced is not allowed.

What that means here:

- This code was written by an AI agent. It is not Aariv's hand-written work, and no Hackatime hours exist for it.
- So this repo is a disclosed AI-assisted reference build. It is not a Mipmap entry, and it should not be submitted to Mipmap as Aariv's own project. I did not submit it anywhere.
- If Aariv wants a real Mipmap entry, the honest route is to write his own engine-free game by hand, using this repo only to learn from (the README and `engine.js` explain mip pyramids, the Jacobian and trilinear sampling clearly). I am not sure which tier a canvas software rasterizer with a pseudo 3D ground plane would count as. Ask in the `#mipmap` Slack channel before assuming Quebec or Sierra.
- This is the same stance the station notes already record for Hack Club ASIC: read a program's own rules before building for it.

## What was verified

- `node --test` runs the engine tests and the DOM smoke tests. Everything passes. The counts are in the final report of the session that built this, and you can re-run it any time.
- `hark_honesty_and_defect_harness.py --audit` reported 0 violations. The planted defect runner (`--planted-defects ... --count 25`) caught every injected mutation. The audit flag and the planted defect flag are two separate commands.
- The page was loaded in a real Chrome (through the DevTools MCP). The game boots, the pace car drives, a keypress takes over, the sampling modes change the picture, and there were no console errors. Point sampling visibly shimmers and noises up the distant ground. Trilinear does not.
- A mutation sweep of my own (every operator the harness uses, not only the first 25) was run against `engine.js` and `app.js`. See "Mutation testing" below.

## What was not verified

- No human has played it. There was no human playtesting, only automated tests and one agent looking at screenshots.
- No test on a real phone. The touch buttons are wired and covered by the stand-in DOM tests, but real touch hardware was not used.
- WebAudio was exercised only against a stand-in object. The sound has not been heard by a person.
- Performance numbers: a frame takes a few milliseconds in headless Chrome on this Mac at 480 by 270. A weaker device was not measured.
- Accessibility was checked by reading the markup and with automated rules, not with a screen reader.

## Design decisions worth knowing

- The "3D" is floor casting: every pixel under the horizon is mapped onto the ground plane, which makes the texture footprint exact and makes the filter choice visible. Sprites (car, pylons, cells, gates) are drawn on top with a small projection helper.
- The track is a smooth radius function sampled into a Catmull-Rom spline, so it never crosses itself. A distance field baked from the track makes road edges crisp from a tiny texture.
- Tires cannot turn the car faster than grip allows, unless the player is deliberately drifting. I found this while testing, because without the cap, full lock at speed spun the car in place and drift could never charge.
- Ghosts are stored as inputs, not positions. Replaying the same inputs through the same fixed step gives the same run, collisions included. A test replays a 40 second mixed run and compares a hash of the final state.
- Every colour and font is a CSS custom property. `app.js` reads those properties at runtime for the canvas. No em dashes, en dashes, emoji or uppercase kickers appear anywhere, and a test scans the repo for them.
- The favicon is a separate `favicon.svg` and carries its own literal colours, because an icon file cannot read the page's custom properties.

## Mutation testing

`hark_honesty_and_defect_harness.py --planted-defects` copies the repo, flips operators in the root `.js` files one at a time (`===`, `!==`, `>=`, `<=`, `true`, `false`, `+ 1`, `- 1`) and checks that `npm test` fails each time. It only runs the first N mutations of the first file it finds, so I also ran the same operators over every site in both files.

Rules this forced on the code: no loops that could hang under a flipped comparison, no operators hidden inside comments, and no number literals that make a mutation equivalent.

## Commands

```
node --test
python3 "../../hark_honesty_and_defect_harness.py" --audit .
python3 "../../hark_honesty_and_defect_harness.py" --planted-defects . --count 25
```

The harness path is `Hark-Hackathons/hark_honesty_and_defect_harness.py` relative to the repos folder.
