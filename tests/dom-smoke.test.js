'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../engine.js');
const { createApp } = require('../app.js');
const { createEnvironment, readTokens, ROOT } = require('./fake-dom.js');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');

function near(actual, expected, eps, label) {
  assert.ok(Math.abs(actual - expected) <= eps, (label || 'value') + ': ' + actual + ' is not within ' + eps + ' of ' + expected);
}

function walkTextFiles(dir, out) {
  const skip = new Set(['.git', 'node_modules']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(full, out);
    else if (/\.(md|html|css|js|json|svg|txt)$/i.test(entry.name) || entry.name === 'LICENSE') out.push(full);
  }
  return out;
}

function boot(options) {
  const env = createEnvironment(options);
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  return { env: env, app: app };
}

function key(env, type, code, extra) {
  return env.doc.emit(type, Object.assign({ code: code }, extra || {}));
}

/* ---------------------------------------------------------------- */
/* static page checks                                                */
/* ---------------------------------------------------------------- */

test('the page declares doctype, language, viewport, title and description', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<title>[^<]{10,}<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{60,}">/);
  assert.match(html, /<meta charset="utf-8">/);
});

test('there is exactly one h1 and headings never skip a level', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  const levels = (html.match(/<h([1-6])[\s>]/g) || []).map((h) => Number(h[2]));
  let prev = 0;
  levels.forEach((l) => {
    assert.ok(l <= prev + 1, 'heading level jump to h' + l);
    prev = l;
  });
});

test('element ids are unique and the app only asks for ids that exist', () => {
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const wanted = new Set(Array.from(appSource.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)).map((m) => m[1]));
  Array.from(appSource.matchAll(/\[\s*'(mode[A-Za-z]+)'/g)).forEach((m) => wanted.add(m[1]));
  ['modePoint', 'modeBilinear', 'modeTrilinear', 'pyramidCanvas', 'frameCanvas', 'hashCanvas'].forEach((id) => wanted.add(id));
  assert.ok(wanted.size > 25);
  wanted.forEach((id) => assert.ok(ids.includes(id), 'missing id ' + id));
});

test('scripts are local and load the engine before the app', () => {
  const scripts = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g)).map((m) => m[1]);
  assert.deepEqual(scripts, ['engine.js', 'app.js']);
  assert.equal((html.match(/<script(?![^>]*src=)/g) || []).length, 0);
  assert.ok(html.indexOf('engine.js') < html.indexOf('app.js'));
});

test('the page makes no outside requests for assets', () => {
  const srcs = Array.from(html.matchAll(/\s(?:src|href)="([^"]+)"/g)).map((m) => m[1]);
  srcs.forEach((u) => {
    if (/^https?:/.test(u)) assert.match(u, /^https:\/\/github\.com\/draarivpatel-ui\/mipmap-arcade/, u);
  });
  assert.equal(/@import|url\(http/i.test(css), false);
  assert.equal(/fetch\(|XMLHttpRequest|WebSocket/.test(appSource + engineSource), false);
});

test('every inline svg is hidden from assistive tech and buttons keep an accessible name', () => {
  const svgs = html.match(/<svg[^>]*>/g) || [];
  assert.ok(svgs.length >= 10);
  svgs.forEach((s) => assert.match(s, /aria-hidden="true"/));
  const buttons = Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g));
  assert.ok(buttons.length >= 11);
  buttons.forEach((b) => {
    const text = b[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.ok(text.length > 0 || /aria-label="[^"]+"/.test(b[1]), 'unnamed button ' + b[1]);
  });
});

test('every canvas has a role and a description', () => {
  const canvases = html.match(/<canvas[^>]*>/g) || [];
  assert.equal(canvases.length, 4);
  canvases.forEach((c) => {
    assert.match(c, /role="img"/);
    assert.match(c, /aria-label="[^"]{20,}"/);
  });
});

test('the page keeps a skip link, landmarks, a live region and labelled form controls', () => {
  assert.match(html, /<a class="skip-link" href="#arcade">/);
  assert.ok(html.includes('id="arcade"'));
  assert.match(html, /<header[\s>]/);
  assert.match(html, /<main[\s>]/);
  assert.match(html, /<footer[\s>]/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /<label for="split">/);
  assert.match(html, /<label for="mBoost">/);
  assert.match(html, /<label for="mHeat">/);
  assert.match(html, /role="radiogroup"/);
});

test('there are no inline styles, style tags or inline event handlers', () => {
  assert.equal(/\sstyle="/.test(html), false);
  assert.equal(/<style[\s>]/.test(html), false);
  assert.equal(/\son[a-z]+="/.test(html), false);
});

test('no emoji appear anywhere in the repository text', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  walkTextFiles(ROOT, []).forEach((f) => {
    assert.equal(emoji.test(fs.readFileSync(f, 'utf8')), false, f);
  });
});

test('there are no em dashes or en dashes anywhere in the repository text', () => {
  const files = walkTextFiles(ROOT, []);
  assert.ok(files.length >= 8);
  files.forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(/[\u2013\u2014]/.test(text), false, f);
  });
});

test('there are no uppercase kickers above headings', () => {
  assert.equal(/text-transform:\s*uppercase/i.test(css), false);
  assert.equal(/eyebrow|kicker|overline/i.test(html + css), false);
  assert.equal(/<(?:p|span|div)[^>]*>\s*[A-Z0-9][A-Z0-9 ]{2,}\s*<\/(?:p|span|div)>\s*<h[1-3]/.test(html), false);
  assert.equal(/letter-spacing:\s*0?\.[1-9]\d*em/.test(css), false);
});

function rootBlock() {
  const start = css.indexOf(':root');
  return { start: start, end: css.indexOf('\n}', start) + 2 };
}

