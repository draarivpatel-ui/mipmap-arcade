'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function near(actual, expected, eps, label) {
  assert.ok(Math.abs(actual - expected) <= eps, (label || 'value') + ': ' + actual + ' is not within ' + eps + ' of ' + expected);
}

function texture(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = v[0];
      data[i + 1] = v[1];
      data[i + 2] = v[2];
      data[i + 3] = v[3] === undefined ? 255 : v[3];
    }
  }
  return { width: width, height: height, data: data };
}

function carAt(x, y, heading) {
  return E.createVehicle(x, y, heading);
}

function runVehicle(v, input, seconds, surface) {
  const steps = Math.round(seconds / E.FIXED_DT);
  for (let i = 0; i < steps; i++) E.stepVehiclePhysics(v, input, E.FIXED_DT, surface);
  return v;
}

const GAS = { steer: 0, throttle: 1, brake: 0, drift: false };
const COAST = { steer: 0, throttle: 0, brake: 0, drift: false };

/* ---------------------------------------------------------------- */
/* math and PRNG                                                     */
/* ---------------------------------------------------------------- */

test('clamp limits values on both sides', () => {
  assert.equal(E.clamp(5, 0, 3), 3);
  assert.equal(E.clamp(-5, 0, 3), 0);
  assert.equal(E.clamp(2, 0, 3), 2);
  assert.equal(E.clamp(0, 0, 3), 0);
  assert.equal(E.clamp(3, 0, 3), 3);
});

test('lerp hits both ends and the middle', () => {
  assert.equal(E.lerp(10, 20, 0), 10);
  assert.equal(E.lerp(10, 20, 1), 20);
  assert.equal(E.lerp(10, 20, 0.25), 12.5);
  assert.equal(E.lerp(10, 20, 2), 30);
});

test('wrapAngle folds any angle into the half open range minus pi to pi', () => {
  near(E.wrapAngle(0), 0, 1e-12);
  near(E.wrapAngle(Math.PI * 0.5), Math.PI * 0.5, 1e-12);
  near(E.wrapAngle(Math.PI * 1.5), -Math.PI * 0.5, 1e-12);
  near(E.wrapAngle(-Math.PI * 1.5), Math.PI * 0.5, 1e-12);
  near(E.wrapAngle(Math.PI * 6 + 0.3), 0.3, 1e-9);
  near(E.wrapAngle(-Math.PI * 6 - 0.3), -0.3, 1e-9);
  near(E.wrapAngle(Math.PI), -Math.PI, 1e-12);
});

test('wrapIndex handles negatives and overflow', () => {
  assert.equal(E.wrapIndex(0, 8), 0);
  assert.equal(E.wrapIndex(7, 8), 7);
  assert.equal(E.wrapIndex(8, 8), 0);
  assert.equal(E.wrapIndex(-1, 8), 7);
  assert.equal(E.wrapIndex(-9, 8), 7);
  assert.equal(E.wrapIndex(19, 8), 3);
});

test('smoothstep is zero, half and one at the edges and middle, and clamps', () => {
  assert.equal(E.smoothstep(0, 1, -1), 0);
  assert.equal(E.smoothstep(0, 1, 0), 0);
  assert.equal(E.smoothstep(0, 1, 0.5), 0.5);
  assert.equal(E.smoothstep(0, 1, 1), 1);
  assert.equal(E.smoothstep(0, 1, 9), 1);
  assert.equal(E.smoothstep(2, 4, 3), 0.5);
});

test('mulberry32 matches an independent reference for two seeds', () => {
  const a = E.mulberry32(1);
  assert.equal(a(), 0.6270739405881613);
  assert.equal(a(), 0.002735721180215478);
  assert.equal(a(), 0.5274470399599522);
  const b = E.mulberry32(12345);
  assert.equal(b(), 0.9797282677609473);
  assert.equal(b(), 0.3067522644996643);
  assert.equal(b(), 0.484205421525985);
});

test('mulberry32 is repeatable, seed dependent and stays in range', () => {
  const a = E.mulberry32(99);
  const b = E.mulberry32(99);
  const c = E.mulberry32(100);
  let different = false;
  for (let i = 0; i < 200; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
    if (x !== c()) different = true;
  }
  assert.ok(different);
});

/* ---------------------------------------------------------------- */
/* mip pyramid and filters                                           */
/* ---------------------------------------------------------------- */

test('isPowerOfTwo accepts only positive powers of two', () => {
  [1, 2, 4, 64, 256, 1024].forEach((n) => assert.equal(E.isPowerOfTwo(n), true, String(n)));
  [0, 3, 6, 12, 255, -4, 1.5, NaN].forEach((n) => assert.equal(E.isPowerOfTwo(n), false, String(n)));
});

test('mipLevelCount counts the whole chain to one texel', () => {
  assert.equal(E.mipLevelCount(256, 256), 9);
  assert.equal(E.mipLevelCount(1, 1), 1);
  assert.equal(E.mipLevelCount(8, 2), 4);
  assert.equal(E.mipLevelCount(2, 16), 5);
});

test('a 256 texture builds nine levels from 256 down to 1', () => {
  const pyr = E.buildMipmapPyramid(texture(256, 256, () => [10, 20, 30]));
  assert.equal(pyr.count, 9);
  assert.equal(pyr.maxLevel, 8);
  assert.deepEqual(pyr.levels.map((l) => l.width), [256, 128, 64, 32, 16, 8, 4, 2, 1]);
  assert.deepEqual(pyr.levels.map((l) => l.height), [256, 128, 64, 32, 16, 8, 4, 2, 1]);
  pyr.levels.forEach((l) => assert.equal(l.data.length, l.width * l.height * 4));
});

test('the box filter averages each 2x2 block exactly with rounding', () => {
  const t = texture(2, 2, (x, y) => [(y * 2 + x + 1) * 10, 0, 255, 255]);
  const pyr = E.buildMipmapPyramid(t);
  assert.equal(pyr.levels[1].data[0], 25);
  assert.equal(pyr.levels[1].data[1], 0);
  assert.equal(pyr.levels[1].data[2], 255);
  assert.equal(pyr.levels[1].data[3], 255);
  const low = E.buildMipmapPyramid(texture(2, 2, (x, y) => [x + y === 2 ? 1 : 0, 0, 0, 255]));
  assert.equal(low.levels[1].data[0], 0);
  const half = E.buildMipmapPyramid(texture(2, 2, (x, y) => [y === 1 ? 1 : 0, 0, 0, 255]));
  assert.equal(half.levels[1].data[0], 1);
});

test('each level averages the level above it, texel by texel', () => {
  const rng = E.mulberry32(3);
  const pyr = E.buildMipmapPyramid(texture(16, 16, () => [rng() * 255, rng() * 255, rng() * 255, 255]));
  for (let l = 1; l < pyr.count; l++) {
    const up = pyr.levels[l - 1];
    const lv = pyr.levels[l];
    for (let y = 0; y < lv.height; y++) {
      for (let x = 0; x < lv.width; x++) {
        for (let c = 0; c < 3; c++) {
          const sum = up.data[((2 * y) * up.width + 2 * x) * 4 + c] + up.data[((2 * y) * up.width + 2 * x + 1) * 4 + c] +
            up.data[((2 * y + 1) * up.width + 2 * x) * 4 + c] + up.data[((2 * y + 1) * up.width + 2 * x + 1) * 4 + c];
          assert.equal(lv.data[(y * lv.width + x) * 4 + c], (sum + 2) >> 2);
        }
      }
    }
  }
});

test('non square textures shrink each side until it reaches one', () => {
  const t = texture(8, 2, (x) => [x * 30, 0, 0, 255]);
  const pyr = E.buildMipmapPyramid(t);
  assert.deepEqual(pyr.levels.map((l) => l.width + 'x' + l.height), ['8x2', '4x1', '2x1', '1x1']);
  assert.equal(pyr.levels[1].data[0], 15);
  assert.equal(pyr.levels[1].data[4], 75);
  assert.equal(pyr.levels[2].data[0], 45);
  assert.equal(pyr.levels[2].data[4], 165);
  assert.equal(pyr.levels[3].data[0], 105);
});

test('the pyramid rejects sizes that are not powers of two and short data', () => {
  assert.throws(() => E.buildMipmapPyramid({ width: 6, height: 4, data: new Uint8ClampedArray(96) }), RangeError);
  assert.throws(() => E.buildMipmapPyramid({ width: 4, height: 3, data: new Uint8ClampedArray(48) }), RangeError);
  assert.throws(() => E.buildMipmapPyramid({ width: 4, height: 4, data: new Uint8ClampedArray(10) }), RangeError);
});

test('the pyramid copies its base level instead of aliasing it', () => {
  const t = texture(4, 4, () => [50, 50, 50, 255]);
  const pyr = E.buildMipmapPyramid(t);
  t.data[0] = 200;
  assert.equal(pyr.levels[0].data[0], 50);
});

test('the top level stays close to the average color of the base', () => {
  const rng = E.mulberry32(8);
  const t = texture(64, 64, () => [rng() * 255, 100, 40, 255]);
  const pyr = E.buildMipmapPyramid(t);
  let sum = 0;
  for (let i = 0; i < 64 * 64; i++) sum += t.data[i * 4];
  near(pyr.levels[pyr.maxLevel].data[0], sum / (64 * 64), 3);
  assert.equal(pyr.levels[pyr.maxLevel].data[1], 100);
});

test('lambda is log2 of the texel footprint on the longer axis', () => {
  near(E.computeMipLevelFromJacobian(1 / 256, 0, 0, 1 / 256, 256, 256), 0, 1e-12);
  near(E.computeMipLevelFromJacobian(2 / 256, 0, 0, 2 / 256, 256, 256), 1, 1e-12);
  near(E.computeMipLevelFromJacobian(0.5 / 256, 0, 0, 0.5 / 256, 256, 256), -1, 1e-12);
  near(E.computeMipLevelFromJacobian(8 / 256, 0, 0, 1 / 256, 256, 256), 3, 1e-12);
  near(E.computeMipLevelFromJacobian(1 / 256, 0, 0, 16 / 256, 256, 256), 4, 1e-12);
});

test('lambda combines both components of each screen axis as a vector length', () => {
  const rho = Math.sqrt(3 * 3 + 4 * 4);
  near(E.computeMipLevelFromJacobian(3 / 256, 4 / 256, 0, 0, 256, 256), Math.log2(rho), 1e-12);
  near(E.computeMipLevelFromJacobian(0, 0, 3 / 256, 4 / 256, 256, 256), Math.log2(rho), 1e-12);
});

test('lambda scales u by width and v by height for non square textures', () => {
  near(E.computeMipLevelFromJacobian(1 / 64, 0, 0, 0, 64, 16), 0, 1e-12);
  near(E.computeMipLevelFromJacobian(0, 1 / 16, 0, 0, 64, 16), 0, 1e-12);
  near(E.computeMipLevelFromJacobian(0, 0, 4 / 64, 0, 64, 16), 2, 1e-12);
  near(E.computeMipLevelFromJacobian(0, 0, 0, 4 / 16, 64, 16), 2, 1e-12);
});

