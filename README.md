# Mipmap Arcade

LodZero is an arcade racer and a small software rasterizer workbench, written from scratch in plain JavaScript. There is no game engine, no graphics library and no framework. The page has zero dependencies, no build step and no network requests.

Play it: https://aariv.me/mipmap-arcade/

The road you drive on is a texture. While you race you can switch the texture filter between point, bilinear and trilinear mipmapping, and slide a split across the screen to see a heatmap of the mip level each pixel is reading.

## Honest notes first

This project was written with AI assistance. Hack Club Mipmap counts time spent AI coding at about a third less than hand coding and does not allow retyping a whole model-written project. This repository is therefore a disclosed AI-assisted reference build and is not a Hack Club Mipmap entry. The full reasoning is in [NOTES.md](NOTES.md). The tests are automated Node checks. The picture was checked in a real browser. No human playtesting has been done.

## How to play

| Control | Action |
| --- | --- |
| A and D, or the left and right arrows | Steer |
| W or the up arrow | Accelerate |
| S or the down arrow | Brake, then reverse |
| Space | Hold to drift. Release to fire a boost if the drift charged it |
| 1, 2, 3 | Point, bilinear, trilinear sampling |
| P | Toggle the pace car |
| R | Restart the race |
| M | Mute or unmute |

The page opens with the pace car driving a three lap demo loop. Press any driving key, or any on-screen touch button, to take over mid lap. Laps are counted through eight gates that must be taken in order. Energy cells add boost charge. Pylons scrub your speed. A clean finish by a human saves a ghost in local storage, and the ghost races you on the next visit. Runs where the pace car helped never save a ghost.

## What is in the engine

Everything lives in [engine.js](engine.js), a UMD file that runs as a browser global and as a Node module so the same code is drawn on screen and checked by tests.

- Fixed timestep at 120 Hz. Yaw uses semi-implicit Euler. Position and velocity use the RK2 midpoint method. Tires have a slip angle, a grip limit with downforce, a drift mode, a boost with heat that dissipates, and an overheat latch.
- A seedable Mulberry32 generator and a procedural closed circuit built from a smooth radius function and a Catmull-Rom spline.
- A spatial hash grid for the broadphase and a separating axis test for the narrowphase against gates, energy cells and pylons.
- A real mip pyramid builder (256 down to 1 with a 2x2 box filter), the screen-space Jacobian, lambda as the base two logarithm of the footprint, and exact nearest, bilinear and trilinear sampling.
- A software ground-plane rasterizer. Each pixel below the horizon is cast onto the ground plane, and the texture derivatives come from an analytic Jacobian instead of an estimate.
- A pace car that uses pure pursuit steering and a curvature limited speed target.
- Quantized input frames, run length encoded into a short byte string, that replay a whole race to the identical state.

[app.js](app.js) only wires that to the page: input, the loop, painting the pixel buffer, sprites, the inspector panels and WebAudio. [styles.css](styles.css) holds every colour and font as a custom property, and the canvas reads the same properties at runtime.

## Run it

Open `index.html` through any static server. For example:

```
python3 -m http.server 8080
```

Then visit http://localhost:8080. Add `?seed=7` to the address to start on a different track.

## Test it

```
node --test
```

Node 20 or newer. There is nothing to install. The suite covers the PRNG against an independent reference, the mip pyramid and filters, the Jacobian, the spatial hash, SAT collision, vehicle physics, track generation, the rasterizer, the ghost format, race rules, the pace car, and DOM smoke checks that run `app.js` against a small stand-in document and scan the HTML and CSS for the project's design rules.

## License

MIT. See [LICENSE](LICENSE).