test('colour literals live only in the token block', () => {
  const { start, end } = rootBlock();
  const outside = css.slice(0, start) + css.slice(end);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(outside), false);
  assert.equal(/\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/.test(outside), false);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(html), false);
  assert.equal(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/.test(html), false);
  const tokens = readTokens();
  ['paper', 'ink', 'vermilion', 'cyan'].forEach((n) => assert.ok(tokens[n], n));
  assert.equal(tokens.paper.toUpperCase(), '#F6F4EE');
  assert.equal(tokens.ink.toUpperCase(), '#141618');
  assert.equal(tokens.vermilion.toUpperCase(), '#D94E28');
  assert.equal(tokens.cyan.toUpperCase(), '#0D7490');
});

test('every var(--token) in the page is defined and every runtime token exists', () => {
  const tokens = readTokens();
  const used = new Set();
  [css, html].forEach((text) => Array.from(text.matchAll(/var\(--([a-z0-9-]+)\)/g)).forEach((m) => used.add(m[1])));
  assert.ok(used.size > 20);
  used.forEach((name) => assert.ok(tokens[name], 'undefined token --' + name));
  const runtime = Array.from(appSource.matchAll(/token\('([a-z0-9-]+)'\)/g)).map((m) => m[1]);
  assert.ok(runtime.length >= 15);
  runtime.forEach((name) => assert.ok(tokens[name], 'runtime token --' + name));
});

test('fonts come from tokens and headings are never italic', () => {
  const { start, end } = rootBlock();
  const outside = css.slice(0, start) + css.slice(end);
  const declarations = Array.from(outside.matchAll(/font-family:\s*([^;]+);/g)).map((m) => m[1].trim());
  assert.ok(declarations.length >= 3);
  declarations.forEach((d) => assert.match(d, /^var\(--font-(ui|mono)\)$/));
  assert.equal(/font-style:\s*italic/.test(css), false);
  assert.equal(/<(em|i)[\s>]/.test(html), false);
});

test('layout guards: overflow clip, minmax tracks and reduced motion handling', () => {
  assert.match(css, /html,\s*body\s*{[^}]*overflow-x:\s*clip/);
  assert.equal(/overflow-x:\s*hidden/.test(css), false);
  const grids = Array.from(css.matchAll(/grid-template-columns:\s*([^;]+);/g)).map((m) => m[1]);
  assert.ok(grids.length >= 6);
  grids.forEach((g) => assert.equal(/(^|[\s,(])1fr/.test(g.replace(/minmax\((?:[^()]+|\([^()]*\))*\)/g, '')), false, g));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 30rem\)/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /--tap:\s*44px/);
});

test('the package has zero dependencies, an MIT license and runs the node test runner', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies || {}, {});
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.equal(fs.existsSync(path.join(ROOT, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), false);
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /draarivpatel-ui/);
});

test('the docs state the zero engine design and the Mipmap AI rules honestly', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const notes = fs.readFileSync(path.join(ROOT, 'NOTES.md'), 'utf8');
  [readme, notes].forEach((doc) => {
    assert.match(doc, /no game engine|without an engine|engine-free|no engine/i);
    assert.match(doc, /zero dependencies|no dependencies/i);
    assert.match(doc, /Hack Club Mipmap/);
    assert.match(doc, /AI/);
  });
  assert.match(notes, /one third|a third/i);
  assert.match(notes, /not (?:a|an) (?:Mipmap )?(?:entry|submission)|not submitted|do not submit/i);
  assert.match(notes, /no human playtest/i);
  assert.match(readme, /node --test/);
});

test('the docs and sources carry no private contact details', () => {
  walkTextFiles(ROOT, []).forEach((f) => {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(new RegExp('gmail' + '\\.com', 'i').test(text), false, f);
    assert.equal(new RegExp('Tan' + 'yard', 'i').test(text), false, f);
  });
});

test('engine.js stays pure: no DOM access and no unseeded randomness', () => {
  assert.equal(/\b(document|window|navigator|localStorage)\b/.test(engineSource), false);
  assert.equal(/Math\.random/.test(engineSource), false);
  assert.equal(/Date\.now|performance\.now/.test(engineSource), false);
});

test('the engine exports every public piece the brief names', () => {
  [
    'stepVehiclePhysics', 'SpatialHashGrid', 'buildMipmapPyramid', 'sampleTrilinearMipmap',
    'computeMipLevelFromJacobian', 'encodeGhostReplay', 'decodeGhostReplay', 'generateTrackCircuit',
    'obbOverlap', 'sampleBilinear', 'sampleNearest', 'mulberry32', 'renderGround'
  ].forEach((name) => assert.ok(E[name], name));
  assert.equal(E.FIXED_DT, 1 / 120);
});

test('engine.js also loads as a browser global when there is no module system', () => {
  const sandbox = { Math: Math, Float64Array: Float64Array, Float32Array: Float32Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, DataView: DataView, ArrayBuffer: ArrayBuffer, Map: Map, Set: Set, Object: Object, Number: Number, RangeError: RangeError, Array: Array, String: String, Infinity: Infinity, atob: atob, btoa: btoa };
  sandbox.self = sandbox;
  vm.runInNewContext(engineSource, sandbox);
  assert.equal(typeof sandbox.MipmapEngine.stepVehiclePhysics, 'function');
  assert.equal(sandbox.MipmapEngine.FIXED_DT, 1 / 120);
});

test('app.js boots itself in a browser global context and exposes the running app', () => {
  const env = createEnvironment();
  const sandbox = Object.assign({}, env.win, {
    Math: Math, Number: Number, String: String, parseInt: parseInt, parseFloat: parseFloat, Object: Object,
    Uint8ClampedArray: Uint8ClampedArray, URLSearchParams: URLSearchParams, performance: { now: env.now }
  });
  sandbox.self = sandbox;
  sandbox.MipmapEngine = E;
  vm.runInNewContext(appSource, sandbox);
  assert.equal(typeof sandbox.MipmapArcade, 'function');
  assert.ok(sandbox.mipmapApp);
  assert.ok(sandbox.mipmapApp.state.race);
  assert.equal(env.rafPending(), 1);
});

