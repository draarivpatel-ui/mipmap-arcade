'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

const detail = E.buildMipmapPyramid(E.generateDetailTexture(256, 7));
const FAST = { width: 64, height: 36, horizonY: 9, focal: 48, supersample: 4, frames: 4 };

function flat(value) {
  const data = new Uint8ClampedArray(64 * 64 * 4).fill(value);
  return E.buildMipmapPyramid({ width: 64, height: 64, data: data });
}

const byName = (result, name) => result.modes.find((m) => m.name === name);

test('lab: with one sample per pixel the reference is point sampling, so point error is exactly zero', () => {
  const r = E.measureFilterAliasing(detail, Object.assign({}, FAST, { supersample: 1 }));
  assert.equal(byName(r, 'Point').rmse.all, 0);
  assert.equal(byName(r, 'Point').flicker, 0);
  assert.equal(byName(r, 'Point').psnr.all, Infinity);
  assert.ok(byName(r, 'Bilinear').rmse.all > 0);
});

test('lab: a flat texture has zero error in every mode and band (filters preserve constants)', () => {
  const r = E.measureFilterAliasing(flat(173), FAST);
  for (const m of r.modes) {
    for (const band of ['near', 'mid', 'far', 'all']) {
      if (m.rmse[band] !== null) assert.ok(m.rmse[band] < 1e-9, m.name + ' ' + band);
    }
    assert.ok(m.flicker < 1e-9, m.name);
  }
});

test('lab: the default view populates all three distance bands and the pixel counts add up', () => {
  const r = E.measureFilterAliasing(detail);
  for (const b of r.bands) assert.ok(b.pixels > 0, b.id);
  assert.equal(r.bands.reduce((n, b) => n + b.pixels, 0), r.groundPixels);
  assert.equal(r.groundPixels, (r.config.height - r.config.horizonY) * r.config.width);
});

test('lab: lambda bands are ordered and the far band is strongly anisotropic', () => {
  const r = E.measureFilterAliasing(detail);
  const [nearB, midB, farB] = r.bands;
  assert.ok(nearB.meanLambda <= 0 && midB.meanLambda > 0 && midB.meanLambda <= 3 && farB.meanLambda > 3);
  for (const b of r.bands) assert.ok(b.meanAnisotropy >= 1, b.id);
  assert.ok(farB.meanAnisotropy > midB.meanAnisotropy && midB.meanAnisotropy > nearB.meanAnisotropy);
  assert.ok(farB.meanAnisotropy > 8, 'grazing angles stretch the footprint');
});

test('lab: in the far band trilinear beats bilinear beats point, and trilinear flickers least', () => {
  const r = E.measureFilterAliasing(detail);
  const P = byName(r, 'Point');
  const B = byName(r, 'Bilinear');
  const T = byName(r, 'Trilinear');
  assert.ok(T.rmse.far < B.rmse.far && B.rmse.far < P.rmse.far);
  assert.ok(T.rmse.far * 2 < P.rmse.far, 'mipmapping at least halves far-field error');
  assert.ok(T.flicker < B.flicker && B.flicker < P.flicker);
  assert.ok(T.psnr.all > P.psnr.all);
});

test('lab: under magnification trilinear reads only level 0, so it matches bilinear exactly', () => {
  const r = E.measureFilterAliasing(detail);
  assert.equal(byName(r, 'Trilinear').rmse.near, byName(r, 'Bilinear').rmse.near);
  assert.ok(byName(r, 'Bilinear').rmse.near < byName(r, 'Point').rmse.near);
});

test('lab: PSNR is consistent with RMSE on the 0 to 255 scale', () => {
  const r = E.measureFilterAliasing(detail, FAST);
  for (const m of r.modes) {
    if (m.rmse.all > 0) assert.ok(Math.abs(m.psnr.all - 20 * Math.log10(255 / m.rmse.all)) < 1e-9, m.name);
  }
});

test('lab: results are deterministic and do not depend on call order', () => {
  const a = E.measureFilterAliasing(detail, FAST);
  E.measureFilterAliasing(flat(10), FAST);
  const b = E.measureFilterAliasing(detail, FAST);
  assert.deepEqual(a, b);
});

test('lab: more frames never change single-frame band errors when the camera does not move', () => {
  const one = E.measureFilterAliasing(detail, Object.assign({}, FAST, { frames: 1 }));
  const still = E.measureFilterAliasing(detail, Object.assign({}, FAST, { frames: 3, stepPerFrame: 0 }));
  for (let m = 0; m < 3; m++) {
    assert.ok(Math.abs(one.modes[m].rmse.all - still.modes[m].rmse.all) < 1e-9);
    assert.equal(still.modes[m].flicker, 0, 'a still camera cannot flicker');
  }
});

test('lab: a horizon with no ground rows is rejected', () => {
  assert.throws(() => E.measureFilterAliasing(detail, { height: 20, horizonY: 19.6 }), RangeError);
  assert.throws(() => E.measureFilterAliasing(detail, { horizonY: -1 }), RangeError);
});

test('lab: pixel footprint matches the Jacobian used by the rasterizer', () => {
  const cfg = Object.assign({}, E.LAB_DEFAULTS);
  const base = detail.levels[0];
  const lowRow = E.labPixelFootprint(cfg, base, cfg.width / 2, cfg.height - 1);
  const highRow = E.labPixelFootprint(cfg, base, cfg.width / 2, cfg.horizonY + 1);
  assert.ok(highRow.lambda > lowRow.lambda, 'rows near the horizon read coarser levels');
  const off = E.labPixelFootprint(cfg, base, 0, cfg.horizonY + 4);
  const centre = E.labPixelFootprint(cfg, base, cfg.width / 2 - 0.5, cfg.horizonY + 4);
  assert.ok(off.lambda >= centre.lambda - 1e-9, 'off-axis pixels never read a finer level than the centre of the row');
});