test('lambda has a floor so a zero footprint stays finite', () => {
  const l = E.computeMipLevelFromJacobian(0, 0, 0, 0, 256, 256);
  assert.ok(Number.isFinite(l));
  near(l, Math.log2(0.00001), 1e-12);
});

test('nearest sampling returns the exact texel and wraps', () => {
  const t = texture(4, 4, (x, y) => [x * 10 + y * 40, 7, 9, 255]);
  const lv = E.buildMipmapPyramid(t).levels[0];
  const out = [0, 0, 0, 0];
  E.sampleNearest(lv, 0.1, 0.1, out);
  assert.deepEqual(out, [0, 7, 9, 255]);
  E.sampleNearest(lv, 0.6, 0.3, out);
  assert.deepEqual(out, [20 + 40, 7, 9, 255]);
  E.sampleNearest(lv, 1.1, 0.1, out);
  assert.equal(out[0], 0);
  E.sampleNearest(lv, -0.1, 0.1, out);
  assert.equal(out[0], 30);
  E.sampleNearest(lv, 0.1, -0.1, out);
  assert.equal(out[0], 120);
});

test('bilinear sampling is exact at texel centers and blends between them', () => {
  const t = texture(4, 4, (x, y) => [x * 40 + y * 10, 0, 0, 255]);
  const lv = E.buildMipmapPyramid(t).levels[0];
  const out = [0, 0, 0, 0];
  E.sampleBilinear(lv, 0.125, 0.125, out);
  near(out[0], 0, 1e-9);
  E.sampleBilinear(lv, 0.375, 0.125, out);
  near(out[0], 40, 1e-9);
  E.sampleBilinear(lv, 0.25, 0.125, out);
  near(out[0], 20, 1e-9);
  E.sampleBilinear(lv, 0.125, 0.25, out);
  near(out[0], 5, 1e-9);
  E.sampleBilinear(lv, 0.25, 0.25, out);
  near(out[0], 25, 1e-9);
  assert.equal(out[3], 255);
});

test('bilinear sampling wraps across the texture seam', () => {
  const t = texture(4, 1, (x) => [x === 0 ? 0 : (x === 3 ? 200 : 100), 0, 0, 255]);
  const lv = E.buildMipmapPyramid(t).levels[0];
  const out = [0, 0, 0, 0];
  E.sampleBilinear(lv, 0, 0.5, out);
  near(out[0], 100, 1e-9);
  E.sampleBilinear(lv, 1, 0.5, out);
  near(out[0], 100, 1e-9);
});

test('trilinear equals bilinear on level zero when lambda is zero or below', () => {
  const pyr = E.buildMipmapPyramid(E.generateDetailTexture(32, 4));
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  E.sampleTrilinearMipmap(pyr, 0.31, 0.77, 0, a);
  E.sampleBilinear(pyr.levels[0], 0.31, 0.77, b);
  assert.deepEqual(a, b);
  E.sampleTrilinearMipmap(pyr, 0.31, 0.77, -3, a);
  assert.deepEqual(a, b);
});

test('trilinear equals bilinear on a whole level at an integer lambda', () => {
  const pyr = E.buildMipmapPyramid(E.generateDetailTexture(32, 4));
  const a = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  E.sampleTrilinearMipmap(pyr, 0.31, 0.77, 2, a);
  E.sampleBilinear(pyr.levels[2], 0.31, 0.77, b);
  near(a[0], b[0], 1e-9);
  near(a[2], b[2], 1e-9);
});

test('trilinear blends two neighbouring levels by the fraction of lambda', () => {
  const pyr = E.buildMipmapPyramid(E.generateDetailTexture(32, 4));
  const lo = [0, 0, 0, 0];
  const hi = [0, 0, 0, 0];
  const mix = [0, 0, 0, 0];
  E.sampleBilinear(pyr.levels[1], 0.42, 0.13, lo);
  E.sampleBilinear(pyr.levels[2], 0.42, 0.13, hi);
  E.sampleTrilinearMipmap(pyr, 0.42, 0.13, 1.25, mix);
  near(mix[0], lo[0] * 0.75 + hi[0] * 0.25, 1e-9);
  near(mix[1], lo[1] * 0.75 + hi[1] * 0.25, 1e-9);
  near(mix[2], lo[2] * 0.75 + hi[2] * 0.25, 1e-9);
  near(mix[3], 255, 1e-9);
});

test('trilinear clamps lambda to the last level', () => {
  const pyr = E.buildMipmapPyramid(E.generateDetailTexture(32, 4));
  const a = [0, 0, 0, 0];
  const top = pyr.levels[pyr.maxLevel].data;
  E.sampleTrilinearMipmap(pyr, 0.5, 0.5, 50, a);
  assert.deepEqual(a, [top[0], top[1], top[2], top[3]]);
  E.sampleTrilinearMipmap(pyr, 0.2, 0.9, pyr.maxLevel, a);
  assert.deepEqual(a, [top[0], top[1], top[2], top[3]]);
});

test('sampleTexture dispatches on the mode and only trilinear reads lambda', () => {
  const pyr = E.buildMipmapPyramid(E.generateDetailTexture(64, 11));
  const out = [0, 0, 0, 0];
  const ref = [0, 0, 0, 0];
  E.sampleTexture(pyr, E.SAMPLE_POINT, 0.333, 0.717, 0, out);
  E.sampleNearest(pyr.levels[0], 0.333, 0.717, ref);
  assert.deepEqual(out, ref);
  E.sampleTexture(pyr, E.SAMPLE_POINT, 0.333, 0.717, 5, out);
  assert.deepEqual(out, ref);
  E.sampleTexture(pyr, E.SAMPLE_BILINEAR, 0.333, 0.717, 5, out);
  E.sampleBilinear(pyr.levels[0], 0.333, 0.717, ref);
  assert.deepEqual(out, ref);
  E.sampleTexture(pyr, E.SAMPLE_TRILINEAR, 0.333, 0.717, 3.5, out);
  E.sampleTrilinearMipmap(pyr, 0.333, 0.717, 3.5, ref);
  assert.deepEqual(out, ref);
  assert.notDeepEqual(out, [0, 0, 0, 0]);
});

test('the detail texture is repeatable, seeded, opaque and full of contrast', () => {
  const a = E.generateDetailTexture(64, 5);
  const b = E.generateDetailTexture(64, 5);
  const c = E.generateDetailTexture(64, 6);
  assert.deepEqual(Array.from(a.data), Array.from(b.data));
  assert.notDeepEqual(Array.from(a.data), Array.from(c.data));
  assert.equal(a.width, 64);
  assert.equal(a.data.length, 64 * 64 * 4);
  let min = 255;
  let max = 0;
  for (let i = 0; i < 64 * 64; i++) {
    assert.equal(a.data[i * 4 + 3], 255);
    assert.equal(a.data[i * 4], a.data[i * 4 + 1]);
    min = Math.min(min, a.data[i * 4]);
    max = Math.max(max, a.data[i * 4]);
  }
  assert.ok(max - min > 60);
});

/* ---------------------------------------------------------------- */
/* spatial hash and SAT                                              */
/* ---------------------------------------------------------------- */

test('the spatial hash returns only ids from overlapping cells', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('a', 1, 1, 2, 2);
  g.insert('b', 51, 51, 52, 52);
  assert.deepEqual(g.query(0, 0, 5, 5), ['a']);
  assert.deepEqual(g.query(50, 50, 55, 55), ['b']);
  assert.deepEqual(g.query(20, 20, 30, 30), []);
  assert.deepEqual(g.query(0, 0, 60, 60).sort(), ['a', 'b']);
});

test('the spatial hash reports a multi-cell entry once', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('wide', 0, 0, 35, 5);
  assert.equal(g.entryCount, 4);
  assert.deepEqual(g.query(0, 0, 40, 10), ['wide']);
});

test('the spatial hash handles negative coordinates', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('n', -15, -15, -12, -12);
  g.insert('p', 12, 12, 15, 15);
  assert.deepEqual(g.query(-20, -20, -10, -10), ['n']);
  assert.deepEqual(g.query(10, 10, 20, 20), ['p']);
  assert.deepEqual(g.query(-5, -5, 5, 5), []);
});

test('the spatial hash cell edges belong to the next cell', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('edge', 10, 10, 10, 10);
  assert.deepEqual(g.query(0, 0, 9.99, 9.99), []);
  assert.deepEqual(g.query(10, 10, 10, 10), ['edge']);
  assert.equal(g.cellCoord(9.99), 0);
  assert.equal(g.cellCoord(10), 1);
  assert.equal(g.cellCoord(-0.01), -1);
});

test('the spatial hash separates cells that share only one coordinate', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('a', 5, 5, 5, 5);
  g.insert('b', 5, 15, 5, 15);
  g.insert('c', 15, 5, 15, 5);
  assert.deepEqual(g.query(0, 0, 9, 9), ['a']);
  assert.deepEqual(g.query(0, 10, 9, 19), ['b']);
  assert.deepEqual(g.query(10, 0, 19, 9), ['c']);
  assert.equal(g.stats().cells, 3);
});

test('the spatial hash clears, reuses the output array and reports stats', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert(1, 0, 0, 1, 1);
  g.insert(2, 0, 0, 1, 1);
  g.insert(3, 25, 25, 26, 26);
  assert.deepEqual(g.stats(), { cells: 2, entries: 3, maxPerCell: 2 });
  const out = ['stale'];
  const res = g.query(0, 0, 5, 5, out);
  assert.equal(res, out);
  assert.deepEqual(out, [1, 2]);
  const seen = [];
  g.forEachCell((ix, iy, n) => seen.push([ix, iy, n]));
  seen.sort();
  assert.deepEqual(seen, [[0, 0, 2], [2, 2, 1]]);
  g.clear();
  assert.deepEqual(g.stats(), { cells: 0, entries: 0, maxPerCell: 0 });
  assert.deepEqual(g.query(0, 0, 100, 100), []);
});

test('forEachCell decodes negative cell coordinates', () => {
  const g = new E.SpatialHashGrid(10);
  g.insert('x', -25, -5, -25, -5);
  const seen = [];
  g.forEachCell((ix, iy, n) => seen.push([ix, iy, n]));
  assert.deepEqual(seen, [[-3, -1, 1]]);
});

test('SAT reports depth and a normal that points from the first box to the second', () => {
  const a = E.makeObb(0, 0, 2, 1, 0);
  const b = E.makeObb(3, 0, 2, 1, 0);
  const hit = E.obbOverlap(a, b);
  near(hit.depth, 1, 1e-9);
  near(hit.nx, 1, 1e-9);
  near(hit.ny, 0, 1e-9);
  const back = E.obbOverlap(b, a);
  near(back.nx, -1, 1e-9);
  near(back.depth, 1, 1e-9);
  const above = E.obbOverlap(E.makeObb(0, 0, 2, 1, 0), E.makeObb(0, 1.5, 2, 1, 0));
  near(above.depth, 0.5, 1e-9);
  near(above.ny, 1, 1e-9);
  const below = E.obbOverlap(E.makeObb(0, 0, 2, 1, 0), E.makeObb(0, -1.5, 2, 1, 0));
  near(below.ny, -1, 1e-9);
});