/* ---------------------------------------------------------------- */
/* helpers in app.js                                                 */
/* ---------------------------------------------------------------- */

test('parseColor reads long and short hex and tolerates spaces', () => {
  const { app } = boot();
  assert.deepEqual(app.parseColor('#D94E28'), [217, 78, 40]);
  assert.deepEqual(app.parseColor('  #0d7490 '), [13, 116, 144]);
  assert.deepEqual(app.parseColor('#fa0'), [255, 170, 0]);
  assert.deepEqual(app.parseColor('000000'), [0, 0, 0]);
});

test('rgbString and the time and speed formatters produce the exact text', () => {
  const { app } = boot();
  assert.equal(app.rgbString([1.4, 2.6, 255]), 'rgb(1,3,255)');
  assert.equal(app.rgbString([10, 20, 30], 0.5), 'rgba(10,20,30,0.5)');
  assert.equal(app.rgbString([10, 20, 30], 0), 'rgba(10,20,30,0)');
  assert.equal(app.formatTime(0), '0:00.0');
  assert.equal(app.formatTime(9.96), '0:10.0');
  assert.equal(app.formatTime(59.94), '0:59.9');
  assert.equal(app.formatTime(61.25), '1:01.3');
  assert.equal(app.formatTime(600), '10:00.0');
  assert.equal(app.kmh(10), 36);
  assert.equal(app.kmh(0), 0);
  assert.equal(app.kmh(27.78), 100);
});

/* ---------------------------------------------------------------- */
/* booting and rendering                                             */
/* ---------------------------------------------------------------- */

test('start builds the scene, paints a first frame and begins the loop', () => {
  const { env, app } = boot();
  const s = app.state;
  assert.ok(s.race);
  assert.equal(s.race.phase, 'countdown');
  assert.equal(s.driver, 'ai');
  assert.equal(s.mode, E.SAMPLE_TRILINEAR);
  assert.equal(s.seed, 2026);
  assert.equal(env.elements.view.width, 480);
  assert.equal(env.elements.view.height, 270);
  assert.ok(env.elements.view.getContext().__state.images >= 1);
  assert.equal(env.elements.view.getContext().__state.lastImage.data.length, 480 * 270 * 4);
  assert.equal(env.rafPending(), 1);
  assert.equal(env.elements.modeBadge.textContent, 'Pace car driving');
  assert.equal(env.elements.modeBadge.dataset.driver, 'ai');
  assert.equal(env.elements.btnPace.attributes['aria-pressed'], 'true');
  assert.equal(env.elements.modeTrilinear.attributes['aria-checked'], 'true');
  assert.equal(env.elements.modePoint.attributes['aria-checked'], 'false');
  assert.equal(env.elements.split.value, '55');
  assert.equal(env.elements.splitValue.textContent, '55%');
  assert.equal(env.elements.btnSound.attributes['aria-pressed'], 'false');
  assert.equal(env.elements.soundLabel.textContent, 'Sound off');
  assert.match(env.elements.seedNote.textContent, /^Track seed 2026\. No ghost yet\.$/);
  assert.match(env.elements.modeNote.textContent, /Trilinear sampling blends/);
});

test('the palette is read from the css tokens', () => {
  const { app } = boot();
  const p = app.state.palette;
  assert.deepEqual(p.vermilion, [217, 78, 40]);
  assert.deepEqual(p.cyan, [13, 116, 144]);
  assert.deepEqual(p.ink, [20, 22, 24]);
  assert.deepEqual(p.paper, [246, 244, 238]);
  assert.deepEqual(p.heat[0], [13, 116, 144]);
  assert.deepEqual(p.heat[2], [217, 78, 40]);
  assert.equal(p.heat.length, 3);
  assert.deepEqual(p.divider, [20, 22, 24]);
});

test('frames advance the fixed step simulation and update the heads up display', () => {
  const { env, app } = boot();
  env.runFrames(30);
  assert.ok(app.state.race.tick >= 55 && app.state.race.tick <= 62, 'ticks ' + app.state.race.tick);
  assert.equal(app.state.frames, 30);
  assert.equal(env.elements.countdown.hidden, false);
  assert.equal(env.elements.countdown.textContent, '3');
  env.runFrames(120);
  assert.equal(env.elements.countdown.textContent, '1');
  env.runFrames(45);
  assert.equal(app.state.race.phase, 'running');
  assert.equal(env.elements.countdown.textContent, 'Go');
  assert.equal(env.elements.countdown.hidden, false);
  env.runFrames(60);
  assert.equal(env.elements.countdown.hidden, true);
  assert.ok(Number(env.elements.hudSpeed.textContent) > 20);
  assert.match(env.elements.hudTime.textContent, /^0:0\d\.\d$/);
  assert.equal(env.elements.hudLap.textContent, 'Lap 1 of 3');
  assert.equal(env.elements.hudBest.textContent, 'no best yet');
  assert.ok(env.elements.mBoost.value >= 0);
});

test('a long stall is clamped so the simulation never spirals', () => {
  const { env, app } = boot();
  env.runFrames(2);
  const before = app.state.race.tick;
  const fn = (t) => app.frame(t);
  fn(100000);
  assert.ok(app.state.race.tick - before <= 8);
  assert.equal(app.frame(100000 + 1000 / 60) >= 0, true);
});

