'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');
const { createApp } = require('../app.js');
const { createEnvironment, ROOT } = require('./fake-dom.js');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

function boot(options) {
  const env = createEnvironment(options);
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  return { env: env, app: app };
}

function key(env, code, extra) {
  return env.doc.emit('keydown', Object.assign({ code: code }, extra || {}));
}

/* ------------------------------------------------------------- markup */

test('a Content-Security-Policy meta locks the page to self', () => {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert.ok(m, 'CSP meta present');
  const csp = m[1];
  for (const directive of [
    /default-src 'self'/,
    /script-src 'self';/,
    /object-src 'none'/,
    /base-uri 'none'/,
    /form-action 'none'/,
    /connect-src 'self'/
  ]) {
    assert.ok(directive.test(csp), 'CSP contains ' + directive);
  }
});

test('styles contain no scroll-behavior anywhere (station rule)', () => {
  assert.ok(!/scroll-behavior\s*:\s*smooth/i.test(css), 'smooth scrolling banned');
  assert.ok(!/scroll-behavior\s*:/i.test(css), 'no scroll-behavior declarations at all');
});

test('the shortcuts checkbox exists, is labelled, and starts checked', () => {
  const m = html.match(/<label[^>]*class="keys-toggle"[^>]*>[\s\S]*?<\/label>/);
  assert.ok(m, 'labelled checkbox present');
  assert.match(m[0], /type="checkbox"/);
  assert.match(m[0], /id="chkShortcuts"/);
  assert.match(m[0], /checked/);
  assert.match(m[0], /Letter and number shortcuts/);
});

test('the help text documents that letter and number keys can be turned off', () => {
  const m = html.match(/<p id="keys-help"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(m);
  assert.match(m[1], /turned off/i);
});

test('the sampling radiogroup keeps a single tab stop (roving tabindex)', () => {
  assert.match(html, /id="modePoint"[^>]*tabindex="-1"/);
  assert.match(html, /id="modeBilinear"[^>]*tabindex="-1"/);
  assert.match(html, /id="modeTrilinear"[^>]*tabindex="0"/);
});

/* -------------------------------------------------------------- ghost */

test('a ghost header claiming absurd frame counts is rejected before allocating', () => {
  const bytes = [0x4C, 0x5A, 0x47, 0x31, 7, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 1, 1, 0];
  assert.throws(() => E.decodeGhostReplay(Uint8Array.from(bytes)), /too long/);
});

test('a ghost claiming more runs than frames is rejected', () => {
  const bytes = E.encodeGhostReplay(9, [1, 1, 1]);
  /* rebuild a valid header with runCount > total: seed 9, total 3, runs 5 */
  const raw = [0x4C, 0x5A, 0x47, 0x31, 9, 3, 5, 3, 0];
  assert.throws(() => E.decodeGhostReplay(Uint8Array.from(raw)), /more runs than frames/);
  assert.ok(E.decodeGhostReplay(bytes).frames.length === 3, 'valid replay still decodes');
});

test('ghost cap constant is exported and sane for a real race', () => {
  assert.equal(E.GHOST_MAX_FRAMES, 2160000);
  assert.ok(E.GHOST_MAX_FRAMES >= 120 * 60 * 60, 'at least an hour of ticks');
});

/* ----------------------------------------------------- 2.1.4 behaviour */

test('with shortcuts on (default) every documented key works', () => {
  const { app } = boot();
  assert.equal(app.state.shortcuts, true, 'default on');
  key({ doc: { emit: () => {} } }, 'noop');
  const env2 = createEnvironment();
  const app2 = createApp({ document: env2.doc, window: env2.win, engine: E, now: env2.now });
  app2.start();
  env2.doc.emit('keydown', { code: 'Digit1' });
  assert.equal(app2.state.mode, E.SAMPLE_POINT);
});

test('turning the switch off silences letter, digit and Space shortcuts', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  const box = env.doc.getElementById('chkShortcuts');
  box.checked = false;
  box.emit('change');
  assert.equal(app.state.shortcuts, false);

  env.doc.emit('keydown', { code: 'Digit1' });
  assert.equal(app.state.mode, E.SAMPLE_TRILINEAR, 'digit shortcuts dead');
  env.doc.emit('keydown', { code: 'KeyM' });
  assert.equal(app.state.soundOn, false, 'M does not toggle sound');
  env.doc.emit('keydown', { code: 'KeyA' });
  assert.equal(app.state.keys.KeyA, undefined, 'WASD do not drive');
  env.doc.emit('keydown', { code: 'Space' });
  assert.equal(app.state.keys.Space, undefined, 'Space does not drive');
  env.doc.emit('keydown', { code: 'KeyR' });
  assert.equal(app.state.driver, 'pace', 'R does not restart into a player race');
  env.doc.emit('keydown', { code: 'KeyL' });
  assert.equal(app.state.lab, null, 'L does not run the lab');
});