test('SAT returns null for separated and exactly touching boxes', () => {
  assert.equal(E.obbOverlap(E.makeObb(0, 0, 1, 1, 0), E.makeObb(5, 0, 1, 1, 0)), null);
  assert.equal(E.obbOverlap(E.makeObb(0, 0, 1, 1, 0), E.makeObb(0, 5, 1, 1, 0)), null);
  assert.equal(E.obbOverlap(E.makeObb(0, 0, 1, 1, 0), E.makeObb(2, 0, 1, 1, 0)), null);
});

test('SAT sees through bounding box overlap using the rotated axes', () => {
  const quarter = Math.PI / 4;
  const diamond = E.makeObb(0, 0, 1, 1, quarter);
  const corner = E.makeObb(1.9, 1.9, 1, 1, 0);
  const bb1 = E.obbBounds(diamond);
  const bb2 = E.obbBounds(corner);
  assert.ok(bb1.maxX > bb2.minX && bb1.maxY > bb2.minY);
  assert.equal(E.obbOverlap(diamond, corner), null);
  const close = E.makeObb(1.2, 1.2, 1, 1, 0);
  assert.ok(E.obbOverlap(diamond, close));
});

test('SAT works when the second box is the rotated one', () => {
  const box = E.makeObb(0, 0, 3, 0.5, 0);
  const tilted = E.makeObb(0, 1.2, 3, 0.5, 0.4);
  const hit = E.obbOverlap(box, tilted);
  assert.ok(hit);
  assert.ok(hit.depth > 0);
  assert.ok(hit.ny > 0);
  const apart = E.makeObb(0, 3, 3, 0.5, 0.4);
  assert.equal(E.obbOverlap(box, apart), null);
});

test('obbBounds covers a rotated box exactly', () => {
  const b = E.obbBounds(E.makeObb(10, 20, 2, 1, Math.PI / 2));
  near(b.minX, 9, 1e-9);
  near(b.maxX, 11, 1e-9);
  near(b.minY, 18, 1e-9);
  near(b.maxY, 22, 1e-9);
  const d = E.obbBounds(E.makeObb(0, 0, 1, 1, Math.PI / 4));
  near(d.maxX, Math.SQRT2, 1e-9);
  near(d.minY, -Math.SQRT2, 1e-9);
});

/* ---------------------------------------------------------------- */
/* vehicle physics                                                   */
/* ---------------------------------------------------------------- */

test('a new vehicle is at rest with the given pose', () => {
  const v = carAt(3, 4, 0.5);
  assert.equal(v.x, 3);
  assert.equal(v.y, 4);
  assert.equal(v.heading, 0.5);
  assert.equal(v.speed, 0);
  assert.equal(v.boostCharge, 0);
  assert.equal(v.heat, 0);
  assert.equal(v.overheated, false);
  assert.equal(v.drifting, false);
});

test('throttle drives the car forward along its heading and updates speed', () => {
  const v = runVehicle(carAt(0, 0, 0), GAS, 2);
  assert.ok(v.x > 20);
  near(v.y, 0, 1e-6);
  near(v.speed, Math.hypot(v.vx, v.vy), 1e-12);
  assert.ok(v.speed > 25 && v.speed < 50);
  const north = runVehicle(carAt(0, 0, Math.PI / 2), GAS, 2);
  assert.ok(north.y > 20);
  near(north.x, 0, 1e-6);
});

test('stepVehiclePhysics returns the vehicle it was given', () => {
  const v = carAt(0, 0, 0);
  assert.equal(E.stepVehiclePhysics(v, GAS, E.FIXED_DT), v);
});

test('full throttle settles at a bounded top speed', () => {
  const v = runVehicle(carAt(0, 0, 0), GAS, 40);
  assert.ok(v.speed > 44 && v.speed < 56, 'top speed ' + v.speed);
  const earlier = runVehicle(carAt(0, 0, 0), GAS, 30).speed;
  near(v.speed, earlier, 0.5);
});

test('coasting loses speed to drag and rolling resistance', () => {
  const v = carAt(0, 0, 0);
  v.vx = 30;
  runVehicle(v, COAST, 3);
  assert.ok(v.speed < 30 && v.speed > 15);
  const slow = carAt(0, 0, 0);
  slow.vx = 1;
  runVehicle(slow, COAST, 5);
  assert.ok(slow.speed < 0.05);
});

test('braking stops the car and then eases it into a capped reverse', () => {
  const v = carAt(0, 0, 0);
  v.vx = 40;
  const brake = { steer: 0, throttle: 0, brake: 1, drift: false };
  runVehicle(v, brake, 1);
  assert.ok(v.vx < 5 && v.vx > -3);
  runVehicle(v, brake, 6);
  assert.ok(v.vx < -3 && v.vx > -12);
  near(v.y, 0, 1e-6);
});

test('half brake slows the car less than full brake', () => {
  const a = carAt(0, 0, 0);
  a.vx = 40;
  const b = carAt(0, 0, 0);
  b.vx = 40;
  runVehicle(a, { steer: 0, throttle: 0, brake: 0.5, drift: false }, 0.5);
  runVehicle(b, { steer: 0, throttle: 0, brake: 1, drift: false }, 0.5);
  assert.ok(a.speed > b.speed + 5);
});

test('steering right lowers the heading and steering left raises it', () => {
  const right = carAt(0, 0, 0);
  right.vx = 20;
  runVehicle(right, { steer: 1, throttle: 0.3, brake: 0, drift: false }, 1);
  assert.ok(right.heading < -0.2);
  assert.ok(right.y < 0);
  const left = carAt(0, 0, 0);
  left.vx = 20;
  runVehicle(left, { steer: -1, throttle: 0.3, brake: 0, drift: false }, 1);
  assert.ok(left.heading > 0.2);
  assert.ok(left.y > 0);
  near(left.heading, -right.heading, 1e-6);
});

test('yaw rate relaxes toward the speed dependent target', () => {
  const v = carAt(0, 0, 0);
  v.vx = 8;
  const input = { steer: 1, throttle: 0, brake: 0, drift: false };
  const target = -(8 / 3.6) * Math.tan(0.55 / (1 + 8 / 25));
  E.stepVehiclePhysics(v, input, E.FIXED_DT);
  near(v.omega, target * 8 * E.FIXED_DT, 1e-9);
  const early = v.omega;
  runVehicle(v, input, 0.5);
  assert.ok(v.omega < early);
  near(v.omega, -(v.vx * Math.cos(v.heading) + v.vy * Math.sin(v.heading)) / 3.6 * Math.tan(0.55 / (1 + Math.abs(v.speed) / 25)), 0.15);
});

test('steering lock shrinks as speed rises', () => {
  const slow = carAt(0, 0, 0);
  slow.vx = 4;
  const fast = carAt(0, 0, 0);
  fast.vx = 8;
  const input = { steer: 1, throttle: 0, brake: 0, drift: false };
  E.stepVehiclePhysics(slow, input, E.FIXED_DT);
  E.stepVehiclePhysics(fast, input, E.FIXED_DT);
  const ratio = fast.omega / slow.omega;
  near(ratio, (8 * Math.tan(0.55 / (1 + 8 / 25))) / (4 * Math.tan(0.55 / (1 + 4 / 25))), 1e-9);
  assert.ok(ratio > 1 && ratio < 2);
});

test('yaw rate is limited by grip so full lock at speed does not spin the car', () => {
  const v = carAt(0, 0, 0);
  v.vx = 50;
  const input = { steer: 1, throttle: 0, brake: 0, drift: false };
  const limit = 1.1 * (12.3 + 0.0016 * 2500) / 50;
  E.stepVehiclePhysics(v, input, E.FIXED_DT);
  near(v.omega, -limit * 8 * E.FIXED_DT, 1e-9);
  const grass = carAt(0, 0, 0);
  grass.vx = 50;
  E.stepVehiclePhysics(grass, input, E.FIXED_DT, { gripScale: 0.62, extraDrag: 7 });
  near(grass.omega / v.omega, 0.62, 1e-9);
  const hold = carAt(0, 0, 0);
  hold.vx = 40;
  runVehicle(hold, input, 1.5);
  assert.ok(Math.abs(hold.omega) < 0.55);
  assert.ok(Math.abs(hold.slip) < 0.5);
});

test('sideways velocity is gripped away and the slip angle shrinks', () => {
  const v = carAt(0, 0, 0);
  v.vx = 30;
  v.vy = 4;
  runVehicle(v, COAST, 1);
  assert.ok(Math.abs(v.vy) < 1);
  assert.ok(Math.abs(v.slip) < 0.1);
});

test('slip angle follows the sign of the sideways velocity', () => {
  const left = carAt(0, 0, 0);
  left.vx = 30;
  left.vy = 5;
  E.stepVehiclePhysics(left, COAST, E.FIXED_DT);
  assert.ok(left.slip > 0.1);
  const right = carAt(0, 0, 0);
  right.vx = 30;
  right.vy = -5;
  E.stepVehiclePhysics(right, COAST, E.FIXED_DT);
  assert.ok(right.slip < -0.1);
  near(left.slip, -right.slip, 1e-9);
});

test('downforce raises the lateral grip limit at high speed', () => {
  function sideCut(downforce) {
    const saved = E.VEHICLE.downforce;
    E.VEHICLE.downforce = downforce;
    const v = carAt(0, 0, 0);
    v.vx = 60;
    v.vy = 15;
    E.stepVehiclePhysics(v, COAST, E.FIXED_DT);
    E.VEHICLE.downforce = saved;
    return 15 - v.vy;
  }
  const withForce = sideCut(0.0016);
  const without = sideCut(0);
  const slip = Math.atan2(15, 60);
  const extra = 0.0016 * 3600 * Math.tanh(slip * 6) * E.FIXED_DT;
  near(withForce - without, extra, 0.002);
  assert.ok(withForce > without);
});

test('grass grips less and drags more than asphalt', () => {
  const grass = { gripScale: 0.62, extraDrag: 7 };
  const a = carAt(0, 0, 0);
  a.vx = 30;
  const b = carAt(0, 0, 0);
  b.vx = 30;
  runVehicle(a, COAST, 1);
  runVehicle(b, COAST, 1, grass);
  assert.ok(b.speed < a.speed - 4);
  const c = carAt(0, 0, 0);
  c.vx = 30;
  c.vy = 8;
  const d = carAt(0, 0, 0);
  d.vx = 30;
  d.vy = 8;
  runVehicle(c, COAST, 0.3);
  runVehicle(d, COAST, 0.3, grass);
  assert.ok(Math.abs(d.vy) > Math.abs(c.vy));
});

test('drifting lowers grip so a slide lasts longer', () => {
  const grip = carAt(0, 0, 0);
  grip.vx = 30;
  grip.vy = 6;
  const slide = carAt(0, 0, 0);
  slide.vx = 30;
  slide.vy = 6;
  runVehicle(grip, COAST, 0.4);
  runVehicle(slide, { steer: 0, throttle: 0, brake: 0, drift: true }, 0.4);
  assert.equal(slide.drifting, true);
  assert.equal(grip.drifting, false);
  assert.ok(Math.abs(slide.vy) > Math.abs(grip.vy));
});