test('the inspector panels fill in their notes while the pace car drives', () => {
  const { env, app } = boot();
  env.runFrames(600);
  assert.equal(app.state.race.phase, 'running');
  const level = app.state.probe.level;
  if (level > Math.floor(level)) {
    assert.match(env.elements.pyramidNote.textContent, /^Blending level \d and level \d at lambda -?\d+\.\d\d\.$/);
  } else {
    // A whole level has nothing to blend, so the note must not claim a blend.
    assert.match(env.elements.pyramidNote.textContent, /^Trilinear reads only level \d while lambda is -?\d+\.\d\d\.$/);
  }
  assert.match(env.elements.frameNote.textContent, /^Mean \d+\.\d ms, 95th percentile \d+\.\d ms, worst \d+\.\d ms\. The line marks 16\.7 ms\.$/);
  assert.match(env.elements.hashNote.textContent, /^\d+ cells hold \d+ entries, at most \d+ in one\. The car checked \d+ candidates and ran SAT on \d+\.$/);
  assert.match(env.elements.tSlip.textContent, /^\d+\.\d deg$/);
  assert.match(env.elements.tLambda.textContent, /^-?\d+\.\d\d$/);
  assert.match(env.elements.tLevel.textContent, /^\d+\.\d\d$/);
  assert.match(env.elements.tGates.textContent, /^\d of 8$/);
  assert.equal(env.elements.tCells.textContent, String(app.state.race.cells));
  assert.equal(env.elements.tPylons.textContent, String(app.state.race.pylonHits));
  assert.equal(env.elements.mHeat.value, app.state.race.car.heat);
  assert.equal(env.elements.mBoost.value, app.state.race.car.boostCharge);
  assert.ok(env.elements.pyramidCanvas.getContext().__state.calls.strokeRect >= 9);
  assert.ok(env.elements.hashCanvas.getContext().__state.calls.fillRect >= 3);
  assert.ok(env.elements.frameCanvas.getContext().__state.calls.fillRect >= 30);
});

test('the lambda probe reads the ground below the horizon and the level matches the mode', () => {
  const { env, app } = boot();
  env.runFrames(10);
  assert.ok(app.state.probe.lambda > E.NO_LOD);
  near(app.state.probe.level, E.clamp(app.state.probe.lambda, 0, 8), 1e-9);
  app.setMode(E.SAMPLE_POINT);
  env.runFrames(10);
  assert.equal(app.state.probe.level, 0);
  assert.match(env.elements.pyramidNote.textContent, /^Point stays on level 0 while lambda is -?\d+\.\d\d\.$/);
  app.setMode(E.SAMPLE_BILINEAR);
  env.runFrames(10);
  assert.match(env.elements.pyramidNote.textContent, /^Bilinear stays on level 0/);
});

test('the first drawn frame is a real composite of the scene and the heatmap', () => {
  const { app } = boot();
  const img = app.composite;
  const W = 480;
  const splitX = Math.round(0.55 * W);
  const y = 250;
  const left = (y * W + 100) * 4;
  const right = (y * W + 400) * 4;
  const heat = app.state.target.heat;
  assert.equal(img[left], app.state.target.rgba[left]);
  assert.equal(img[right], heat[right]);
  assert.equal(img[(y * W + splitX) * 4], app.state.palette.divider[0]);
  assert.notEqual(app.state.target.lod[y * W + 100], E.NO_LOD);
  assert.equal(app.state.target.lod[2 * W + 100], E.NO_LOD);
});

/* ---------------------------------------------------------------- */
/* controls                                                          */
/* ---------------------------------------------------------------- */

test('clicking a sampling mode updates the state, radio state and explanation', () => {
  const { env, app } = boot();
  env.elements.modePoint.emit('click');
  assert.equal(app.state.mode, E.SAMPLE_POINT);
  assert.equal(env.elements.modePoint.attributes['aria-checked'], 'true');
  assert.equal(env.elements.modeBilinear.attributes['aria-checked'], 'false');
  assert.equal(env.elements.modeTrilinear.attributes['aria-checked'], 'false');
  assert.match(env.elements.modeNote.textContent, /^Point sampling reads one texel/);
  assert.equal(env.elements.announcer.textContent, 'Point sampling.');
  env.elements.modeBilinear.emit('click');
  assert.equal(app.state.mode, E.SAMPLE_BILINEAR);
  assert.equal(env.elements.modeBilinear.attributes['aria-checked'], 'true');
  assert.match(env.elements.modeNote.textContent, /^Bilinear sampling smooths/);
  env.elements.modeTrilinear.emit('click');
  assert.equal(app.state.mode, E.SAMPLE_TRILINEAR);
  assert.equal(env.elements.announcer.textContent, 'Trilinear sampling.');
});

test('keys 1, 2 and 3 pick the sampling mode', () => {
  const { env, app } = boot();
  key(env, 'keydown', 'Digit1');
  assert.equal(app.state.mode, 0);
  key(env, 'keydown', 'Digit2');
  assert.equal(app.state.mode, 1);
  key(env, 'keydown', 'Digit3');
  assert.equal(app.state.mode, 2);
  assert.equal(app.state.driver, 'ai');
});

test('the heatmap split slider clamps and shows its percentage', () => {
  const { env, app } = boot();
  env.elements.split.value = '80';
  env.elements.split.emit('input');
  assert.equal(app.state.split, 0.8);
  assert.equal(env.elements.splitValue.textContent, '80%');
  app.setSplit(2);
  assert.equal(app.state.split, 1);
  assert.equal(env.elements.split.value, '100');
  app.setSplit(-2);
  assert.equal(app.state.split, 0);
  assert.equal(env.elements.splitValue.textContent, '0%');
  app.setSplit(0.333);
  assert.equal(env.elements.splitValue.textContent, '33%');
  env.runFrames(2);
  assert.equal(app.composite[(250 * 480 + 5) * 4], app.state.target.rgba[(250 * 480 + 5) * 4]);
  assert.equal(app.composite[(250 * 480 + 400) * 4], app.state.target.heat[(250 * 480 + 400) * 4]);
});

