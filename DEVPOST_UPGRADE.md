# Mipmap Arcade Devpost update

Paste-ready sections for a project page. Every number below was copied from `node --test` and from `measureFilterAliasing` on the current code. Rerun both before pasting if the code changes. This repository is a reference build and is not a Hack Club Mipmap entry, so do not submit it to Mipmap.

## Inspiration

Every 3D game samples textures, and most players never see why the distance shimmers when filtering is wrong. I wanted a racer where the road itself is the lesson, where you can flip between point, bilinear and trilinear sampling at 120 steps a second and watch the horizon change.

## What it does

LodZero is an arcade racer drawn by a software rasterizer in plain JavaScript, with no game engine, no graphics library and zero dependencies. Each pixel below the horizon is cast onto the ground plane, its texture footprint comes from an exact Jacobian, and a draggable split shows a heatmap of the mip level every pixel reads. Side panels show the mip pyramid, frame times and the spatial hash used for collisions.

The new filter lab measures what the eye sees. It compares each sampling mode against an 8 by 8 supersampled reference over 8 moving frames and reports error by distance band plus frame to frame flicker.

| Mode | Far-field RMSE | PSNR | Flicker |
| --- | --- | --- | --- |
| Point | 30.2 | 22.2 dB | 15.5 |
| Bilinear | 26.4 | 24.4 dB | 7.8 |
| Trilinear | 10.9 | 28.9 dB | 5.0 |

Trilinear cuts far-field error 2.8 times compared with point sampling. The lab also reports footprint anisotropy, which reaches 33 to 1 near the horizon and explains the blur trilinear trades for its calm.

## How we built it

Everything lives in one engine file that runs in the browser and in Node, so the picture on screen and the tests use the same code. Physics runs at a fixed 120 Hz step with semi-implicit yaw and RK2 motion. Ghost runs are stored as quantized, run-length encoded inputs that replay to the identical state.

## Challenges

The aliasing reference had to be honest about itself. A supersampled pixel at the horizon can cover more texels than it has samples, so the reference is an estimate there. Two invariants keep it trustworthy. With one sample per pixel the reference becomes point sampling and point error must be exactly zero. With a flat texture every filter must report zero error.

## Accomplishments

210 automated tests pass, including 11 for the filter lab. Lab results are deterministic, the JSON export carries no timestamps, and the page labels lab numbers as computed in the tab.

## What's next

Anisotropic filtering as a fourth mode, so the lab can show the blur trilinear leaves behind at grazing angles.

## Built with

JavaScript, HTML canvas, CSS, Node.js test runner