test('drift needs some speed and boosts the yaw response', () => {
  const crawl = carAt(0, 0, 0);
  crawl.vx = 3;
  E.stepVehiclePhysics(crawl, { steer: 0, throttle: 0, brake: 0, drift: true }, E.FIXED_DT);
  assert.equal(crawl.drifting, false);
  const edge = carAt(0, 0, 0);
  edge.vx = 6.01;
  E.stepVehiclePhysics(edge, { steer: 0, throttle: 0, brake: 0, drift: true }, E.FIXED_DT);
  assert.equal(edge.drifting, true);
  const under = carAt(0, 0, 0);
  under.vx = 5.9;
  E.stepVehiclePhysics(under, { steer: 0, throttle: 0, brake: 0, drift: true }, E.FIXED_DT);
  assert.equal(under.drifting, false);
  const lowBase = carAt(0, 0, 0);
  lowBase.vx = 7;
  const lowDrift = carAt(0, 0, 0);
  lowDrift.vx = 7;
  E.stepVehiclePhysics(lowBase, { steer: 1, throttle: 0, brake: 0, drift: false }, E.FIXED_DT);
  E.stepVehiclePhysics(lowDrift, { steer: 1, throttle: 0, brake: 0, drift: true }, E.FIXED_DT);
  near(lowDrift.omega / lowBase.omega, (5.5 * 1.35) / 8, 1e-9);
  const base = carAt(0, 0, 0);
  base.vx = 30;
  const drift = carAt(0, 0, 0);
  drift.vx = 30;
  E.stepVehiclePhysics(base, { steer: 1, throttle: 0.3, brake: 0, drift: false }, E.FIXED_DT);
  E.stepVehiclePhysics(drift, { steer: 1, throttle: 0.3, brake: 0, drift: true }, E.FIXED_DT);
  near(drift.omega / base.omega, (2.2 * 5.5) / (1.1 * 8), 1e-9);
});

function driftHard(v, seconds) {
  const input = { steer: 1, throttle: 0.6, brake: 0, drift: true };
  runVehicle(v, input, seconds);
  return v;
}

test('drifting through a slide charges boost and a slow roll does not', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  driftHard(v, 1.5);
  assert.ok(v.boostCharge > 0.2, 'charge ' + v.boostCharge);
  const crawl = carAt(0, 0, 0);
  crawl.vx = 8;
  runVehicle(crawl, { steer: 1, throttle: 0, brake: 0, drift: true }, 1);
  assert.equal(crawl.boostCharge, 0);
  const lowSlip = carAt(0, 0, 0);
  lowSlip.vx = 35;
  lowSlip.vy = 1.5;
  E.stepVehiclePhysics(lowSlip, { steer: 0, throttle: 0, brake: 0, drift: true }, E.FIXED_DT);
  assert.equal(lowSlip.boostCharge, 0);
  const straight = carAt(0, 0, 0);
  straight.vx = 35;
  runVehicle(straight, { steer: 0, throttle: 0.6, brake: 0, drift: true }, 1);
  assert.equal(straight.boostCharge, 0);
});

test('charge is capped at one', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostCharge = 0.999;
  driftHard(v, 1);
  assert.ok(v.boostCharge <= 1);
  assert.ok(v.boostCharge > 0.999);
});

test('releasing drift with enough charge fires a timed boost', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostCharge = 0.5;
  v.drifting = true;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.equal(v.drifting, false);
  assert.equal(v.boostCharge, 0);
  near(v.boostTimer, 0.4 + 1.6 * 0.5 - E.FIXED_DT, 1e-9);
  const plain = carAt(0, 0, 0);
  plain.vx = 35;
  runVehicle(plain, GAS, 1.5);
  const boosted = carAt(0, 0, 0);
  boosted.vx = 35;
  boosted.boostCharge = 0.5;
  boosted.drifting = true;
  runVehicle(boosted, GAS, 1.5);
  assert.ok(boosted.speed > plain.speed + 4);
});

test('too little charge on release gives no boost', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostCharge = 0.2;
  v.drifting = true;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.equal(v.boostTimer, 0);
  assert.equal(v.boostCharge, 0.2);
});

test('the charge threshold is inclusive', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostCharge = 0.25;
  v.drifting = true;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.ok(v.boostTimer > 0);
});

test('an overheated car cannot fire a boost', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostCharge = 1;
  v.drifting = true;
  v.overheated = true;
  v.heat = 0.9;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.equal(v.boostTimer, 0);
  assert.equal(v.boostCharge, 1);
});

test('boosting adds heat at the configured rate', () => {
  const v = carAt(0, 0, 0);
  v.vx = 35;
  v.boostTimer = 2;
  runVehicle(v, GAS, 1);
  near(v.heat, 0.5, 0.01);
  near(v.boostTimer, 1, 0.01);
});

test('heat dissipates exponentially when not boosting', () => {
  const v = carAt(0, 0, 0);
  v.heat = 0.8;
  runVehicle(v, COAST, 2.5);
  near(v.heat, 0.8 * Math.exp(-1), 0.002);
  runVehicle(v, COAST, 10);
  assert.ok(v.heat < 0.02);
});

test('reaching the heat limit latches an overheat that clears only after cooling', () => {
  const v = carAt(0, 0, 0);
  v.vx = 30;
  v.boostTimer = 5;
  v.heat = 0.99;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.equal(v.overheated, false);
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.equal(v.overheated, true);
  assert.equal(v.heat, 1);
  assert.equal(v.boostTimer, 0);
  runVehicle(v, COAST, 2);
  assert.equal(v.overheated, true);
  runVehicle(v, COAST, 1);
  assert.equal(v.overheated, false);
  assert.ok(v.heat <= 0.35);
});

test('an overheated car ignores a boost timer that is still running', () => {
  const v = carAt(0, 0, 0);
  v.vx = 30;
  v.overheated = true;
  v.heat = 0.9;
  v.boostTimer = 3;
  const heatBefore = v.heat;
  E.stepVehiclePhysics(v, GAS, E.FIXED_DT);
  assert.ok(v.heat < heatBefore);
  assert.equal(v.boostTimer, 3);
});

test('the integrator is second order: halving the step barely changes the result', () => {
  const straight = { steer: 0, throttle: 1, brake: 0, drift: false };
  const coarse = carAt(0, 0, 0);
  const fine = carAt(0, 0, 0);
  for (let i = 0; i < 240; i++) E.stepVehiclePhysics(coarse, straight, 1 / 120);
  for (let i = 0; i < 2400; i++) E.stepVehiclePhysics(fine, straight, 1 / 1200);
  near(coarse.x, fine.x, fine.x * 0.0002);
  near(coarse.speed, fine.speed, 0.005);
  const bend = { steer: 0.5, throttle: 1, brake: 0, drift: false };
  const c2 = carAt(0, 0, 0);
  const f2 = carAt(0, 0, 0);
  for (let i = 0; i < 240; i++) E.stepVehiclePhysics(c2, bend, 1 / 120);
  for (let i = 0; i < 2400; i++) E.stepVehiclePhysics(f2, bend, 1 / 1200);
  near(c2.x, f2.x, Math.abs(f2.x) * 0.02 + 0.2);
  near(c2.y, f2.y, Math.abs(f2.y) * 0.02 + 0.2);
  near(c2.speed, f2.speed, 0.15);
});

test('identical inputs always give bit identical states', () => {
  function run() {
    const v = carAt(1, 2, 0.3);
    for (let i = 0; i < 1200; i++) {
      const input = { steer: Math.sin(i * 0.01), throttle: 1, brake: 0, drift: i % 300 > 150 };
      E.stepVehiclePhysics(v, input, E.FIXED_DT);
    }
    return [v.x, v.y, v.heading, v.vx, v.vy, v.omega, v.heat, v.boostCharge];
  }
  assert.deepEqual(run(), run());
});

/* ---------------------------------------------------------------- */
/* track                                                             */
/* ---------------------------------------------------------------- */

test('track generation is deterministic per seed and differs between seeds', () => {
  const a = E.generateTrackCircuit(2026);
  const b = E.generateTrackCircuit(2026);
  const c = E.generateTrackCircuit(2027);
  assert.deepEqual(Array.from(a.xs), Array.from(b.xs));
  assert.deepEqual(Array.from(a.ys), Array.from(b.ys));
  assert.notDeepEqual(Array.from(a.xs), Array.from(c.xs));
  assert.deepEqual(a.pylons.map((p) => p.box.cx), b.pylons.map((p) => p.box.cx));
});

test('a default track has sixteen segments of twenty samples and a plausible length', () => {
  const t = E.generateTrackCircuit(2026);
  assert.equal(t.count, 320);
  assert.equal(t.xs.length, 320);
  assert.ok(t.length > 1400 && t.length < 1900);
  const small = E.generateTrackCircuit(2026, { controlPoints: 8, samplesPerSegment: 10, radius: 100 });
  assert.equal(small.count, 80);
  assert.ok(small.length > 400 && small.length < 800);
});

test('the pinned seed 2026 circuit has not drifted', () => {
  const t = E.generateTrackCircuit(2026);
  near(t.length, 1655.8108354557855, 1e-6);
  near(t.xs[0], 233.4697313294606, 1e-9);
  near(t.ys[0], 0, 1e-9);
  near(t.xs[100], -93.28147409444465, 1e-9);
  near(t.ys[100], 225.2013998769628, 1e-9);
  near(t.gates[3].box.cx, -186.7126747011649, 1e-9);
  near(t.cells[0].box.cx, 224.60592667026427, 1e-9);
  near(t.pylons[0].box.cx, 219.63183200285638, 1e-9);
});

test('the track closes on itself with consistent cumulative distances', () => {
  const t = E.generateTrackCircuit(7);
  let sum = 0;
  for (let i = 0; i < t.count; i++) {
    near(t.cum[i], sum, 1e-9);
    sum += t.segLen[i];
    assert.ok(t.segLen[i] > 0.5 && t.segLen[i] < 20);
  }
  near(t.length, sum, 1e-9);
  const closing = Math.hypot(t.xs[0] - t.xs[t.count - 1], t.ys[0] - t.ys[t.count - 1]);
  assert.ok(closing < 20);
  near(closing, t.segLen[t.count - 1], 1e-9);
});

test('headings follow the segments and curvature is gentle enough to drive', () => {
  const t = E.generateTrackCircuit(2026);
  let maxCurve = 0;
  for (let i = 0; i < t.count; i++) {
    const j = (i + 1) % t.count;
    near(t.headings[i], Math.atan2(t.ys[j] - t.ys[i], t.xs[j] - t.xs[i]), 1e-12);
    maxCurve = Math.max(maxCurve, Math.abs(t.curvature[i]));
  }
  assert.ok(maxCurve < 1 / 60, 'tightest radius ' + (1 / maxCurve));
  assert.ok(maxCurve > 1 / 400);
  let net = 0;
  for (let i = 0; i < t.count; i++) net += t.curvature[i] * ((t.segLen[i] + t.segLen[(i + 1) % t.count]) / 2);
  near(Math.abs(net), Math.PI * 2, 0.05);
});

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  function orient(px, py, qx, qy, rx, ry) {
    return (qx - px) * (ry - py) - (qy - py) * (rx - px);
  }
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