test('pressing a driving key takes over from the pace car and prevents page scrolling', () => {
  const { env, app } = boot();
  const e = key(env, 'keydown', 'KeyW');
  assert.equal(e.defaultPrevented, true);
  assert.equal(app.state.driver, 'player');
  assert.equal(env.elements.modeBadge.textContent, 'You are driving');
  assert.equal(env.elements.modeBadge.dataset.driver, 'player');
  assert.equal(env.elements.btnPace.attributes['aria-pressed'], 'false');
  assert.deepEqual(app.playerTarget(), { steer: 0, throttle: 1, brake: 0, drift: false });
  key(env, 'keyup', 'KeyW');
  assert.equal(app.playerTarget().throttle, 0);
});

test('every driving key maps to the right control', () => {
  const { env, app } = boot();
  const cases = [
    ['ArrowLeft', { steer: -1, throttle: 0, brake: 0, drift: false }],
    ['KeyA', { steer: -1, throttle: 0, brake: 0, drift: false }],
    ['ArrowRight', { steer: 1, throttle: 0, brake: 0, drift: false }],
    ['KeyD', { steer: 1, throttle: 0, brake: 0, drift: false }],
    ['ArrowUp', { steer: 0, throttle: 1, brake: 0, drift: false }],
    ['KeyW', { steer: 0, throttle: 1, brake: 0, drift: false }],
    ['ArrowDown', { steer: 0, throttle: 0, brake: 1, drift: false }],
    ['KeyS', { steer: 0, throttle: 0, brake: 1, drift: false }],
    ['Space', { steer: 0, throttle: 0, brake: 0, drift: true }]
  ];
  cases.forEach(([code, expected]) => {
    key(env, 'keydown', code);
    assert.deepEqual(app.playerTarget(), expected, code);
    key(env, 'keyup', code);
    assert.deepEqual(app.playerTarget(), { steer: 0, throttle: 0, brake: 0, drift: false }, code + ' released');
  });
  key(env, 'keydown', 'ArrowLeft');
  key(env, 'keydown', 'ArrowRight');
  assert.equal(app.playerTarget().steer, 0);
});

test('typing in a form control and activating a button with space are left alone', () => {
  const { env, app } = boot();
  const input = { tagName: 'input' };
  const e1 = key(env, 'keydown', 'KeyW', { target: input });
  assert.equal(e1.defaultPrevented, false);
  assert.equal(app.state.driver, 'ai');
  const button = { tagName: 'BUTTON' };
  const e2 = key(env, 'keydown', 'Space', { target: button });
  assert.equal(e2.defaultPrevented, false);
  assert.equal(app.state.driver, 'ai');
  const e3 = key(env, 'keydown', 'KeyW', { target: button });
  assert.equal(e3.defaultPrevented, true);
  assert.equal(app.state.driver, 'player');
  const e4 = key(env, 'keydown', 'KeyW', { target: { tagName: 'SELECT' } });
  assert.equal(e4.defaultPrevented, false);
  const e5 = key(env, 'keydown', 'KeyW', { target: { tagName: 'TEXTAREA' } });
  assert.equal(e5.defaultPrevented, false);
});

test('the player steering ramps up instead of snapping', () => {
  const { env, app } = boot();
  key(env, 'keydown', 'KeyD');
  app.tick(E.FIXED_DT);
  near(app.state.steer, 5 * E.FIXED_DT, 1e-12);
  for (let i = 0; i < 12; i++) app.tick(E.FIXED_DT);
  near(app.state.steer, 13 * 5 * E.FIXED_DT, 1e-9);
  for (let i = 0; i < 60; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.steer, 1);
  key(env, 'keyup', 'KeyD');
  key(env, 'keydown', 'KeyA');
  for (let i = 0; i < 60; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.steer, -1);
});

test('player input is passed to the race and is recorded', () => {
  const { env, app } = boot();
  key(env, 'keydown', 'KeyW');
  for (let i = 0; i < 400; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.race.phase, 'running');
  assert.ok(app.state.race.car.speed > 5);
  assert.equal(app.state.race.inputLog.length, 400);
  assert.equal(E.unpackInput(app.state.race.inputLog[399]).throttle, 1);
  assert.equal(app.state.assisted, false);
});

test('touch controls press, release and take over', () => {
  const { env, app } = boot();
  const names = ['left', 'right', 'drift', 'brake', 'gas'];
  const buttons = env.elements.touch.children;
  assert.equal(buttons.length, 5);
  const gas = buttons.find((b) => b.dataset.touch === 'gas');
  const down = gas.emit('pointerdown');
  assert.equal(down.defaultPrevented, true);
  assert.equal(gas.dataset.active, 'true');
  assert.equal(app.state.driver, 'player');
  assert.equal(app.playerTarget().throttle, 1);
  gas.emit('pointerup');
  assert.equal(gas.dataset.active, 'false');
  assert.equal(app.playerTarget().throttle, 0);
  names.forEach((name) => {
    const b = buttons.find((x) => x.dataset.touch === name);
    b.emit('pointerdown');
    const t = app.playerTarget();
    if (name === 'left') assert.equal(t.steer, -1);
    if (name === 'right') assert.equal(t.steer, 1);
    if (name === 'drift') assert.equal(t.drift, true);
    if (name === 'brake') assert.equal(t.brake, 1);
    if (name === 'gas') assert.equal(t.throttle, 1);
    b.emit('pointercancel');
    assert.equal(b.dataset.active, 'false');
    b.emit('pointerdown');
    b.emit('pointerleave');
    assert.equal(b.dataset.active, 'false');
  });
  assert.deepEqual(app.playerTarget(), { steer: 0, throttle: 0, brake: 0, drift: false });
});

