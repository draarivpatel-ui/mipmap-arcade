# Mipmap Arcade

LodZero is an arcade racer and a small software rasterizer workbench, written from scratch in plain JavaScript. There is no game engine, no graphics library and no framework. The page has zero dependencies, no build step and no network requests.

Play it: https://aariv.me/mipmap-arcade/

The road you drive on is a texture. While you race you can switch the texture filter between point, bilinear and trilinear mipmapping, and slide a split across the screen to see a heatmap of the mip level each pixel is reading.

This repository is a reference build. It is not a Hack Club Mipmap entry and has not been submitted to Mipmap. See [NOTES.md](NOTES.md).

## Filter lab: measured aliasing error

The page has a filter lab (press L or the Measure aliasing button) that puts numbers on what your eyes see while you drive. Each sampling mode renders a 128 by 72 ground plane, and every pixel is compared with an 8 by 8 supersampled box filter of the full size texture, over 8 frames while the camera creeps forward 0.37 texels per frame. Pixels are split into distance bands by lambda: near is magnified (lambda at most 0), mid is up to 3, far is beyond 3. Error is root mean square on 0 to 255 luminance. Flicker is the RMS change of that error from frame to frame, which is what reads as shimmer.

Results for the built-in texture (`generateDetailTexture(256, 7)`), computed by `measureFilterAliasing` in Node and identical in the browser:

| Mode | Near RMSE | Mid RMSE | Far RMSE | PSNR (all) | Flicker |
| --- | --- | --- | --- | --- | --- |
| Point | 10.5 | 15.4 | 30.2 | 22.2 dB | 15.5 |
| Bilinear | 5.8 | 9.4 | 26.4 | 24.4 dB | 7.8 |
| Trilinear | 5.8 | 9.4 | 10.9 | 28.9 dB | 5.0 |

| Band | Pixels | Mean lambda | Mean footprint anisotropy |
| --- | --- | --- | --- |
| Near | 1658 | -0.42 | 2.2 |
| Mid | 3406 | 1.25 | 4.0 |
| Far | 1848 | 5.83 | 33.0 |

What the numbers say:

- In the far band trilinear error is 2.8 times lower than point sampling, and flicker drops by about two thirds. That is the calm horizon you see in the game.
- Under magnification trilinear never leaves level 0, so its error equals bilinear exactly. A test checks that equality.
- Far pixels have footprints about 33 times longer than they are wide. Trilinear picks one level for the whole footprint, so it trades shimmer for blur there. That residual is what anisotropic filtering would address.
- The reference is itself an estimate: at the farthest rows a pixel can cover more texels than its 64 samples. With one sample per pixel the reference becomes point sampling, and a test checks that point error is then exactly zero.

The Download metrics JSON button saves the full result. It contains no timestamps, so the same texture always gives the same file.

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
| L | Run the filter lab |

The page opens with the pace car driving a three lap demo loop. Press any driving key, or any on-screen touch button, to take over mid lap. Laps are counted through eight gates that must be taken in order. Energy cells add boost charge. Pylons scrub your speed. A clean finish by a human saves a ghost in local storage, and the ghost races you on the next visit. Runs where the pace car helped never save a ghost.

## What is in the engine

Everything lives in [engine.js](engine.js), a UMD file that runs as a browser global and as a Node module so the same code is drawn on screen and checked by tests.

- Fixed timestep at 120 Hz. Yaw uses semi-implicit Euler. Position and velocity use the RK2 midpoint method. Tires have a slip angle, a grip limit with downforce, a drift mode, a boost with heat that dissipates, and an overheat latch.
- A seedable Mulberry32 generator and a procedural closed circuit built from a smooth radius function and a Catmull-Rom spline.
- A spatial hash grid for the broadphase and a separating axis test for the narrowphase against gates, energy cells and pylons.
- A real mip pyramid builder (256 down to 1 with a 2x2 box filter), the screen-space Jacobian, lambda as the base two logarithm of the footprint, and exact nearest, bilinear and trilinear sampling.
- A software ground-plane rasterizer. Each pixel below the horizon is cast onto the ground plane, and the texture derivatives come from an analytic Jacobian instead of an estimate.
- A filter lab that measures aliasing error per sampling mode against a supersampled reference (see above).
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

Node 20 or newer. There is nothing to install. 210 tests in three files:

- `tests/engine.test.js` (128): the PRNG against an independent reference, the mip pyramid and filters, the Jacobian, the spatial hash, SAT collision, vehicle physics, track generation, the rasterizer, the ghost format, race rules and the pace car.
- `tests/filter-lab.test.js` (11): the aliasing metrics, including exact-zero and flat-texture invariants, band ordering, filter ranking, determinism and the magnification equality above.
- `tests/dom-smoke.test.js` (71): runs `app.js` against a small stand-in document and scans the HTML and CSS for the project's design rules, including the lab controls, the L shortcut and the JSON export.

## License

MIT. See [LICENSE](LICENSE).