test('tracks from many seeds never cross themselves', () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 2026]) {
    const t = E.generateTrackCircuit(seed);
    const n = t.count;
    for (let i = 0; i < n; i += 3) {
      for (let j = i + 4; j < n; j += 3) {
        if (i === 0 && j >= n - 4) continue;
        const i2 = (i + 1) % n;
        const j2 = (j + 1) % n;
        assert.equal(segmentsCross(t.xs[i], t.ys[i], t.xs[i2], t.ys[i2], t.xs[j], t.ys[j], t.xs[j2], t.ys[j2]), false, 'seed ' + seed + ' ' + i + ' ' + j);
      }
    }
  }
});

test('pointAtDistance wraps, interpolates and reports the segment', () => {
  const t = E.generateTrackCircuit(2026);
  const p0 = E.pointAtDistance(t, 0);
  near(p0.x, t.xs[0], 1e-9);
  near(p0.y, t.ys[0], 1e-9);
  assert.equal(p0.index, 0);
  const mid = E.pointAtDistance(t, t.cum[10] + t.segLen[10] / 2);
  near(mid.x, (t.xs[10] + t.xs[11]) / 2, 1e-9);
  near(mid.y, (t.ys[10] + t.ys[11]) / 2, 1e-9);
  assert.equal(mid.index, 10);
  assert.equal(mid.heading, t.headings[10]);
  assert.equal(mid.curvature, t.curvature[10]);
  const wrapped = E.pointAtDistance(t, t.length + 5);
  const plain = E.pointAtDistance(t, 5);
  near(wrapped.x, plain.x, 1e-6);
  const behind = E.pointAtDistance(t, -5);
  const same = E.pointAtDistance(t, t.length - 5);
  near(behind.x, same.x, 1e-6);
  near(behind.y, same.y, 1e-6);
  const last = E.pointAtDistance(t, t.length - 0.001);
  assert.equal(last.index, t.count - 1);
  assert.equal(E.pointAtDistance(t, t.cum[t.count - 1]).index, t.count - 1);
});

test('wrapDistance folds into zero to length', () => {
  const t = E.generateTrackCircuit(2026);
  near(E.wrapDistance(t, t.length + 3), 3, 1e-9);
  near(E.wrapDistance(t, -3), t.length - 3, 1e-9);
  near(E.wrapDistance(t, 12), 12, 1e-12);
});

test('there are eight evenly spaced gates and gate zero is the start line', () => {
  const t = E.generateTrackCircuit(2026);
  assert.equal(t.gates.length, 8);
  assert.equal(t.gates[0].s, 0);
  near(t.gates[0].box.cx, t.xs[0], 1e-9);
  for (let g = 0; g < 8; g++) {
    assert.equal(t.gates[g].id, g);
    assert.equal(t.gates[g].kind, 'gate');
    near(t.gates[g].s, (g / 8) * t.length, 1e-9);
    const p = E.pointAtDistance(t, t.gates[g].s);
    near(t.gates[g].box.angle, p.heading, 1e-12);
    near(t.gates[g].box.cx, p.x, 1e-9);
    near(t.gates[g].box.hy, t.halfWidth + 2, 1e-12);
    near(t.gates[g].box.hx, 1.5, 1e-12);
  }
  const custom = E.generateTrackCircuit(2026, { gateCount: 5, cellCount: 3, pylonCount: 2 });
  assert.equal(custom.gates.length, 5);
  assert.equal(custom.cells.length, 3);
  assert.equal(custom.pylons.length, 2);
});

test('cells sit near the racing line and pylons toward the edges', () => {
  const t = E.generateTrackCircuit(2026);
  assert.equal(t.cells.length, 24);
  assert.equal(t.pylons.length, 14);
  t.cells.forEach((c) => {
    const n = E.nearestOnTrack(t, c.box.cx, c.box.cy);
    assert.ok(n.dist <= t.halfWidth * 0.6 + 0.5, 'cell offset ' + n.dist);
    assert.equal(c.kind, 'cell');
    assert.ok(c.s >= 0 && c.s < t.length);
  });
  t.pylons.forEach((p) => {
    const n = E.nearestOnTrack(t, p.box.cx, p.box.cy);
    assert.ok(n.dist >= t.halfWidth * 0.45 - 0.5 && n.dist <= t.halfWidth * 0.8 + 0.5, 'pylon offset ' + n.dist);
    assert.equal(p.kind, 'pylon');
    assert.ok(p.s >= 0 && p.s < t.length);
  });
  const sides = new Set(t.pylons.map((p) => Math.sign(E.nearestOnTrack(t, p.box.cx, p.box.cy).offset)));
  assert.equal(sides.size, 2);
});

test('nearestOnTrack finds the closest point, distance, arc length and side', () => {
  const t = E.generateTrackCircuit(2026);
  const p = E.pointAtDistance(t, 400);
  const on = E.nearestOnTrack(t, p.x, p.y);
  near(on.dist, 0, 1e-6);
  near(on.s, 400, 1e-6);
  near(on.offset, 0, 1e-6);
  const left = E.nearestOnTrack(t, p.x - Math.sin(p.heading) * 5, p.y + Math.cos(p.heading) * 5);
  near(left.dist, 5, 0.05);
  near(left.offset, 5, 0.05);
  const right = E.nearestOnTrack(t, p.x + Math.sin(p.heading) * 5, p.y - Math.cos(p.heading) * 5);
  near(right.offset, -5, 0.05);
  const ahead = E.nearestOnTrack(t, E.pointAtDistance(t, 600).x, E.pointAtDistance(t, 600).y);
  near(ahead.s, 600, 1e-6);
  assert.ok(ahead.index > on.index);
  const far = E.nearestOnTrack(t, 0, 0);
  assert.ok(far.dist > 10);
});

test('nearestOnTrack interpolates inside a segment', () => {
  const t = E.generateTrackCircuit(2026);
  const i = 40;
  const mx = (t.xs[i] + t.xs[i + 1]) / 2;
  const my = (t.ys[i] + t.ys[i + 1]) / 2;
  const n = E.nearestOnTrack(t, mx, my);
  assert.equal(n.index, i);
  near(n.t, 0.5, 1e-9);
  near(n.s, t.cum[i] + t.segLen[i] / 2, 1e-9);
});

test('track surface is asphalt and kerb inside the limit and grass beyond it', () => {
  const t = E.generateTrackCircuit(2026);
  const p = E.pointAtDistance(t, 200);
  const nx = -Math.sin(p.heading);
  const ny = Math.cos(p.heading);
  const centre = E.trackSurface(t, p.x, p.y);
  assert.equal(centre.onRoad, true);
  assert.equal(centre.gripScale, 1);
  assert.equal(centre.extraDrag, 0);
  const kerb = E.trackSurface(t, p.x + nx * (t.halfWidth + 1), p.y + ny * (t.halfWidth + 1));
  assert.equal(kerb.onRoad, true);
  const grass = E.trackSurface(t, p.x + nx * (t.halfWidth + 2), p.y + ny * (t.halfWidth + 2));
  assert.equal(grass.onRoad, false);
  assert.equal(grass.gripScale, 0.62);
  assert.equal(grass.extraDrag, 7);
  assert.ok(grass.near.dist > t.halfWidth);
});

/* ---------------------------------------------------------------- */
/* distance fields, projection and rasterizer                        */
/* ---------------------------------------------------------------- */

const track = E.generateTrackCircuit(2026);
const fields = E.buildTrackFields(track, 128, 60);

test('track fields store the distance to the centre line and the nearest arc length', () => {
  assert.equal(fields.size, 128);
  assert.equal(fields.dist.length, 128 * 128);
  const p = E.pointAtDistance(track, 700);
  const d = E.fieldBilinear(fields, p.x, p.y);
  assert.ok(d < fields.cell, 'distance on the line ' + d);
  const off = E.fieldBilinear(fields, p.x - Math.sin(p.heading) * 20, p.y + Math.cos(p.heading) * 20);
  near(off, 20, 2.5);
  assert.equal(E.fieldBilinear(fields, 0, 0) > 0, true);
  let max = 0;
  for (let i = 0; i < fields.dist.length; i++) max = Math.max(max, fields.dist[i]);
  assert.equal(max, fields.reach);
  assert.ok(fields.originX < -track.radius || fields.originX < -200);
});

test('fieldBilinear interpolates between grid cells and clamps at the edges', () => {
  const tiny = {
    size: 2, originX: 0, originY: 0, cell: 10,
    dist: Float32Array.from([0, 10, 20, 30]), s: new Float32Array(4)
  };
  near(E.fieldBilinear(tiny, 5, 5), 0, 1e-6);
  near(E.fieldBilinear(tiny, 15, 5), 10, 1e-6);
  near(E.fieldBilinear(tiny, 10, 5), 5, 1e-6);
  near(E.fieldBilinear(tiny, 5, 10), 10, 1e-6);
  near(E.fieldBilinear(tiny, 10, 10), 15, 1e-6);
  near(E.fieldBilinear(tiny, -100, -100), 0, 1e-6);
  near(E.fieldBilinear(tiny, 100, 100), 30, 1e-6);
});

function sceneFor(mode, w, h, extra) {
  const pyramid = E.buildMipmapPyramid(E.generateDetailTexture(128, 5));
  const p = E.pointAtDistance(track, 300);
  return Object.assign({
    cameraX: p.x - 7 * Math.cos(p.heading),
    cameraY: p.y - 7 * Math.sin(p.heading),
    cameraHeading: p.heading,
    cameraHeight: 3.2,
    focal: (w / 2) / Math.tan(39 * Math.PI / 180),
    horizonY: h * 0.42,
    pyramid: pyramid,
    fields: fields,
    palette: {
      skyTop: [10, 20, 30], skyHorizon: [200, 210, 220], fog: [210, 205, 190],
      grass: [60, 160, 60], asphalt: [40, 40, 50], kerbA: [220, 40, 20], kerbB: [240, 240, 240], dash: [250, 250, 250]
    },
    mode: mode,
    textureScale: 1 / 24,
    halfWidth: track.halfWidth,
    kerbWidth: track.kerbWidth,
    fogDistance: 420
  }, extra || {});
}

test('projectGroundPoint puts the road ahead at the middle and respects depth and height', () => {
  const scene = { cameraX: 0, cameraY: 0, cameraHeading: 0, cameraHeight: 3, focal: 200, horizonY: 100 };
  const ahead = E.projectGroundPoint(scene, 400, 20, 0, 0);
  near(ahead.x, 200, 1e-9);
  near(ahead.y, 100 + 3 * 200 / 20, 1e-9);
  near(ahead.depth, 20, 1e-9);
  near(ahead.scale, 10, 1e-9);
  const high = E.projectGroundPoint(scene, 400, 20, 0, 3);
  near(high.y, 100, 1e-9);
  const right = E.projectGroundPoint(scene, 400, 20, -4, 0);
  near(right.x, 200 + 4 * 10, 1e-9);
  const left = E.projectGroundPoint(scene, 400, 20, 4, 0);
  near(left.x, 200 - 4 * 10, 1e-9);
  assert.equal(E.projectGroundPoint(scene, 400, -5, 0, 0), null);
  assert.equal(E.projectGroundPoint(scene, 400, 0.4, 0, 0), null);
  assert.ok(E.projectGroundPoint(scene, 400, 0.6, 0, 0));
  const turned = { cameraX: 0, cameraY: 0, cameraHeading: Math.PI / 2, cameraHeight: 3, focal: 200, horizonY: 100 };
  const north = E.projectGroundPoint(turned, 400, 0, 20, 0);
  near(north.x, 200, 1e-9);
  near(north.depth, 20, 1e-9);
  const flat = E.projectGroundPoint(scene, 400, 20, 0);
  near(flat.y, ahead.y, 1e-9);
});