test('losing focus releases every key and touch', () => {
  const { env, app } = boot();
  key(env, 'keydown', 'KeyW');
  env.elements.touch.children[0].emit('pointerdown');
  assert.equal(app.playerTarget().throttle, 1);
  env.win.emit('blur');
  assert.deepEqual(app.playerTarget(), { steer: 0, throttle: 0, brake: 0, drift: false });
  assert.equal(env.elements.touch.children[0].dataset.active, 'false');
  key(env, 'keydown', 'KeyD');
  env.doc.emit('visibilitychange');
  assert.equal(app.playerTarget().steer, 0);
});

test('the pace car button, the P key and the R key switch driver and restart', () => {
  const { env, app } = boot();
  env.elements.btnPace.emit('click');
  assert.equal(app.state.driver, 'player');
  assert.equal(env.elements.btnPace.attributes['aria-pressed'], 'false');
  assert.equal(env.elements.modeBadge.textContent, 'You are driving');
  key(env, 'keydown', 'KeyP');
  assert.equal(app.state.driver, 'ai');
  assert.equal(env.elements.modeBadge.textContent, 'Pace car driving');
  assert.equal(env.elements.btnPace.attributes['aria-pressed'], 'true');
  for (let i = 0; i < 30; i++) app.tick(E.FIXED_DT);
  key(env, 'keydown', 'KeyR');
  assert.equal(app.state.driver, 'player');
  assert.equal(app.state.race.tick, 0);
  assert.equal(app.state.race.phase, 'countdown');
  assert.equal(env.elements.announcer.textContent, 'Race starting. Three laps.');
  for (let i = 0; i < 10; i++) app.tick(E.FIXED_DT);
  env.elements.btnStart.emit('click');
  assert.equal(app.state.race.tick, 0);
  assert.equal(app.state.driver, 'player');
});

test('the new track button advances the seed and rebuilds the race', () => {
  const { env, app } = boot();
  const lengthBefore = app.state.race.track.length;
  env.elements.btnTrack.emit('click');
  assert.equal(app.state.seed, 2027);
  assert.equal(app.state.race.seed, 2027);
  assert.notEqual(app.state.race.track.length, lengthBefore);
  assert.match(env.elements.seedNote.textContent, /^Track seed 2027\. No ghost yet\.$/);
  assert.equal(app.state.fieldsSeed, 2027);
  assert.equal(app.state.driver, 'ai');
  env.runFrames(5);
  assert.equal(app.state.race.tick > 0, true);
  key(env, 'keydown', 'KeyW');
  env.elements.btnTrack.emit('click');
  assert.equal(app.state.seed, 2028);
  assert.equal(app.state.driver, 'player');
});

test('a seed in the address is honoured and nonsense falls back to the default', () => {
  assert.equal(boot({ search: '?seed=77' }).app.state.seed, 77);
  assert.equal(boot({ search: '?seed=abc' }).app.state.seed, 2026);
  assert.equal(boot({ search: '?seed=0' }).app.state.seed, 2026);
  assert.equal(boot({ search: '' }).app.state.seed, 2026);
});

/* ---------------------------------------------------------------- */
/* sound                                                             */
/* ---------------------------------------------------------------- */

test('sound stays silent until the first interaction, then can be muted', () => {
  const { env, app } = boot({ audio: true });
  assert.equal(env.AudioContext.instances.length, 0);
  assert.equal(app.state.soundOn, false);
  env.runFrames(3);
  assert.equal(env.AudioContext.instances.length, 0);
  key(env, 'keydown', 'KeyW');
  assert.equal(env.AudioContext.instances.length, 1);
  assert.equal(app.state.soundOn, true);
  assert.equal(env.elements.soundLabel.textContent, 'Sound on');
  assert.equal(env.elements.btnSound.attributes['aria-pressed'], 'true');
  key(env, 'keydown', 'KeyM');
  assert.equal(app.state.soundOn, false);
  assert.equal(env.elements.soundLabel.textContent, 'Sound off');
  key(env, 'keydown', 'KeyM');
  assert.equal(app.state.soundOn, true);
  assert.equal(env.AudioContext.instances.length, 1);
});

test('a pointer press also unlocks audio and a suspended context is resumed', () => {
  const { env, app } = boot({ audio: true });
  env.doc.emit('pointerdown');
  assert.equal(env.AudioContext.instances.length, 1);
  env.AudioContext.instances[0].state = 'suspended';
  env.doc.emit('pointerdown');
  assert.equal(env.AudioContext.instances[0].state, 'running');
  assert.equal(app.state.soundOn, true);
});

test('the sound button toggles and can create the audio context itself', () => {
  const { env, app } = boot({ audio: true });
  env.elements.btnSound.emit('click');
  assert.equal(app.state.soundOn, true);
  assert.equal(env.AudioContext.instances.length, 1);
  env.elements.btnSound.emit('click');
  assert.equal(app.state.soundOn, false);
  assert.equal(env.elements.btnSound.attributes['aria-pressed'], 'false');
});

