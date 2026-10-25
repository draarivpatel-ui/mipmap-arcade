/*
 * Mipmap Arcade page logic.
 * Wires the engine to the DOM: input, the fixed-step loop, painting the pixel buffer,
 * sprites, the inspector panels and WebAudio. createApp takes its environment as an
 * argument so node:test can run the same code against a stand-in document.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = { createApp: factory };
  } else {
    root.MipmapArcade = factory;
    if (root.document && root.MipmapEngine) {
      const app = factory({
        document: root.document,
        window: root,
        engine: root.MipmapEngine,
        now: function () { return root.performance.now(); }
      });
      root.mipmapApp = app;
      app.start();
    }
  }
}(typeof self === 'undefined' ? this : self, function createApp(env) {
  'use strict';

  const doc = env.document;
  const win = env.window;
  const E = env.engine;
  const now = env.now;

  const VIEW_W = 480;
  const VIEW_H = 270;
  const HORIZON = 0.42;
  const FOV_DEGREES = 78;
  const CAM_BACK = 7.2;
  const CAM_HEIGHT = 3.2;
  const TEXTURE_SIZE = 256;
  const TEXTURE_PERIOD = 24;
  const FOG_DISTANCE = 420;
  const STEER_RATE = 5;
  const DEFAULT_SEED = 2026;
  const STORAGE_PREFIX = 'mipmap-arcade.';
  const UI_INTERVAL = 0.1;
  const POST_FINISH_TICKS = 480;
  const FRAME_CAPACITY = 120;

  const MODE_NOTES = [
    'Point sampling reads one texel of the full size level. Distant detail crawls and shimmers.',
    'Bilinear sampling smooths between four texels but never leaves the full size level, so the horizon still shimmers.',
    'Trilinear sampling blends two pyramid levels by the fraction of lambda, so the horizon stays calm.'
  ];
  const MODE_NAMES = ['Point', 'Bilinear', 'Trilinear'];

  const dom = {};
  function $(id) {
    if (!dom[id]) dom[id] = doc.getElementById(id);
    return dom[id];
  }

  /* ---------------------------------------------------------------- */
  /* Pure helpers                                                      */
  /* ---------------------------------------------------------------- */

  function parseColor(text) {
    const t = String(text).trim().replace('#', '');
    const full = t.length === 3 ? t[0] + t[0] + t[1] + t[1] + t[2] + t[2] : t;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }

  function rgbString(c, alpha) {
    return alpha === undefined
      ? 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'
      : 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + alpha + ')';
  }

  function formatTime(seconds) {
    const tenths = Math.round(Math.max(0, seconds) * 10);
    const m = Math.floor(tenths / 600);
    const s = (tenths % 600) / 10;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function kmh(metersPerSecond) {
    return Math.round(metersPerSecond * 3.6);
  }

  /* ---------------------------------------------------------------- */
  /* State                                                             */
  /* ---------------------------------------------------------------- */

  const state = {
    seed: DEFAULT_SEED,
    mode: E.SAMPLE_TRILINEAR,
    split: 0.55,
    driver: 'ai',
    assisted: false,
    race: null,
    ghost: null,
    ghostFrames: null,
    best: null,
    fields: null,
    fieldsSeed: 0,
    pyramid: null,
    target: null,
    palette: null,
    camHeading: 0,
    steer: 0,
    postFinish: 0,
    uiClock: 0,
    soundOn: false,
    reducedMotion: false,
    lastStats: null,
    probe: { lambda: 0, level: 0 },
    keys: {},
    touch: {},
    frames: 0
  };

  const stepper = E.createFixedStepper(E.FIXED_DT, 8);
  const frameStats = E.createFrameStats(FRAME_CAPACITY);
  const composite = new Uint8ClampedArray(VIEW_W * VIEW_H * 4);
  let imageData = null;
  let ctx = null;
  let lastFrameTime = 0;
  let rafId = 0;

  /* ---------------------------------------------------------------- */
  /* Storage                                                           */
  /* ---------------------------------------------------------------- */

  function storageGet(key) {
    try {
      return win.localStorage.getItem(STORAGE_PREFIX + key);
    } catch (err) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      win.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch (err) {
      /* storage can be blocked, the game still works without a saved best */
    }
  }

  function loadBest() {
    const time = parseFloat(storageGet('best.' + state.seed));
    const text = storageGet('ghost.' + state.seed);
    state.best = null;
    state.ghostFrames = null;
    if (!(time > 0) || !text) return;
    try {
      const decoded = E.decodeGhostReplay(E.base64ToBytes(text));
      if (decoded.seed === state.seed) {
        state.best = time;
        state.ghostFrames = decoded.frames;
      }
    } catch (err) {
      state.best = null;
    }
  }

  function saveBest(race) {
    const bytes = E.encodeGhostReplay(race.seed, race.inputLog);
    storageSet('best.' + race.seed, String(race.time));
    storageSet('ghost.' + race.seed, E.bytesToBase64(bytes));
    state.best = race.time;
    state.ghostFrames = race.inputLog.slice();
  }

  /* ---------------------------------------------------------------- */
  /* Tokens and assets                                                 */
  /* ---------------------------------------------------------------- */

  function readPalette() {
    const style = win.getComputedStyle(doc.documentElement);
    function token(name) {
      return parseColor(style.getPropertyValue('--' + name));
    }
    return {
      skyTop: token('sky-top'),
      skyHorizon: token('sky-horizon'),
      fog: token('fog'),
      grass: token('grass'),
      asphalt: token('asphalt'),
      kerbA: token('kerb-a'),
      kerbB: token('kerb-b'),
      dash: token('dash'),
      heat: [token('heat-0'), token('heat-1'), token('heat-2')],
      neutral: token('heat-neutral'),
      divider: token('divider'),
      ink: token('ink'),
      inkSoft: token('ink-2'),
      vermilionInk: token('vermilion-ink'),
      paper: token('paper'),
      paper2: token('paper-2'),
      rule: token('rule'),
      vermilion: token('vermilion'),
      cyan: token('cyan'),
      amber: token('amber'),
      fontMono: style.getPropertyValue('--font-mono')
    };
  }

  function buildTrack(seed) {
    state.seed = seed;
    loadBest();
    $('seedNote').textContent = 'Track seed ' + seed + (state.best ? '. Ghost saved at ' + formatTime(state.best) + '.' : '. No ghost yet.');
  }

  function newRace(driver, skipLoop) {
    if (!skipLoop) ensureLoop();
    state.driver = driver;
    state.assisted = false;
    state.postFinish = 0;
    state.steer = 0;
    state.race = E.createRace(state.seed);
    if (state.fieldsSeed !== state.seed) {
      state.fields = E.buildTrackFields(state.race.track, 256, 60);
      state.fieldsSeed = state.seed;
    }
    state.ghost = state.ghostFrames ? E.createRace(state.seed) : null;
    state.camHeading = state.race.car.heading;
    stepper.accumulator = 0;
    syncDriverUi();
    syncHud();
    announce('Race starting. Three laps.');
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  function keyActive(codes) {
    for (let i = 0; i < codes.length; i++) {
      if (state.keys[codes[i]]) return true;
    }
    return false;
  }

  function playerTarget() {
    const left = keyActive(['ArrowLeft', 'KeyA']) || state.touch.left;
    const right = keyActive(['ArrowRight', 'KeyD']) || state.touch.right;
    return {
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      throttle: keyActive(['ArrowUp', 'KeyW']) || state.touch.gas ? 1 : 0,
      brake: keyActive(['ArrowDown', 'KeyS']) || state.touch.brake ? 1 : 0,
      drift: keyActive(['Space']) || !!state.touch.drift
    };
  }

  function currentInput(dt) {
    if (state.driver === 'ai') {
      if (state.race.phase === 'running') state.assisted = true;
      return E.computeAIInput(state.race);
    }
    const target = playerTarget();
    const maxStep = STEER_RATE * dt;
    state.steer += E.clamp(target.steer - state.steer, -maxStep, maxStep);
    return { steer: state.steer, throttle: target.throttle, brake: target.brake, drift: target.drift };
  }

  function takeOver() {
    ensureLoop();
    if (state.driver === 'player') return;
    state.driver = 'player';
    state.steer = 0;
    syncDriverUi();
  }

  const DRIVING_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'];

  function isDrivingKey(code) {
    return DRIVING_KEYS.indexOf(code) >= 0;
  }

  function isTypingTarget(target) {
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  function isActivationTarget(target) {
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    return tag === 'BUTTON' || tag === 'A';
  }

  function onKeyDown(event) {
    const code = event.code;
    if (isTypingTarget(event.target)) return;
    ensureAudio();
    if (isDrivingKey(code)) {
      if (code === 'Space' && isActivationTarget(event.target)) return;
      event.preventDefault();
      state.keys[code] = true;
      takeOver();
      return;
    }
    if (code === 'Digit1') setMode(E.SAMPLE_POINT);
    else if (code === 'Digit2') setMode(E.SAMPLE_BILINEAR);
    else if (code === 'Digit3') setMode(E.SAMPLE_TRILINEAR);
    else if (code === 'KeyP') togglePace();
    else if (code === 'KeyM') toggleSound();
    else if (code === 'KeyR') newRace('player');
  }

  function onKeyUp(event) {
    if (isDrivingKey(event.code)) state.keys[event.code] = false;
  }

  function releaseAll() {
    state.keys = {};
    state.touch = {};
    const buttons = $('touch').querySelectorAll('[data-touch]');
    for (let i = 0; i < buttons.length; i++) buttons[i].dataset.active = 'false';
  }

  function bindTouch() {
    const buttons = $('touch').querySelectorAll('[data-touch]');
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const name = button.dataset.touch;
      const press = function (event) {
        event.preventDefault();
        ensureAudio();
        state.touch[name] = true;
        button.dataset.active = 'true';
        takeOver();
      };
      const release = function () {
        state.touch[name] = false;
        button.dataset.active = 'false';
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  function setMode(mode) {
    state.mode = mode;
    const ids = ['modePoint', 'modeBilinear', 'modeTrilinear'];
    for (let i = 0; i < ids.length; i++) {
      $(ids[i]).setAttribute('aria-checked', i === mode ? 'true' : 'false');
    }
    $('modeNote').textContent = MODE_NOTES[mode];
    announce(MODE_NAMES[mode] + ' sampling.');
  }

  function setSplit(fraction) {
    state.split = E.clamp(fraction, 0, 1);
    const pct = Math.round(state.split * 100);
    $('split').value = String(pct);
    $('splitValue').textContent = pct + '%';
    const style = $('viewport').style;
    if (style.setProperty) style.setProperty('--split', pct + '%');
    else style['--split'] = pct + '%';
  }

  function bindSplitGrip() {
    const grip = $('splitGrip');
    const viewport = $('viewport');
    let dragging = false;
    function move(event) {
      if (!dragging || !viewport.getBoundingClientRect) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width > 0) setSplit((event.clientX - rect.left) / rect.width);
    }
    function end(event) {
      dragging = false;
      grip.dataset.dragging = 'false';
      if (grip.releasePointerCapture && event && event.pointerId !== undefined) {
        try { grip.releasePointerCapture(event.pointerId); } catch (error) { /* capture already gone */ }
      }
    }
    grip.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      dragging = true;
      grip.dataset.dragging = 'true';
      if (grip.setPointerCapture && event.pointerId !== undefined) grip.setPointerCapture(event.pointerId);
    });
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  function togglePace() {
    ensureLoop();
    state.driver = state.driver === 'ai' ? 'player' : 'ai';
    state.steer = 0;
    syncDriverUi();
  }

  function syncDriverUi() {
    const ai = state.driver === 'ai';
    $('btnPace').setAttribute('aria-pressed', ai ? 'true' : 'false');
    $('modeBadge').textContent = ai ? 'Pace car driving' : 'You are driving';
    $('modeBadge').dataset.driver = state.driver;
  }

  /* ---------------------------------------------------------------- */
  /* Audio                                                             */
  /* ---------------------------------------------------------------- */

  const audio = { context: null, osc: null, gain: null, filter: null, armed: false };

  function ensureAudio() {
    if (!win.AudioContext) return;
    if (audio.context) {
      if (audio.context.state === 'suspended') audio.context.resume();
      return;
    }
    if (!audio.armed) {
      audio.armed = true;
      state.soundOn = true;
      syncSoundUi();
    }
    try {
      const context = new win.AudioContext();
      const osc = context.createOscillator();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      osc.type = 'sawtooth';
      filter.type = 'lowpass';
      filter.frequency.value = 600;
      gain.gain.value = 0.0001;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      osc.start();
      audio.context = context;
      audio.osc = osc;
      audio.filter = filter;
      audio.gain = gain;
    } catch (err) {
      audio.context = null;
    }
  }

  function updateAudio() {
    if (!audio.context) return;
    const speed = state.race.car.speed;
    const level = state.soundOn && state.race.phase === 'running' ? 0.05 + Math.min(speed / 80, 1) * 0.05 : 0.0001;
    audio.osc.frequency.value = 48 + speed * 3.1;
    audio.filter.frequency.value = 300 + speed * 22;
    audio.gain.gain.value = level;
  }

  function chime(high) {
    if (!audio.context || !state.soundOn) return;
    const base = high ? 880 : 660;
    const tones = [base, base * 1.5];
    for (let i = 0; i < tones.length; i++) {
      const osc = audio.context.createOscillator();
      const gain = audio.context.createGain();
      osc.type = 'sine';
      osc.frequency.value = tones[i];
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(audio.context.destination);
      osc.start(audio.context.currentTime + i * 0.08);
      osc.stop(audio.context.currentTime + 0.35 + i * 0.08);
    }
  }

  function toggleSound() {
    state.soundOn = !state.soundOn;
    if (state.soundOn) ensureAudio();
    syncSoundUi();
  }

  function syncSoundUi() {
    $('btnSound').setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
    $('soundLabel').textContent = state.soundOn ? 'Sound on' : 'Sound off';
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  function announce(text) {
    $('announcer').textContent = text;
  }

  let toastTimer = 0;
  function showToast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    toastTimer = 3;
  }

  function handleEvents(events) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'gate') {
        chime(false);
      } else if (e.type === 'cell') {
        chime(true);
      } else if (e.type === 'lap') {
        const last = state.race.lapTimes[state.race.lapTimes.length - 1];
        showToast('Lap ' + e.lap + ' in ' + formatTime(last));
        announce('Lap ' + e.lap + ' of ' + state.race.totalLaps + ', ' + formatTime(last));
      } else if (e.type === 'finish') {
        finishRace();
      } else if (e.type === 'go') {
        announce('Go');
      }
    }
  }

  function finishRace() {
    const race = state.race;
    const total = formatTime(race.time);
    if (state.assisted) {
      showToast('Pace car finished in ' + total);
      announce('Finished in ' + total + ' with the pace car helping. No ghost saved.');
      return;
    }
    if (state.best === null || race.time < state.best) {
      saveBest(race);
      showToast('New best ' + total + '. Ghost saved.');
      announce('New best time ' + total);
    } else {
      showToast('Finished in ' + total);
      announce('Finished in ' + total);
    }
  }

  function tick(dt) {
    const race = state.race;
    const input = currentInput(dt);
    handleEvents(E.stepRace(race, input, dt));
    if (state.ghost) {
      const index = race.tick - 1;
      if (index < state.ghostFrames.length) {
        E.stepRace(state.ghost, E.unpackInput(state.ghostFrames[index]), dt);
      }
    }
    if (race.phase === 'finished') {
      state.postFinish++;
      if (state.postFinish >= POST_FINISH_TICKS && state.driver === 'ai') {
        newRace('ai');
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function buildScene() {
    const car = state.race.car;
    return {
      cameraX: car.x - Math.cos(state.camHeading) * CAM_BACK,
      cameraY: car.y - Math.sin(state.camHeading) * CAM_BACK,
      cameraHeading: state.camHeading,
      cameraHeight: CAM_HEIGHT,
      focal: (VIEW_W * 0.5) / Math.tan((FOV_DEGREES * Math.PI / 180) * 0.5),
      horizonY: VIEW_H * HORIZON,
      pyramid: state.pyramid,
      fields: state.fields,
      palette: state.palette,
      mode: state.mode,
      textureScale: 1 / TEXTURE_PERIOD,
      halfWidth: state.race.track.halfWidth,
      kerbWidth: state.race.track.kerbWidth,
      fogDistance: FOG_DISTANCE
    };
  }

  function followCamera(dt) {
    const car = state.race.car;
    let want = car.heading;
    if (car.speed > 5) {
      want = car.heading + E.wrapAngle(Math.atan2(car.vy, car.vx) - car.heading) * 0.45;
    }
    const k = Math.min(1, dt * 5);
    state.camHeading = E.wrapAngle(state.camHeading + E.wrapAngle(want - state.camHeading) * k);
  }

  function drawCar(scene, car, fill, alpha) {
    const p = E.projectGroundPoint(scene, VIEW_W, car.x, car.y, 0);
    if (!p) return;
    const w = 2 * p.scale;
    const h = 1.15 * p.scale;
    const rel = E.wrapAngle(car.heading - scene.cameraHeading);
    const shear = E.clamp(rel, -0.8, 0.8) * w * 0.55;
    const pal = state.palette;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgbString(pal.ink, 0.28);
    ctx.fillRect(p.x - w * 0.6, p.y - h * 0.08, w * 1.2, h * 0.22);
    ctx.fillStyle = rgbString(pal.ink);
    ctx.fillRect(p.x - w * 0.5 - w * 0.08, p.y - h * 0.38, w * 0.16, h * 0.38);
    ctx.fillRect(p.x + w * 0.5 - w * 0.08, p.y - h * 0.38, w * 0.16, h * 0.38);
    ctx.fillStyle = rgbString(fill);
    ctx.fillRect(p.x - w * 0.5, p.y - h * 0.82, w, h * 0.55);
    ctx.fillRect(p.x - w * 0.34 + shear, p.y - h, w * 0.68, h * 0.28);
    ctx.fillStyle = rgbString(pal.paper2);
    ctx.fillRect(p.x - w * 0.26 + shear, p.y - h * 0.95, w * 0.52, h * 0.16);
    ctx.fillStyle = rgbString(pal.vermilion);
    ctx.fillRect(p.x - w * 0.46, p.y - h * 0.62, w * 0.2, h * 0.1);
    ctx.fillRect(p.x + w * 0.26, p.y - h * 0.62, w * 0.2, h * 0.1);
    if (car.boostTimer > 0) {
      ctx.fillStyle = rgbString(pal.amber);
      ctx.beginPath();
      ctx.moveTo(p.x - w * 0.18, p.y - h * 0.3);
      ctx.lineTo(p.x + w * 0.18, p.y - h * 0.3);
      ctx.lineTo(p.x, p.y + h * 0.55);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawSprites(scene) {
    const race = state.race;
    const pal = state.palette;
    const list = [];
    for (let i = 0; i < race.entities.length; i++) {
      const e = race.entities[i];
      if (!e.active) continue;
      const p = E.projectGroundPoint(scene, VIEW_W, e.box.cx, e.box.cy, 0);
      if (p && p.depth < FOG_DISTANCE) list.push({ e: e, p: p });
    }
    list.sort(function (a, b) { return b.p.depth - a.p.depth; });

    for (let i = 0; i < list.length; i++) {
      const e = list[i].e;
      const p = list[i].p;
      if (e.kind === 'pylon') {
        const w = 1.4 * p.scale;
        const h = 1.7 * p.scale;
        ctx.fillStyle = rgbString(pal.vermilion);
        ctx.beginPath();
        ctx.moveTo(p.x - w * 0.5, p.y);
        ctx.lineTo(p.x + w * 0.5, p.y);
        ctx.lineTo(p.x, p.y - h);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rgbString(pal.paper);
        ctx.fillRect(p.x - w * 0.25, p.y - h * 0.55, w * 0.5, h * 0.14);
      } else if (e.kind === 'cell') {
        const bob = state.reducedMotion ? 0 : Math.sin(race.time * 3 + e.id) * 0.15;
        const c = E.projectGroundPoint(scene, VIEW_W, e.box.cx, e.box.cy, 1.1 + bob);
        if (!c) continue;
        const r = 0.8 * c.scale;
        ctx.fillStyle = rgbString(pal.cyan);
        ctx.strokeStyle = rgbString(pal.ink);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - r);
        ctx.lineTo(c.x + r * 0.7, c.y);
        ctx.lineTo(c.x, c.y + r);
        ctx.lineTo(c.x - r * 0.7, c.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (e.kind === 'gate') {
        const side = race.track.halfWidth + 1.2;
        const nx = -Math.sin(e.box.angle);
        const ny = Math.cos(e.box.angle);
        const a = E.projectGroundPoint(scene, VIEW_W, e.box.cx + nx * side, e.box.cy + ny * side, 0);
        const b = E.projectGroundPoint(scene, VIEW_W, e.box.cx - nx * side, e.box.cy - ny * side, 0);
        const at = E.projectGroundPoint(scene, VIEW_W, e.box.cx + nx * side, e.box.cy + ny * side, 5.5);
        const bt = E.projectGroundPoint(scene, VIEW_W, e.box.cx - nx * side, e.box.cy - ny * side, 5.5);
        if (!a || !b || !at || !bt) continue;
        const isNext = e.id === race.nextGate;
        const color = e.id === 0 ? pal.vermilion : (isNext ? pal.cyan : pal.ink);
        ctx.strokeStyle = rgbString(color);
        ctx.lineWidth = Math.max(1, 0.35 * a.scale);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(at.x, at.y);
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(bt.x, bt.y);
        ctx.moveTo(at.x, at.y);
        ctx.lineTo(bt.x, bt.y);
        ctx.stroke();
      }
    }

    if (state.ghost) drawCar(scene, state.ghost.car, pal.cyan, 0.5);
    drawCar(scene, race.car, pal.ink, 1);

    const speedRatio = E.clamp(race.car.speed / 60, 0, 1);
    const probeY = Math.floor(VIEW_H * (0.8 - speedRatio * 0.34));
    ctx.strokeStyle = rgbString(pal.ink, 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(VIEW_W * 0.5, probeY, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  function probeLod() {
    const speedRatio = E.clamp(state.race.car.speed / 60, 0, 1);
    const x = Math.floor(VIEW_W * 0.5);
    const y = Math.floor(VIEW_H * (0.8 - speedRatio * 0.34));
    const lambda = state.target.lod[y * VIEW_W + x];
    state.probe.lambda = lambda;
    const max = state.pyramid.maxLevel;
    state.probe.level = state.mode === E.SAMPLE_TRILINEAR ? E.clamp(lambda, 0, max) : 0;
  }

  function renderView() {
    const scene = buildScene();
    state.lastStats = E.renderGround(state.target, scene);
    E.renderHeatmap(state.target, state.palette.heat, state.palette.neutral, state.pyramid.maxLevel);
    E.compositeSplit(state.target, composite, state.split, state.palette.divider);
    imageData.data.set(composite);
    ctx.putImageData(imageData, 0, 0);
    drawSprites(scene);
    probeLod();
  }

  /* Inspector panels --------------------------------------------------- */

  const levelCanvases = [];
  function levelCanvas(l) {
    if (!levelCanvases[l]) {
      const level = state.pyramid.levels[l];
      const off = doc.createElement('canvas');
      off.width = level.width;
      off.height = level.height;
      const offCtx = off.getContext('2d');
      const sample = offCtx.createImageData(level.width, level.height);
      sample.data.set(level.data);
      offCtx.putImageData(sample, 0, 0);
      levelCanvases[l] = off;
    }
    return levelCanvases[l];
  }

  /* x offsets of levels 2 and up, laid out left to right with a six pixel gap */
  function rowOffset(level) {
    let x = 0;
    for (let l = 2; l < level; l++) x += Math.max(1, (256 >> l) * 0.5) + 6;
    return x;
  }

  function drawPyramid() {
    const c = $('pyramidCanvas').getContext('2d');
    const pal = state.palette;
    const w = $('pyramidCanvas').width;
    const h = $('pyramidCanvas').height;
    c.fillStyle = rgbString(pal.paper2);
    c.fillRect(0, 0, w, h);
    const lo = Math.floor(state.probe.level);
    const hi = Math.min(lo + 1, state.pyramid.maxLevel);
    const scale = 0.5;
    c.font = '600 10px ' + pal.fontMono;
    c.textBaseline = 'middle';
    const tiny = [];
    for (let l = 0; l < state.pyramid.count; l++) {
      const level = state.pyramid.levels[l];
      const lw = Math.max(1, level.width * scale);
      const lh = Math.max(1, level.height * scale);
      /* level 0 on the left, level 1 beside it, the small levels in one row under level 1 */
      const x = l === 0 ? 4 : l === 1 ? 138 : 138 + rowOffset(l);
      const y = l <= 1 ? 4 : 76;
      c.drawImage(levelCanvas(l), x, y, lw, lh);
      const active = l === lo || (state.mode === E.SAMPLE_TRILINEAR && l === hi && state.probe.level > lo);
      c.strokeStyle = rgbString(active ? pal.vermilion : pal.rule);
      c.lineWidth = active ? 2 : 1;
      c.strokeRect(x - 0.5, y - 0.5, lw + 1, lh + 1);
      const size = level.width + (level.width === level.height ? '' : 'x' + level.height);
      const color = rgbString(active ? pal.vermilionInk : pal.inkSoft);
      if (l === 0) {
        c.fillStyle = rgbString(pal.paper, 0.92);
        c.fillRect(x + 4, y + lh - 19, 76, 15);
        c.fillStyle = rgbString(active ? pal.vermilionInk : pal.ink);
        c.fillText('L0  ' + size + ' px', x + 8, y + lh - 11);
      } else if (l === 1) {
        c.fillStyle = color;
        c.fillText('L1  ' + size, x + lw + 6, y + lh / 2);
      } else {
        tiny.push({ text: 'L' + l + ' ' + size, color: color });
      }
    }
    for (let i = 0; i < tiny.length; i++) {
      c.fillStyle = tiny[i].color;
      c.fillText(tiny[i].text, 138 + (i % 4) * 37, 118 + Math.floor(i / 4) * 13);
    }
    const lambda = state.probe.lambda;
    const lambdaText = lambda < -50 ? 'sky' : lambda.toFixed(2);
    if (state.mode === E.SAMPLE_TRILINEAR && state.probe.level > lo) {
      $('pyramidNote').textContent = 'Blending level ' + lo + ' and level ' + hi + ' at lambda ' + lambdaText + '.';
    } else if (state.mode === E.SAMPLE_TRILINEAR) {
      /* lambda at or below a whole level (below zero near the car) has no fraction to blend. */
      $('pyramidNote').textContent = 'Trilinear reads only level ' + lo + ' while lambda is ' + lambdaText + '.';
    } else {
      $('pyramidNote').textContent = MODE_NAMES[state.mode] + ' stays on level 0 while lambda is ' + lambdaText + '.';
    }
  }

  function drawFrameChart() {
    const c = $('frameCanvas').getContext('2d');
    const pal = state.palette;
    const w = $('frameCanvas').width;
    const h = $('frameCanvas').height;
    const maxMs = 40;
    c.fillStyle = rgbString(pal.paper2);
    c.fillRect(0, 0, w, h);
    const samples = frameStats.ordered();
    const barW = w / FRAME_CAPACITY;
    for (let i = 0; i < samples.length; i++) {
      const ms = samples[i];
      const bh = Math.min(1, ms / maxMs) * (h - 6);
      c.fillStyle = rgbString(ms > 16.7 ? pal.vermilion : pal.cyan);
      c.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
    }
    const line = h - (16.7 / maxMs) * (h - 6);
    c.strokeStyle = rgbString(pal.ink);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, line);
    c.lineTo(w, line);
    c.stroke();
    c.font = '600 10px ' + pal.fontMono;
    c.textBaseline = 'alphabetic';
    c.fillStyle = rgbString(pal.inkSoft);
    c.textAlign = 'left';
    c.fillText(maxMs + ' ms', 6, 13);
    c.fillStyle = rgbString(pal.paper2, 0.9);
    c.fillRect(w - 98, line - 17, 94, 13);
    c.textAlign = 'right';
    c.fillStyle = rgbString(pal.ink);
    c.fillText('16.7 ms, 60 fps', w - 6, line - 5);
    c.textAlign = 'left';
    $('frameNote').textContent = frameStats.count > 0
      ? 'Mean ' + frameStats.mean().toFixed(1) + ' ms, 95th percentile ' + frameStats.percentile(0.95).toFixed(1) +
        ' ms, worst ' + frameStats.worst().toFixed(1) + ' ms. The line marks 16.7 ms.'
      : 'Warming up.';
  }

  function drawHashMap() {
    const c = $('hashCanvas').getContext('2d');
    const pal = state.palette;
    const w = $('hashCanvas').width;
    const h = $('hashCanvas').height;
    const race = state.race;
    const track = race.track;
    c.fillStyle = rgbString(pal.paper2);
    c.fillRect(0, 0, w, h);
    const f = state.fields;
    const extent = f.cell * f.size;
    const scale = Math.min(w, h) / extent;
    const ox = (w - extent * scale) * 0.5;
    const oy = (h - extent * scale) * 0.5;
    function sx(x) { return ox + (x - f.originX) * scale; }
    function sy(y) { return oy + (extent - (y - f.originY)) * scale; }

    const cellSize = race.grid.cellSize;
    race.grid.forEachCell(function (ix, iy, count) {
      c.fillStyle = rgbString(pal.amber, Math.min(0.85, 0.2 + count * 0.18));
      c.fillRect(sx(ix * cellSize), sy((iy + 1) * cellSize), cellSize * scale, cellSize * scale);
    });

    c.strokeStyle = rgbString(pal.ink);
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= track.count; i++) {
      const k = i % track.count;
      if (i === 0) c.moveTo(sx(track.xs[k]), sy(track.ys[k]));
      else c.lineTo(sx(track.xs[k]), sy(track.ys[k]));
    }
    c.stroke();

    const q = race.queryBox;
    const qx0 = Math.floor(q.minX / cellSize);
    const qx1 = Math.floor(q.maxX / cellSize);
    const qy0 = Math.floor(q.minY / cellSize);
    const qy1 = Math.floor(q.maxY / cellSize);
    c.strokeStyle = rgbString(pal.vermilion);
    c.lineWidth = 1.5;
    c.strokeRect(sx(qx0 * cellSize), sy((qy1 + 1) * cellSize), (qx1 - qx0 + 1) * cellSize * scale, (qy1 - qy0 + 1) * cellSize * scale);

    c.fillStyle = rgbString(pal.vermilion);
    c.beginPath();
    c.arc(sx(race.car.x), sy(race.car.y), 3.5, 0, Math.PI * 2);
    c.fill();

    const stats = race.grid.stats();
    $('hashNote').textContent = stats.cells + ' cells hold ' + stats.entries + ' entries, at most ' + stats.maxPerCell +
      ' in one. The car checked ' + race.lastBroadphase + ' candidates and ran SAT on ' + race.lastNarrowphase + '.';
  }

  /* HUD and telemetry --------------------------------------------------- */

  /* Alternating the beat flag swaps the animation name, which restarts the pop in CSS. */
  function setCountdownText(text) {
    const el = $('countdown');
    if (el.textContent === text) return;
    el.textContent = text;
    el.dataset.beat = el.dataset.beat === 'a' ? 'b' : 'a';
  }

  function syncHud() {
    const race = state.race;
    const car = race.car;
    $('hudSpeed').textContent = String(kmh(car.speed));
    const lapNow = Math.min(race.lap + 1, race.totalLaps);
    $('hudLap').textContent = 'Lap ' + lapNow + ' of ' + race.totalLaps;
    $('hudTime').textContent = formatTime(race.time);
    $('hudBest').textContent = state.best === null ? 'no best yet' : 'best ' + formatTime(state.best);
    if (race.phase === 'countdown') {
      $('countdown').hidden = false;
      setCountdownText(String(Math.ceil(race.countdown)));
    } else if (race.phase === 'running' && race.time < 0.6) {
      $('countdown').hidden = false;
      setCountdownText('Go');
    } else {
      $('countdown').hidden = true;
    }
  }

  function syncTelemetry() {
    const race = state.race;
    const car = race.car;
    $('tSlip').textContent = (Math.abs(car.slip) * 180 / Math.PI).toFixed(1) + ' deg';
    const lambda = state.probe.lambda;
    $('tLambda').textContent = lambda < -50 ? 'sky' : lambda.toFixed(2);
    $('tLevel').textContent = state.probe.level.toFixed(2);
    $('tGates').textContent = (race.nextGate === 0 ? race.track.gates.length : race.nextGate) + ' of ' + race.track.gates.length;
    $('tCells').textContent = String(race.cells);
    $('tPylons').textContent = String(race.pylonHits);
    $('mBoost').value = car.boostCharge;
    $('mHeat').value = car.heat;
  }

  function updateUi(dt) {
    syncHud();
    state.uiClock += dt;
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) $('toast').hidden = true;
    }
    if (state.uiClock >= UI_INTERVAL) {
      state.uiClock = 0;
      syncTelemetry();
      drawPyramid();
      drawFrameChart();
      drawHashMap();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Loop                                                              */
  /* ---------------------------------------------------------------- */

  function frame(timestamp) {
    const dt = lastFrameTime === 0 ? 0 : Math.min(0.1, (timestamp - lastFrameTime) / 1000);
    lastFrameTime = timestamp;
    const started = now();
    stepper.advance(dt, tick);
    followCamera(dt);
    renderView();
    updateAudio();
    updateUi(dt);
    frameStats.push(now() - started);
    state.frames++;
    return dt;
  }

  function ensureLoop() {
    if (!rafId) rafId = win.requestAnimationFrame(loop);
  }

  function loop(timestamp) {
    frame(timestamp);
    rafId = win.requestAnimationFrame(loop);
  }

  function start() {
    state.reducedMotion = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    state.palette = readPalette();
    state.pyramid = E.buildMipmapPyramid(E.generateDetailTexture(TEXTURE_SIZE, 7));
    state.target = E.createRenderTarget(VIEW_W, VIEW_H);
    const canvas = $('view');
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    ctx = canvas.getContext('2d');
    imageData = ctx.createImageData(VIEW_W, VIEW_H);

    const params = new URLSearchParams(win.location && win.location.search ? win.location.search : '');
    const wanted = parseInt(params.get('seed'), 10);
    buildTrack(wanted > 0 ? wanted : DEFAULT_SEED);
    newRace('ai', true);
    setMode(E.SAMPLE_TRILINEAR);
    setSplit(state.split);
    syncSoundUi();

    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    doc.addEventListener('pointerdown', ensureAudio);
    win.addEventListener('blur', releaseAll);
    doc.addEventListener('visibilitychange', releaseAll);
    bindTouch();
    bindSplitGrip();

    const modeIds = ['modePoint', 'modeBilinear', 'modeTrilinear'];
    modeIds.forEach(function (id, index) {
      $(id).addEventListener('click', function () { setMode(index); });
    });
    $('split').addEventListener('input', function () { setSplit(parseFloat($('split').value) / 100); });
    $('btnStart').addEventListener('click', function () { newRace('player'); });
    $('btnPace').addEventListener('click', togglePace);
    $('btnSound').addEventListener('click', toggleSound);
    $('btnTrack').addEventListener('click', function () {
      buildTrack(state.seed + 1);
      newRace(state.driver);
    });

    /* one real step so every readout starts from a drawn frame */
    renderView();
    updateUi(UI_INTERVAL);
    if (!state.reducedMotion) {
      ensureLoop();
    } else {
      showToast('Reduced motion is on. Press Start race to begin.');
    }
  }

  return {
    state: state,
    start: start,
    frame: frame,
    tick: tick,
    setMode: setMode,
    setSplit: setSplit,
    newRace: newRace,
    buildTrack: buildTrack,
    togglePace: togglePace,
    toggleSound: toggleSound,
    parseColor: parseColor,
    rgbString: rgbString,
    formatTime: formatTime,
    kmh: kmh,
    finishRace: finishRace,
    loadBest: loadBest,
    audio: audio,
    onKeyDown: onKeyDown,
    onKeyUp: onKeyUp,
    playerTarget: playerTarget,
    stop: function stop() { win.cancelAnimationFrame(rafId); rafId = 0; },
    composite: composite
  };
}));