test('the rasterizer fills sky above the horizon and ground below with exact row counts', () => {
  const W = 64;
  const H = 36;
  const target = E.createRenderTarget(W, H);
  const stats = E.renderGround(target, sceneFor(E.SAMPLE_TRILINEAR, W, H));
  const horizon = H * 0.42;
  const skyRows = Math.ceil(horizon - 0.501);
  assert.equal(stats.skyRows, skyRows);
  assert.equal(stats.groundPixels, (H - skyRows) * W);
  for (let y = 0; y < H; y++) {
    const lod = target.lod[y * W + 10];
    if (y < skyRows) assert.equal(lod, E.NO_LOD);
    else assert.ok(lod > E.NO_LOD);
  }
  assert.equal(target.rgba[3], 255);
  assert.ok(target.rgba[0] > 5 && target.rgba[0] < 40);
  const topSky = target.rgba[0];
  const lowSky = target.rgba[((skyRows - 1) * W) * 4];
  assert.ok(lowSky > topSky + 100);
});

test('lambda grows toward the horizon and matches the analytic footprint', () => {
  const W = 64;
  const H = 36;
  const target = E.createRenderTarget(W, H);
  const scene = sceneFor(E.SAMPLE_TRILINEAR, W, H);
  const stats = E.renderGround(target, scene);
  let previous = -Infinity;
  for (let y = H - 1; y >= 16; y--) {
    const lod = target.lod[y * W + 32];
    assert.ok(lod > previous, 'row ' + y);
    previous = lod;
  }
  assert.ok(stats.lodMax > stats.lodMean && stats.lodMean > stats.lodMin);
  near(stats.lodMean, stats.lodSum / stats.groundPixels, 1e-9);
  const y = H - 1;
  const dy = y + 0.5 - scene.horizonY;
  const z = scene.cameraHeight * scene.focal / dy;
  const dzdy = -z / dy;
  const ts = scene.textureScale;
  const xPix = 32;
  const dx = xPix + 0.5 - W / 2;
  const fx = Math.cos(scene.cameraHeading);
  const fy = Math.sin(scene.cameraHeading);
  const rx = Math.sin(scene.cameraHeading);
  const ry = -Math.cos(scene.cameraHeading);
  const expected = E.computeMipLevelFromJacobian(
    rx * (z / scene.focal) * ts, ry * (z / scene.focal) * ts,
    (fx + rx * dx / scene.focal) * dzdy * ts, (fy + ry * dx / scene.focal) * dzdy * ts, 128, 128);
  near(target.lod[y * W + xPix], expected, 1e-4);
});

test('the rasterizer is deterministic and the mode changes the picture', () => {
  const W = 64;
  const H = 36;
  const a = E.createRenderTarget(W, H);
  const b = E.createRenderTarget(W, H);
  const c = E.createRenderTarget(W, H);
  const d = E.createRenderTarget(W, H);
  E.renderGround(a, sceneFor(E.SAMPLE_TRILINEAR, W, H));
  E.renderGround(b, sceneFor(E.SAMPLE_TRILINEAR, W, H));
  E.renderGround(c, sceneFor(E.SAMPLE_POINT, W, H));
  E.renderGround(d, sceneFor(E.SAMPLE_BILINEAR, W, H));
  assert.deepEqual(Array.from(a.rgba), Array.from(b.rgba));
  assert.notDeepEqual(Array.from(a.rgba), Array.from(c.rgba));
  assert.notDeepEqual(Array.from(c.rgba), Array.from(d.rgba));
  assert.notDeepEqual(Array.from(a.rgba), Array.from(d.rgba));
  assert.deepEqual(Array.from(a.lod), Array.from(c.lod));
});

function rowRoughness(target, y0, y1) {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < target.width; x++) {
      const i = (y * target.width + x) * 4;
      sum += Math.abs(target.rgba[i + 1] - target.rgba[i - 3]);
      n++;
    }
  }
  return sum / n;
}

test('trilinear calms the distance where point sampling shimmers', () => {
  const W = 160;
  const H = 90;
  const point = E.createRenderTarget(W, H);
  const tri = E.createRenderTarget(W, H);
  const off = { cameraX: -300, cameraY: -300, cameraHeading: 0.7 };
  E.renderGround(point, sceneFor(E.SAMPLE_POINT, W, H, off));
  E.renderGround(tri, sceneFor(E.SAMPLE_TRILINEAR, W, H, off));
  const horizon = Math.ceil(H * 0.42);
  const farPoint = rowRoughness(point, horizon + 1, horizon + 8);
  const farTri = rowRoughness(tri, horizon + 1, horizon + 8);
  assert.ok(farPoint > farTri * 1.5, 'point ' + farPoint + ' trilinear ' + farTri);
});

test('the road paints as asphalt under the car and grass far off the track', () => {
  const W = 96;
  const H = 54;
  const target = E.createRenderTarget(W, H);
  E.renderGround(target, sceneFor(E.SAMPLE_BILINEAR, W, H));
  const i = ((H - 4) * W + 48) * 4;
  assert.ok(target.rgba[i] < 90 && target.rgba[i + 2] < 100, 'road pixel ' + target.rgba[i] + ',' + target.rgba[i + 2]);
  const off = E.createRenderTarget(W, H);
  E.renderGround(off, sceneFor(E.SAMPLE_BILINEAR, W, H, { cameraX: 0, cameraY: 0 }));
  const j = ((H - 4) * W + 48) * 4;
  assert.ok(off.rgba[j + 1] > off.rgba[j] + 30, 'grass pixel green');
});

test('fog pulls the far ground toward the fog colour', () => {
  const W = 96;
  const H = 54;
  const clear = E.createRenderTarget(W, H);
  const foggy = E.createRenderTarget(W, H);
  const far = { cameraX: 0, cameraY: 0 };
  E.renderGround(clear, sceneFor(E.SAMPLE_BILINEAR, W, H, Object.assign({ fogDistance: 100000 }, far)));
  E.renderGround(foggy, sceneFor(E.SAMPLE_BILINEAR, W, H, Object.assign({ fogDistance: 30 }, far)));
  const y = Math.ceil(H * 0.42) + 1;
  const i = (y * W + 48) * 4;
  assert.ok(Math.abs(foggy.rgba[i] - 210) < Math.abs(clear.rgba[i] - 210));
  assert.ok(Math.abs(foggy.rgba[i + 1] - 205) < Math.abs(clear.rgba[i + 1] - 205));
  assert.ok(Math.abs(foggy.rgba[i + 2] - 190) < Math.abs(clear.rgba[i + 2] - 190));
});

test('heat colours map lambda zero, middle and the top level to the ramp', () => {
  const ramp = [[0, 0, 100], [100, 100, 0], [200, 0, 0]];
  const out = [0, 0, 0];
  assert.deepEqual(E.heatColor(0, ramp, out), [0, 0, 100]);
  assert.deepEqual(E.heatColor(0.5, ramp, out), [100, 100, 0]);
  assert.deepEqual(E.heatColor(1, ramp, out), [200, 0, 0]);
  assert.deepEqual(E.heatColor(0.25, ramp, out), [50, 50, 50]);
  assert.deepEqual(E.heatColor(0.75, ramp, out), [150, 50, 0]);
  assert.deepEqual(E.heatColor(-4, ramp, out), [0, 0, 100]);
  assert.deepEqual(E.heatColor(9, ramp, out), [200, 0, 0]);
});

test('the heatmap colours ground by lod and leaves the sky neutral', () => {
  const target = E.createRenderTarget(4, 1);
  target.lod.set([E.NO_LOD, 0, 4, 20]);
  const ramp = [[0, 0, 100], [100, 100, 0], [200, 0, 0]];
  const heat = E.renderHeatmap(target, ramp, [9, 9, 9], 8);
  assert.deepEqual(Array.from(heat.slice(0, 4)), [9, 9, 9, 255]);
  assert.deepEqual(Array.from(heat.slice(4, 8)), [0, 0, 100, 255]);
  assert.deepEqual(Array.from(heat.slice(8, 12)), [100, 100, 0, 255]);
  assert.deepEqual(Array.from(heat.slice(12, 16)), [200, 0, 0, 255]);
});

test('the split composite shows the scene left of the divider and the heatmap right of it', () => {
  const W = 10;
  const H = 2;
  const target = E.createRenderTarget(W, H);
  for (let i = 0; i < W * H; i++) {
    target.rgba[i * 4] = 10;
    target.heat[i * 4] = 200;
  }
  const out = new Uint8ClampedArray(W * H * 4);
  const splitX = E.compositeSplit(target, out, 0.4, [1, 2, 3]);
  assert.equal(splitX, 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (x < 4) assert.equal(out[o], 10);
      else if (x === 4) assert.deepEqual(Array.from(out.slice(o, o + 3)), [1, 2, 3]);
      else assert.equal(out[o], 200);
      assert.equal(out[o + 3], 255);
    }
  }
  E.compositeSplit(target, out, 0, [1, 2, 3]);
  assert.equal(out[0], 200);
  assert.equal(out[4 * 4], 200);
  E.compositeSplit(target, out, 1, [1, 2, 3]);
  assert.equal(out[(W - 1) * 4], 10);
  assert.equal(out[0], 10);
  E.compositeSplit(target, out, 5, [1, 2, 3]);
  assert.equal(out[(W - 1) * 4], 10);
});

/* ---------------------------------------------------------------- */
/* stepper and frame stats                                           */
/* ---------------------------------------------------------------- */

test('the fixed stepper turns frame time into whole steps and keeps the remainder', () => {
  const s = E.createFixedStepper(0.01, 5);
  let calls = 0;
  const dts = [];
  assert.equal(s.advance(0.035, (dt) => { calls++; dts.push(dt); }), 3);
  assert.equal(calls, 3);
  assert.deepEqual(dts, [0.01, 0.01, 0.01]);
  near(s.accumulator, 0.005, 1e-12);
  near(s.alpha(), 0.5, 1e-9);
  assert.equal(s.advance(0.005, () => {}), 1);
  assert.equal(s.advance(0, () => {}), 0);
  assert.equal(s.advance(-1, () => {}), 0);
});

test('the fixed stepper caps the catch up and drops the rest', () => {
  const s = E.createFixedStepper(0.01, 5);
  assert.equal(s.advance(1, () => {}), 5);
  assert.equal(s.accumulator, 0);
  assert.equal(s.advance(0.0501, () => {}), 5);
  assert.equal(s.accumulator, 0);
  const t = E.createFixedStepper(0.01, 5);
  assert.equal(t.advance(0.0401, () => {}), 4);
  assert.ok(t.accumulator < 0.001);
});