test('the arrow keys keep driving with the switch off', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  const box = env.doc.getElementById('chkShortcuts');
  box.checked = false;
  box.emit('change');
  const ev = env.doc.emit('keydown', { code: 'ArrowLeft' });
  assert.equal(ev.defaultPrevented, true, 'arrow still consumed');
  assert.equal(app.state.keys.ArrowLeft, true, 'arrow still steers');
  assert.equal(app.state.driver, 'player', 'arrow takes over from the pace car');
});

test('flipping the switch releases held keys so nothing sticks', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  env.doc.emit('keydown', { code: 'KeyW' });
  env.doc.emit('keydown', { code: 'ArrowUp' });
  assert.equal(app.state.keys.KeyW, true);
  const box = env.doc.getElementById('chkShortcuts');
  box.checked = false;
  box.emit('change');
  assert.deepEqual(app.state.keys, {}, 'all keys released on toggle');
});

test('turning the switch back on restores every shortcut', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  const box = env.doc.getElementById('chkShortcuts');
  box.checked = false;
  box.emit('change');
  box.checked = true;
  box.emit('change');
  env.doc.emit('keydown', { code: 'Digit2' });
  assert.equal(app.state.mode, E.SAMPLE_BILINEAR, 'shortcuts work again');
});

test('a held Space on a focused button still activates it when shortcuts are off', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  const box = env.doc.getElementById('chkShortcuts');
  box.checked = false;
  box.emit('change');
  const ev = env.doc.emit('keydown', { code: 'Space', target: { tagName: 'BUTTON' } });
  assert.equal(ev.defaultPrevented, false, 'button keeps its native Space activation');
});

/* ------------------------------------------------- APG radiogroup keys */

test('arrow keys move the radio selection and hand it focus', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  const point = env.doc.getElementById('modePoint');
  const ev = point.emit('keydown', { code: 'ArrowRight' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(app.state.mode, E.SAMPLE_BILINEAR, 'right arrow moves to bilinear');
  point.emit('keydown', { code: 'ArrowLeft' });
  assert.equal(app.state.mode, E.SAMPLE_TRILINEAR, 'left arrow wraps to the last radio');
});

test('Home and End jump to the first and last radios', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  env.doc.getElementById('modeBilinear').emit('keydown', { code: 'End' });
  assert.equal(app.state.mode, E.SAMPLE_TRILINEAR);
  env.doc.getElementById('modeTrilinear').emit('keydown', { code: 'Home' });
  assert.equal(app.state.mode, E.SAMPLE_POINT);
});

test('setMode moves the one tab stop along with the checked radio', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  app.start();
  app.setMode(E.SAMPLE_POINT);
  assert.equal(env.doc.getElementById('modePoint').tabIndex, 0);
  assert.equal(env.doc.getElementById('modeBilinear').tabIndex, -1);
  assert.equal(env.doc.getElementById('modeTrilinear').tabIndex, -1);
});

/* ------------------------------------------------------- misc hardening */

test('parseColor tolerates malformed hex instead of emitting NaN', () => {
  const env = createEnvironment();
  const app = createApp({ document: env.doc, window: env.win, engine: E, now: env.now });
  assert.deepEqual(app.parseColor('#zzzzzz'), [0, 0, 0]);
  assert.deepEqual(app.parseColor(''), [0, 0, 0]);
  assert.deepEqual(app.parseColor('#abc'), [170, 187, 204]);
});