test('the engine hum follows speed and chimes fire on gates and cells', () => {
  const { env, app } = boot({ audio: true });
  key(env, 'keydown', 'KeyW');
  const ctx = env.AudioContext.instances[0];
  for (let i = 0; i < 500; i++) app.tick(E.FIXED_DT);
  env.runFrames(1);
  assert.ok(app.audio.osc.frequency.value > 48 + 3.1 * 5);
  near(app.audio.osc.frequency.value, 48 + app.state.race.car.speed * 3.1, 25);
  assert.ok(app.audio.gain.gain.value > 0.05);
  assert.ok(app.audio.gain.gain.value <= 0.1);
  assert.ok(app.audio.filter.frequency.value > 300);
  const before = ctx.made.oscillators;
  const cell = app.state.race.entities.find((e) => e.kind === 'cell');
  app.state.race.car.x = cell.box.cx;
  app.state.race.car.y = cell.box.cy;
  app.tick(E.FIXED_DT);
  assert.equal(ctx.made.oscillators - before, 2);
  const mid = ctx.made.oscillators;
  const gate = app.state.race.entities.find((e) => e.kind === 'gate' && e.id === app.state.race.nextGate);
  app.state.race.car.x = gate.box.cx;
  app.state.race.car.y = gate.box.cy;
  app.tick(E.FIXED_DT);
  assert.equal(ctx.made.oscillators - mid, 2);
  key(env, 'keydown', 'KeyM');
  const muted = ctx.made.oscillators;
  const second = app.state.race.entities.filter((e) => e.kind === 'cell')[3];
  app.state.race.car.x = second.box.cx;
  app.state.race.car.y = second.box.cy;
  app.tick(E.FIXED_DT);
  assert.equal(ctx.made.oscillators, muted);
  env.runFrames(1);
  assert.equal(app.audio.gain.gain.value, 0.0001);
});

test('without WebAudio support nothing throws', () => {
  const { env, app } = boot({ audio: false });
  key(env, 'keydown', 'KeyW');
  key(env, 'keydown', 'KeyM');
  env.runFrames(5);
  assert.equal(app.audio.context, null);
  assert.equal(app.state.soundOn, true);
});

/* ---------------------------------------------------------------- */
/* reduced motion, storage and ghosts                                */
/* ---------------------------------------------------------------- */

test('reduced motion holds the loop until the player asks to start', () => {
  const { env, app } = boot({ reducedMotion: true });
  assert.equal(app.state.reducedMotion, true);
  assert.equal(env.rafPending(), 0);
  assert.equal(env.elements.toast.hidden, false);
  assert.match(env.elements.toast.textContent, /Reduced motion is on/);
  assert.ok(env.elements.view.getContext().__state.images >= 1);
  env.elements.btnStart.emit('click');
  assert.equal(env.rafPending(), 1);
  assert.equal(app.state.driver, 'player');
});

test('a normal start leaves reduced motion off', () => {
  const { app } = boot();
  assert.equal(app.state.reducedMotion, false);
});

test('toasts appear for events and fade after three seconds', () => {
  const { env, app } = boot();
  const race = E.runAIRace(2026, 200);
  app.state.race = race;
  app.state.assisted = false;
  app.finishRace();
  assert.equal(env.elements.toast.hidden, false);
  env.runFrames(100);
  assert.equal(env.elements.toast.hidden, false);
  env.runFrames(100);
  assert.equal(env.elements.toast.hidden, true);
});

test('a clean finish saves the best time and a ghost, a slower run does not replace it', () => {
  const { env, app } = boot();
  const fast = E.runAIRace(2026, 200);
  app.state.race = fast;
  app.state.assisted = false;
  app.finishRace();
  assert.equal(app.state.best, fast.time);
  assert.equal(env.storage['mipmap-arcade.best.2026'], String(fast.time));
  const saved = E.decodeGhostReplay(E.base64ToBytes(env.storage['mipmap-arcade.ghost.2026']));
  assert.equal(saved.seed, 2026);
  assert.deepEqual(saved.frames, fast.inputLog);
  assert.match(env.elements.toast.textContent, /^New best \d+:\d\d\.\d\. Ghost saved\.$/);
  assert.match(env.elements.announcer.textContent, /^New best time /);
  const slow = E.runAIRace(2026, 200);
  slow.time = fast.time + 5;
  app.state.race = slow;
  app.finishRace();
  assert.equal(app.state.best, fast.time);
  assert.match(env.elements.toast.textContent, /^Finished in \d+:\d\d\.\d$/);
  const quicker = E.runAIRace(2026, 200);
  quicker.time = fast.time - 1;
  app.state.race = quicker;
  app.finishRace();
  assert.equal(app.state.best, fast.time - 1);
  assert.equal(env.storage['mipmap-arcade.best.2026'], String(fast.time - 1));
});

test('a run the pace car helped with never saves a ghost', () => {
  const { env, app } = boot();
  const race = E.runAIRace(2026, 200);
  app.state.race = race;
  app.state.assisted = true;
  app.finishRace();
  assert.equal(app.state.best, null);
  assert.equal(Object.keys(env.storage).length, 0);
  assert.match(env.elements.toast.textContent, /^Pace car finished in \d+:\d\d\.\d$/);
  assert.match(env.elements.announcer.textContent, /No ghost saved/);
});

test('the pace car drives mark a run as assisted only while the race is live', () => {
  const { env, app } = boot();
  assert.equal(app.state.assisted, false);
  for (let i = 0; i < 100; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.assisted, false);
  for (let i = 0; i < 300; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.assisted, true);
  assert.ok(env.elements.announcer.textContent.length > 0);
});

test('a saved ghost loads on the next visit and replays the saved run', () => {
  const first = boot();
  const run = E.runAIRace(2026, 200);
  first.app.state.race = run;
  first.app.state.assisted = false;
  first.app.finishRace();
  const second = boot({ storage: first.env.storage });
  assert.equal(second.app.state.best, run.time);
  assert.equal(second.app.state.ghostFrames.length, run.inputLog.length);
  assert.ok(second.app.state.ghost);
  assert.match(second.env.elements.seedNote.textContent, /^Track seed 2026\. Ghost saved at \d+:\d\d\.\d\.$/);
  assert.match(second.env.elements.hudBest.textContent, /^best \d+:\d\d\.\d$/);
  for (let i = 0; i < 1000; i++) second.app.tick(E.FIXED_DT);
  const reference = E.replayRace(2026, run.inputLog.slice(0, 1000));
  assert.equal(E.hashRaceState(second.app.state.ghost), E.hashRaceState(reference));
  for (let i = 0; i < run.inputLog.length; i++) {
    if (i >= 1000) second.app.tick(E.FIXED_DT);
  }
  for (let i = 0; i < 50; i++) second.app.tick(E.FIXED_DT);
  assert.equal(second.app.state.ghost.tick, run.inputLog.length);
  assert.equal(second.app.state.ghost.phase, 'finished');
});