test('the fixed stepper is exact at the 60 and 120 hertz ratio', () => {
  const s = E.createFixedStepper(E.FIXED_DT, 8);
  assert.equal(s.advance(1 / 60, () => {}), 2);
  assert.equal(s.advance(1 / 60, () => {}), 2);
  assert.equal(s.advance(1 / 120, () => {}), 1);
});

test('frame stats keep a rolling window and report mean, worst and percentiles', () => {
  const f = E.createFrameStats(4);
  assert.equal(f.mean(), 0);
  assert.equal(f.percentile(0.95), 0);
  assert.equal(f.worst(), 0);
  [1, 2, 3].forEach((v) => f.push(v));
  assert.deepEqual(f.ordered(), [1, 2, 3]);
  near(f.mean(), 2, 1e-12);
  [4, 5, 6].forEach((v) => f.push(v));
  assert.equal(f.count, 4);
  assert.deepEqual(f.ordered(), [3, 4, 5, 6]);
  near(f.mean(), 4.5, 1e-12);
  assert.equal(f.worst(), 6);
  assert.equal(f.percentile(0.95), 6);
  assert.equal(f.percentile(0), 3);
  assert.equal(f.percentile(0.5), 5);
});

/* ---------------------------------------------------------------- */
/* inputs and ghost replay                                           */
/* ---------------------------------------------------------------- */

test('quantizeInput clamps and snaps to the packed grid', () => {
  const q = E.quantizeInput({ steer: 2, throttle: 3, brake: -1, drift: 1 });
  assert.deepEqual(q, { steer: 1, throttle: 1, brake: 0, drift: true });
  const m = E.quantizeInput({ steer: 0.5, throttle: 0.5, brake: 0.25, drift: 0 });
  near(m.steer, 64 / 127, 1e-12);
  near(m.throttle, 8 / 15, 1e-12);
  near(m.brake, 4 / 15, 1e-12);
  assert.equal(m.drift, false);
  assert.deepEqual(E.quantizeInput({}), { steer: 0, throttle: 0, brake: 0, drift: false });
  assert.deepEqual(E.quantizeInput(E.quantizeInput({ steer: 0.123, throttle: 0.77, brake: 0.31, drift: true })), E.quantizeInput({ steer: 0.123, throttle: 0.77, brake: 0.31, drift: true }));
});

test('packInput and unpackInput round trip every steering step and flag', () => {
  for (let s = -127; s <= 127; s++) {
    for (const drift of [false, true]) {
      const input = E.quantizeInput({ steer: s / 127, throttle: (Math.abs(s) % 16) / 15, brake: ((s + 200) % 16) / 15, drift: drift });
      const packed = E.packInput(input);
      assert.ok(packed >= 0 && packed < (1 << 17));
      assert.deepEqual(E.unpackInput(packed), input);
    }
  }
  assert.equal(E.packInput({ steer: 0, throttle: 0, brake: 0, drift: false }), 127);
  assert.equal(E.packInput({ steer: 1, throttle: 1, brake: 1, drift: true }), 254 | (15 << 8) | (15 << 12) | (1 << 16));
  assert.equal(E.packInput({ steer: -1, throttle: 0, brake: 0, drift: false }), 0);
  assert.equal(E.packInput({}), 127);
});

test('ghost replays survive a round trip and run length encoding shrinks repeats', () => {
  const frames = [];
  for (let i = 0; i < 2000; i++) frames.push(E.packInput({ steer: Math.floor(i / 400) / 10, throttle: 1, brake: 0, drift: i > 1500 }));
  const bytes = E.encodeGhostReplay(1234567, frames);
  assert.ok(bytes.length < 80, 'bytes ' + bytes.length);
  const back = E.decodeGhostReplay(bytes);
  assert.equal(back.seed, 1234567);
  assert.deepEqual(back.frames, frames);
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x4C, 0x5A, 0x47, 0x31]);
  const noisy = [];
  const rng = E.mulberry32(1);
  for (let i = 0; i < 300; i++) noisy.push(Math.floor(rng() * 131071));
  assert.deepEqual(E.decodeGhostReplay(E.encodeGhostReplay(5, noisy)).frames, noisy);
  const empty = E.decodeGhostReplay(E.encodeGhostReplay(9, []));
  assert.deepEqual(empty, { seed: 9, frames: [] });
});

test('ghost encoding emits exactly one run per change', () => {
  const bytes = E.encodeGhostReplay(1, [5, 5, 5, 7, 7, 5]);
  assert.deepEqual(Array.from(bytes), [0x4C, 0x5A, 0x47, 0x31, 1, 6, 3, 3, 5, 2, 7, 1, 5]);
});

test('ghost numbers use variable length encoding up to 32 bits', () => {
  const big = E.encodeGhostReplay(4294967295, [131071, 0]);
  const back = E.decodeGhostReplay(big);
  assert.equal(back.seed, 4294967295);
  assert.deepEqual(back.frames, [131071, 0]);
  const mid = E.decodeGhostReplay(E.encodeGhostReplay(300, [127, 128, 16383, 16384]));
  assert.equal(mid.seed, 300);
  assert.deepEqual(mid.frames, [127, 128, 16383, 16384]);
});

test('corrupt ghost data is rejected with a clear error', () => {
  const good = E.encodeGhostReplay(7, [1, 1, 2, 3]);
  const bad = Uint8Array.from(good);
  bad[0] = 0;
  assert.throws(() => E.decodeGhostReplay(bad), /not a ghost replay/);
  assert.throws(() => E.decodeGhostReplay(good.slice(0, good.length - 1)), /truncated/);
  assert.throws(() => E.decodeGhostReplay(good.slice(0, 5)), /truncated/);
  assert.throws(() => E.decodeGhostReplay(Uint8Array.from(Array.from(good).concat([9]))), /trailing/);
  const lie = Uint8Array.from([0x4C, 0x5A, 0x47, 0x31, 1, 5, 1, 3, 5]);
  assert.throws(() => E.decodeGhostReplay(lie), /shorter/);
  const over = Uint8Array.from([0x4C, 0x5A, 0x47, 0x31, 1, 2, 1, 5, 1]);
  assert.throws(() => E.decodeGhostReplay(over), RangeError);
  const long = Uint8Array.from([0x4C, 0x5A, 0x47, 0x31, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
  assert.throws(() => E.decodeGhostReplay(long), /oversized/);
  assert.throws(() => E.decodeGhostReplay(Uint8Array.from([0x4C, 0x5A, 0x47])), RangeError);
});

test('base64 helpers round trip arbitrary bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255, 128, 64]);
  const text = E.bytesToBase64(bytes);
  assert.equal(typeof text, 'string');
  assert.deepEqual(Array.from(E.base64ToBytes(text)), Array.from(bytes));
  assert.equal(E.bytesToBase64(Uint8Array.from([72, 105])), 'SGk=');
  assert.deepEqual(Array.from(E.base64ToBytes('SGk=')), [72, 105]);
});

/* ---------------------------------------------------------------- */
/* race rules                                                        */
/* ---------------------------------------------------------------- */

test('a fresh race starts in the countdown behind the start line', () => {
  const race = E.createRace(2026);
  assert.equal(race.phase, 'countdown');
  assert.equal(race.countdown, 3);
  assert.equal(race.lap, 0);
  assert.equal(race.nextGate, 1);
  assert.equal(race.totalLaps, 3);
  assert.equal(race.entities.length, 8 + 24 + 14);
  assert.equal(race.car.speed, 0);
  const start = E.nearestOnTrack(race.track, race.car.x, race.car.y);
  near(start.s, race.track.length - 7, 0.01);
  near(race.car.heading, E.pointAtDistance(race.track, race.track.length - 7).heading, 1e-12);
  assert.equal(E.createRace(2026, { laps: 1 }).totalLaps, 1);
});

test('the countdown holds the car still, then releases it exactly once', () => {
  const race = E.createRace(2026);
  const events = [];
  for (let i = 0; i < 340; i++) events.push(...E.stepRace(race, GAS, E.FIXED_DT));
  assert.equal(race.phase, 'countdown');
  assert.equal(race.car.speed, 0);
  near(race.countdown, 3 - 340 / 120, 1e-9);
  assert.equal(events.length, 0);
  for (let i = 0; i < 30; i++) events.push(...E.stepRace(race, GAS, E.FIXED_DT));
  assert.equal(race.phase, 'running');
  assert.equal(race.countdown, 0);
  assert.equal(events.filter((e) => e.type === 'go').length, 1);
  assert.ok(race.car.speed > 0);
  assert.ok(race.time > 0 && race.time < 0.2);
});

test('every step is recorded as one packed input frame', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 10; i++) E.stepRace(race, { steer: 0.5, throttle: 1, brake: 0, drift: false }, E.FIXED_DT);
  assert.equal(race.tick, 10);
  assert.equal(race.inputLog.length, 10);
  assert.deepEqual(E.unpackInput(race.inputLog[3]), E.quantizeInput({ steer: 0.5, throttle: 1 }));
});

test('the pace car laps the circuit in order and finishes three laps', () => {
  const race = E.createRace(2026);
  const gates = [];
  const types = {};
  for (let i = 0; i < 120 * 200 && race.phase !== 'finished'; i++) {
    const events = E.stepRace(race, E.computeAIInput(race), E.FIXED_DT);
    events.forEach((e) => {
      types[e.type] = (types[e.type] || 0) + 1;
      if (e.type === 'gate') gates.push(e.id);
    });
  }
  assert.equal(race.phase, 'finished');
  assert.equal(race.lap, 3);
  assert.deepEqual(gates, [1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(types.lap, 3);
  assert.equal(types.finish, 1);
  assert.equal(race.lapTimes.length, 3);
  near(race.lapTimes.reduce((a, b) => a + b, 0), race.time, 1e-6);
  race.lapTimes.forEach((t) => assert.ok(t > 30 && t < 60));
});

test('crossing the line early does not count a lap', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.phase, 'running');
  const g = race.track.gates[0].box;
  race.car.x = g.cx;
  race.car.y = g.cy;
  race.car.heading = g.angle;
  const events = E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(events.filter((e) => e.type === 'gate').length, 0);
  assert.equal(race.lap, 0);
  assert.equal(race.nextGate, 1);
});

test('gates must be taken in order', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  const g3 = race.track.gates[3].box;
  race.car.x = g3.cx;
  race.car.y = g3.cy;
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.nextGate, 1);
  const g1 = race.track.gates[1].box;
  race.car.x = g1.cx;
  race.car.y = g1.cy;
  const events = E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.nextGate, 2);
  assert.deepEqual(events.map((e) => e.type), ['gate']);
});

function parkOn(race, entity) {
  race.car.x = entity.box.cx;
  race.car.y = entity.box.cy;
  race.car.vx = 0;
  race.car.vy = 0;
}

test('driving over an energy cell collects it once and adds boost charge', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  const cell = race.entities.find((e) => e.kind === 'cell');
  parkOn(race, cell);
  const events = E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.cells, 1);
  assert.equal(cell.active, false);
  near(race.car.boostCharge, 0.34, 1e-9);
  assert.equal(events.filter((e) => e.type === 'cell').length, 1);
  parkOn(race, cell);
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.cells, 1);
  const second = race.entities.filter((e) => e.kind === 'cell')[1];
  race.car.boostCharge = 0.9;
  parkOn(race, second);
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.car.boostCharge, 1);
});

test('hitting a pylon scrubs speed, pushes the car out and has a cooldown', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  const pylon = race.entities.find((e) => e.kind === 'pylon');
  race.car.heading = pylon.box.angle;
  race.car.x = pylon.box.cx - Math.cos(race.car.heading) * 2.3;
  race.car.y = pylon.box.cy - Math.sin(race.car.heading) * 2.3;
  race.car.vx = Math.cos(race.car.heading) * 30;
  race.car.vy = Math.sin(race.car.heading) * 30;
  const events = E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.pylonHits, 1);
  assert.equal(events.filter((e) => e.type === 'pylon').length, 1);
  assert.ok(race.car.speed < 12, 'speed after hit ' + race.car.speed);
  const rel = (race.car.x - pylon.box.cx) * Math.cos(race.car.heading) + (race.car.y - pylon.box.cy) * Math.sin(race.car.heading);
  assert.ok(rel < -2.0, 'pushed back ' + rel);
  race.car.x = pylon.box.cx;
  race.car.y = pylon.box.cy;
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.pylonHits, 1);
  for (let i = 0; i < 60; i++) E.stepRace(race, COAST, E.FIXED_DT);
  race.car.x = pylon.box.cx;
  race.car.y = pylon.box.cy;
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.pylonHits, 2);
  assert.equal(pylon.active, true);
});

test('pylon pushes also work when the car arrives from the side and from behind', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  const pylon = race.entities.find((e) => e.kind === 'pylon');
  race.car.heading = pylon.box.angle;
  race.car.x = pylon.box.cx + Math.cos(race.car.heading) * 2.3;
  race.car.y = pylon.box.cy + Math.sin(race.car.heading) * 2.3;
  race.car.vx = -Math.cos(race.car.heading) * 10;
  race.car.vy = -Math.sin(race.car.heading) * 10;
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.equal(race.pylonHits, 1);
  const rel = (race.car.x - pylon.box.cx) * Math.cos(race.car.heading) + (race.car.y - pylon.box.cy) * Math.sin(race.car.heading);
  assert.ok(rel > 2.0, 'pushed forward ' + rel);
});

test('the broadphase prunes most entities before the narrow phase', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, GAS, E.FIXED_DT);
  assert.ok(race.lastBroadphase < race.entities.length / 4);
  assert.ok(race.lastNarrowphase <= race.lastBroadphase);
  const b = race.queryBox;
  assert.ok(b.maxX > b.minX && b.maxY > b.minY);
  parkOn(race, race.entities.find((e) => e.kind === 'pylon'));
  E.stepRace(race, COAST, E.FIXED_DT);
  assert.ok(race.lastBroadphase >= 1);
  assert.ok(race.lastNarrowphase >= 1);
});

test('after the finish the car brakes to a stop and ignores the sticks', () => {
  const race = E.runAIRace(2026, 200);
  assert.equal(race.phase, 'finished');
  for (let i = 0; i < 120 * 12; i++) E.stepRace(race, GAS, E.FIXED_DT);
  assert.ok(race.car.speed < 12);
  const timeAtFinish = race.time;
  E.stepRace(race, GAS, E.FIXED_DT);
  assert.equal(race.time, timeAtFinish);
});

test('the race clock only runs while racing', () => {
  const race = E.createRace(2026);
  for (let i = 0; i < 300; i++) E.stepRace(race, GAS, E.FIXED_DT);
  assert.equal(race.time, 0);
  for (let i = 0; i < 100; i++) E.stepRace(race, GAS, E.FIXED_DT);
  near(race.time, (400 - 361) * E.FIXED_DT, E.FIXED_DT * 2);
});

test('leaving the road puts the car on grass and slows it', () => {
  const road = E.createRace(2026);
  const turf = E.createRace(2026);
  for (let i = 0; i < 400; i++) {
    E.stepRace(road, COAST, E.FIXED_DT);
    E.stepRace(turf, COAST, E.FIXED_DT);
  }
  road.car.vx = 30;
  turf.car.vx = 30;
  const p = E.pointAtDistance(turf.track, 600);
  turf.car.x = p.x - Math.sin(p.heading) * 40;
  turf.car.y = p.y + Math.cos(p.heading) * 40;
  turf.car.heading = p.heading;
  const q = E.pointAtDistance(road.track, 600);
  road.car.x = q.x;
  road.car.y = q.y;
  road.car.heading = q.heading;
  road.car.vx = Math.cos(q.heading) * 30;
  road.car.vy = Math.sin(q.heading) * 30;
  turf.car.vx = Math.cos(p.heading) * 30;
  turf.car.vy = Math.sin(p.heading) * 30;
  for (let i = 0; i < 120; i++) {
    E.stepRace(road, COAST, E.FIXED_DT);
    E.stepRace(turf, COAST, E.FIXED_DT);
  }
  assert.equal(road.onRoad, true);
  assert.equal(turf.onRoad, false);
  assert.ok(turf.car.speed < road.car.speed - 4);
});

test('the race state hash is stable for equal states and sensitive to each field', () => {
  const a = E.createRace(2026);
  const b = E.createRace(2026);
  assert.equal(E.hashRaceState(a), E.hashRaceState(b));
  assert.ok(Number.isInteger(E.hashRaceState(a)) && E.hashRaceState(a) >= 0);
  const base = E.hashRaceState(a);
  ['x', 'y', 'heading', 'vx', 'vy', 'omega', 'boostCharge', 'heat'].forEach((field) => {
    const r = E.createRace(2026);
    r.car[field] += 0.5;
    assert.notEqual(E.hashRaceState(r), base, field);
  });
  ['time', 'cells', 'pylonHits', 'lap', 'tick'].forEach((field) => {
    const r = E.createRace(2026);
    r[field] += 1;
    assert.notEqual(E.hashRaceState(r), base, field);
  });
});

test('a recorded run replays to the identical state from its inputs alone', () => {
  const live = E.createRace(2026);
  const rng = E.mulberry32(21);
  for (let i = 0; i < 120 * 40; i++) {
    const input = i % 200 < 100
      ? E.computeAIInput(live)
      : { steer: rng() * 2 - 1, throttle: rng(), brake: rng() < 0.2 ? 1 : 0, drift: rng() < 0.3 };
    E.stepRace(live, input, E.FIXED_DT);
  }
  const bytes = E.encodeGhostReplay(live.seed, live.inputLog);
  const decoded = E.decodeGhostReplay(bytes);
  const ghost = E.replayRace(decoded.seed, decoded.frames);
  assert.equal(ghost.tick, live.tick);
  assert.equal(E.hashRaceState(ghost), E.hashRaceState(live));
  assert.equal(ghost.cells, live.cells);
  assert.equal(ghost.pylonHits, live.pylonHits);
});

test('a full pace car race replays to the same finish time', () => {
  const live = E.runAIRace(7, 200);
  const ghost = E.replayRace(7, live.inputLog);
  assert.equal(ghost.phase, 'finished');
  assert.equal(ghost.time, live.time);
  assert.equal(E.hashRaceState(ghost), E.hashRaceState(live));
  const back = E.decodeGhostReplay(E.encodeGhostReplay(7, live.inputLog));
  assert.deepEqual(back.frames, live.inputLog);
});

/* ---------------------------------------------------------------- */
/* pace car                                                          */
/* ---------------------------------------------------------------- */

test('the pace car finishes three laps on several seeds without leaving the road', () => {
  for (const seed of [1, 7, 99, 2026]) {
    const race = E.runAIRace(seed, 200);
    assert.equal(race.phase, 'finished', 'seed ' + seed);
    assert.ok(race.maxOffset < 4, 'seed ' + seed + ' offset ' + race.maxOffset);
    assert.ok(race.time > 90 && race.time < 150, 'seed ' + seed + ' time ' + race.time);
    assert.ok(race.pylonHits <= 1, 'seed ' + seed + ' hits ' + race.pylonHits);
  }
});

test('runAIRace respects its time budget', () => {
  const race = E.runAIRace(2026, 20);
  assert.notEqual(race.phase, 'finished');
  near(race.tick, 2400, 1);
  assert.ok(race.maxOffset >= 0);
});

function raceAt(s, speed, offset) {
  const race = E.createRace(2026);
  for (let i = 0; i < 400; i++) E.stepRace(race, COAST, E.FIXED_DT);
  const p = E.pointAtDistance(race.track, s);
  race.car.x = p.x - Math.sin(p.heading) * (offset || 0);
  race.car.y = p.y + Math.cos(p.heading) * (offset || 0);
  race.car.heading = p.heading;
  race.car.vx = Math.cos(p.heading) * speed;
  race.car.vy = Math.sin(p.heading) * speed;
  race.car.speed = speed;
  race.progress = E.nearestOnTrack(race.track, race.car.x, race.car.y);
  return race;
}

test('the pace car steers back toward the line from either side', () => {
  const left = E.computeAIInput(raceAt(200, 20, 5));
  assert.ok(left.steer > 0, 'left of the line steers right ' + left.steer);
  const right = E.computeAIInput(raceAt(200, 20, -5));
  assert.ok(right.steer < 0, 'right of the line steers left ' + right.steer);
  const centred = E.computeAIInput(raceAt(200, 20, 0));
  assert.ok(Math.abs(centred.steer) < 0.3);
  assert.ok(Math.abs(left.steer) <= 1);
});

test('the pace car brakes when far too fast and accelerates when slow', () => {
  const slow = E.computeAIInput(raceAt(300, 10, 0));
  assert.equal(slow.throttle, 1);
  assert.equal(slow.brake, 0);
  const fast = E.computeAIInput(raceAt(300, 78, 0));
  assert.equal(fast.throttle, 0);
  assert.ok(fast.brake >= 0.2 && fast.brake <= 1);
  assert.equal(slow.drift, false);
});

test('the pace car holds a speed target with a gentle throttle inside the tolerance band', () => {
  let found = false;
  for (let v = 20; v < 78 && !found; v += 0.5) {
    const input = E.computeAIInput(raceAt(300, v, 0));
    if (input.throttle > 0 && input.throttle < 1) {
      found = true;
      assert.equal(input.throttle, 0.35);
      assert.equal(input.brake, 0);
    }
  }
  assert.ok(found);
});

test('the pace car slows for tighter corners than for straights', () => {
  const race = E.createRace(2026);
  const speedFor = (s) => {
    for (let v = 16; v <= 78; v += 1) {
      const input = E.computeAIInput(raceAt(s, v, 0));
      if (input.throttle < 1) return v;
    }
    return 79;
  };
  let tightS = 0;
  let tightK = 0;
  let wideS = 0;
  let wideK = Infinity;
  for (let s = 0; s < race.track.length; s += 20) {
    const k = Math.abs(E.pointAtDistance(race.track, s).curvature);
    if (k > tightK) { tightK = k; tightS = s - 60; }
    if (k < wideK) { wideK = k; wideS = s - 60; }
  }
  assert.ok(speedFor(tightS) < speedFor(wideS), 'tight ' + speedFor(tightS) + ' wide ' + speedFor(wideS));
});