test('a ghost for a different seed or corrupt data is ignored', () => {
  const run = E.runAIRace(2026, 200);
  const storage = {
    'mipmap-arcade.best.2026': String(run.time),
    'mipmap-arcade.ghost.2026': E.bytesToBase64(E.encodeGhostReplay(99, run.inputLog))
  };
  assert.equal(boot({ storage: storage }).app.state.best, null);
  const corrupt = { 'mipmap-arcade.best.2026': '120', 'mipmap-arcade.ghost.2026': 'AAAA' };
  const b = boot({ storage: corrupt });
  assert.equal(b.app.state.best, null);
  assert.equal(b.app.state.ghost, null);
  const noTime = { 'mipmap-arcade.ghost.2026': E.bytesToBase64(E.encodeGhostReplay(2026, run.inputLog)) };
  assert.equal(boot({ storage: noTime }).app.state.best, null);
  const noGhost = { 'mipmap-arcade.best.2026': '90' };
  assert.equal(boot({ storage: noGhost }).app.state.best, null);
  const zero = { 'mipmap-arcade.best.2026': '0', 'mipmap-arcade.ghost.2026': E.bytesToBase64(E.encodeGhostReplay(2026, run.inputLog)) };
  assert.equal(boot({ storage: zero }).app.state.best, null);
});

test('blocked storage does not break the game', () => {
  const { env, app } = boot({ blockStorage: true });
  assert.equal(app.state.best, null);
  const run = E.runAIRace(2026, 200);
  app.state.race = run;
  app.state.assisted = false;
  app.finishRace();
  assert.equal(app.state.best, run.time);
  env.runFrames(3);
});

test('the demo loop starts a fresh pace car race after a finish', () => {
  const { app } = boot();
  const race = E.runAIRace(2026, 200);
  app.state.race = race;
  app.state.postFinish = 0;
  for (let i = 0; i < 479; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.race, race);
  assert.equal(race.phase, 'finished');
  app.tick(E.FIXED_DT);
  assert.notEqual(app.state.race, race);
  assert.equal(app.state.race.tick, 0);
  assert.equal(app.state.driver, 'ai');
});

test('after a finish a human driver stays on the results until they restart', () => {
  const { app } = boot();
  const race = E.runAIRace(2026, 200);
  app.state.race = race;
  app.state.driver = 'player';
  app.state.postFinish = 0;
  for (let i = 0; i < 600; i++) app.tick(E.FIXED_DT);
  assert.equal(app.state.race, race);
});

test('the heads up display clamps the lap counter at the final lap', () => {
  const { env, app } = boot();
  const race = E.runAIRace(2026, 200);
  app.state.race = race;
  env.runFrames(2);
  assert.equal(env.elements.hudLap.textContent, 'Lap 3 of 3');
  assert.equal(env.elements.countdown.hidden, true);
  assert.match(env.elements.hudTime.textContent, /^\d:\d\d\.\d$/);
});

/* ---------------------------------------------------------------- */
/* split grip, countdown beat and chart labels                       */
/* ---------------------------------------------------------------- */

test('the split follows the slider into a style variable the grip and divider read', () => {
  const { env, app } = boot();
  assert.equal(env.elements.viewport.style['--split'], '55%');
  app.setSplit(0.8);
  assert.equal(env.elements.viewport.style['--split'], '80%');
  assert.match(html, /id="splitGrip"[^>]*aria-hidden="true"/);
  assert.match(css, /left:\s*var\(--split\)/);
});

test('dragging the grip moves the split and letting go stops it', () => {
  const { env, app } = boot();
  env.elements.viewport.getBoundingClientRect = () => ({ left: 100, width: 400 });
  const grip = env.elements.splitGrip;
  grip.emit('pointermove', { clientX: 140 });
  assert.equal(app.state.split, 0.55, 'a move without a press does nothing');
  grip.emit('pointerdown');
  assert.equal(grip.dataset.dragging, 'true');
  grip.emit('pointermove', { clientX: 200 });
  assert.equal(app.state.split, 0.25);
  assert.equal(env.elements.split.value, '25');
  grip.emit('pointermove', { clientX: 900 });
  assert.equal(app.state.split, 1);
  grip.emit('pointerup');
  assert.equal(grip.dataset.dragging, 'false');
  grip.emit('pointermove', { clientX: 120 });
  assert.equal(app.state.split, 1);
});

test('the countdown flips its beat flag each time the number changes', () => {
  const { env } = boot();
  env.runFrames(30);
  const first = env.elements.countdown.dataset.beat;
  assert.ok(first === 'a' || first === 'b');
  env.runFrames(2);
  assert.equal(env.elements.countdown.dataset.beat, first, 'same number, same beat');
  const number = env.elements.countdown.textContent;
  for (let i = 0; i < 90 && env.elements.countdown.textContent === number; i++) env.runFrames(1);
  assert.notEqual(env.elements.countdown.textContent, number);
  assert.notEqual(env.elements.countdown.dataset.beat, first);
});

test('the pyramid and frame charts write their labels onto the canvas', () => {
  const { env } = boot();
  env.runFrames(40);
  assert.ok(env.elements.pyramidCanvas.getContext().__state.calls.fillText >= 9, 'one label per level');
  assert.ok(env.elements.frameCanvas.getContext().__state.calls.fillText >= 2);
  assert.match(html, /Within the 16\.7 ms budget/);
  assert.match(html, /Cells the car queries/);
});
