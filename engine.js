/*
 * Mipmap Arcade engine (LodZero). No dependencies, no game engine, no GPU API.
 * One file that works as a browser global (global MipmapEngine) and as a Node module,
 * so the same code is rendered in the page and verified by node:test.
 *
 * Contents: seeded PRNG, mip pyramid and texture filters, a software ground-plane
 * rasterizer with an exact screen-space Jacobian, spatial hash grid, SAT collision,
 * vehicle physics at a fixed 120 Hz step, track generation, race rules, an AI pace
 * car, and a run-length encoded ghost replay format.
 *
 * Coordinates: x to the east, y to the north, heading in radians counter-clockwise from east.
 * Steering input is negative for left and positive for right.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MipmapEngine = factory();
  }
}(typeof self === 'undefined' ? this : self, function () {
  'use strict';

  const FIXED_DT = 1 / 120;
  const TWO_PI = Math.PI * 2;
  const NO_LOD = -99;
  const SAMPLE_POINT = 0;
  const SAMPLE_BILINEAR = 1;
  const SAMPLE_TRILINEAR = 2;

  /* ------------------------------------------------------------------ */
  /* Small math helpers                                                  */
  /* ------------------------------------------------------------------ */

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function wrapAngle(a) {
    return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  }

  function wrapIndex(i, n) {
    return ((i % n) + n) % n;
  }

  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** Mulberry32: a tiny seedable generator that returns floats in [0, 1). */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Mipmap pyramid and texture filters                                  */
  /* ------------------------------------------------------------------ */

  function isPowerOfTwo(n) {
    return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  }

  function mipLevelCount(width, height) {
    return Math.log2(Math.max(width, height)) + 1;
  }

  /**
   * Builds the full chain down to one texel with a 2x2 box filter.
   * base is { width, height, data } with RGBA bytes. Sides must be powers of two.
   */
  function buildMipmapPyramid(base) {
    if (!isPowerOfTwo(base.width) || !isPowerOfTwo(base.height)) {
      throw new RangeError('texture sides must be powers of two');
    }
    if (base.data.length !== base.width * base.height * 4) {
      throw new RangeError('texture data length does not match its size');
    }
    const levels = [{ width: base.width, height: base.height, data: Uint8ClampedArray.from(base.data) }];
    const count = mipLevelCount(base.width, base.height);
    for (let l = 1; l < count; l++) {
      const prev = levels[l - 1];
      const w = Math.max(1, prev.width >> 1);
      const h = Math.max(1, prev.height >> 1);
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const y0 = Math.min(prev.height - 1, y * 2);
        const y1 = Math.min(prev.height - 1, y * 2 + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.min(prev.width - 1, x * 2);
          const x1 = Math.min(prev.width - 1, x * 2 + 1);
          const a = (y0 * prev.width + x0) * 4;
          const b = (y0 * prev.width + x1) * 4;
          const c = (y1 * prev.width + x0) * 4;
          const d = (y1 * prev.width + x1) * 4;
          const o = (y * w + x) * 4;
          for (let ch = 0; ch < 4; ch++) {
            data[o + ch] = (prev.data[a + ch] + prev.data[b + ch] + prev.data[c + ch] + prev.data[d + ch] + 2) >> 2;
          }
        }
      }
      levels.push({ width: w, height: h, data: data });
    }
    return { levels: levels, count: count, maxLevel: count - 1 };
  }

  /**
   * Level of detail from the screen-space texture footprint.
   * rho = max(length of the x derivative, length of the y derivative) measured in texels,
   * lambda = log2(rho). Derivatives are in normalized texture units per screen pixel.
   */
  function computeMipLevelFromJacobian(dudx, dvdx, dudy, dvdy, texWidth, texHeight) {
    const ax = dudx * texWidth;
    const bx = dvdx * texHeight;
    const ay = dudy * texWidth;
    const by = dvdy * texHeight;
    const rho = Math.max(Math.sqrt(ax * ax + bx * bx), Math.sqrt(ay * ay + by * by));
    return Math.log2(Math.max(rho, 0.00001));
  }

  function sampleNearest(level, u, v, out) {
    const x = wrapIndex(Math.floor(u * level.width), level.width);
    const y = wrapIndex(Math.floor(v * level.height), level.height);
    const i = (y * level.width + x) * 4;
    out[0] = level.data[i];
    out[1] = level.data[i + 1];
    out[2] = level.data[i + 2];
    out[3] = level.data[i + 3];
    return out;
  }

  function sampleBilinear(level, u, v, out) {
    const w = level.width;
    const h = level.height;
    const d = level.data;
    const fx = u * w - 0.5;
    const fy = v * h - 0.5;
    const x0f = Math.floor(fx);
    const y0f = Math.floor(fy);
    const tx = fx - x0f;
    const ty = fy - y0f;
    const x0 = wrapIndex(x0f, w);
    const x1 = wrapIndex(x0f + 1, w);
    const y0 = wrapIndex(y0f, h);
    const y1 = wrapIndex(y0f + 1, h);
    const i00 = (y0 * w + x0) * 4;
    const i10 = (y0 * w + x1) * 4;
    const i01 = (y1 * w + x0) * 4;
    const i11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 4; c++) {
      const top = lerp(d[i00 + c], d[i10 + c], tx);
      const bottom = lerp(d[i01 + c], d[i11 + c], tx);
      out[c] = lerp(top, bottom, ty);
    }
    return out;
  }

  const scratchLow = [0, 0, 0, 0];
  const scratchHigh = [0, 0, 0, 0];

  /** Trilinear: bilinear in two neighbouring pyramid levels, blended by the fraction of lambda. */
  function sampleTrilinearMipmap(pyramid, u, v, lambda, out) {
    const lam = clamp(lambda, 0, pyramid.maxLevel);
    const lo = Math.floor(lam);
    const hi = Math.min(lo + 1, pyramid.maxLevel);
    const t = lam - lo;
    sampleBilinear(pyramid.levels[lo], u, v, scratchLow);
    sampleBilinear(pyramid.levels[hi], u, v, scratchHigh);
    for (let c = 0; c < 4; c++) {
      out[c] = lerp(scratchLow[c], scratchHigh[c], t);
    }
    return out;
  }

  /** Point and bilinear never leave level zero, which is why they shimmer in the distance. */
  function sampleTexture(pyramid, mode, u, v, lambda, out) {
    if (mode === SAMPLE_TRILINEAR) {
      return sampleTrilinearMipmap(pyramid, u, v, lambda, out);
    }
    if (mode === SAMPLE_BILINEAR) {
      return sampleBilinear(pyramid.levels[0], u, v, out);
    }
    return sampleNearest(pyramid.levels[0], u, v, out);
  }

  /** A grayscale checker with fine grid lines and noise: plenty of high frequency detail to alias. */
  function generateDetailTexture(size, seed) {
    const rng = mulberry32(seed);
    const data = new Uint8ClampedArray(size * size * 4);
    const cell = Math.max(2, size >> 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const checker = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 0.62 : 0.4;
        const line = (x % cell === 0 || y % cell === 0) ? 0.22 : 0;
        const noise = (rng() - 0.5) * 0.12;
        const lum = clamp(checker + noise - line, 0, 1) * 255;
        const i = (y * size + x) * 4;
        data[i] = lum;
        data[i + 1] = lum;
        data[i + 2] = lum;
        data[i + 3] = 255;
      }
    }
    return { width: size, height: size, data: data };
  }

  /* ------------------------------------------------------------------ */
  /* Spatial hash grid and SAT collision                                 */
  /* ------------------------------------------------------------------ */

  class SpatialHashGrid {
    constructor(cellSize) {
      this.cellSize = cellSize;
      this.cells = new Map();
      this.entryCount = 0;
    }

    cellKey(ix, iy) {
      return (ix + 32768) * 65536 + (iy + 32768);
    }

    cellCoord(v) {
      return Math.floor(v / this.cellSize);
    }

    insert(id, minX, minY, maxX, maxY) {
      const x0 = this.cellCoord(minX);
      const x1 = this.cellCoord(maxX);
      const y0 = this.cellCoord(minY);
      const y1 = this.cellCoord(maxY);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const key = this.cellKey(ix, iy);
          let bucket = this.cells.get(key);
          if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
          }
          bucket.push(id);
          this.entryCount++;
        }
      }
    }

    /** Returns each id once, however many cells it spans. */
    query(minX, minY, maxX, maxY, out) {
      const result = out || [];
      result.length = 0;
      const seen = new Set();
      const x0 = this.cellCoord(minX);
      const x1 = this.cellCoord(maxX);
      const y0 = this.cellCoord(minY);
      const y1 = this.cellCoord(maxY);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iy = y0; iy <= y1; iy++) {
          const bucket = this.cells.get(this.cellKey(ix, iy));
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const id = bucket[k];
            if (!seen.has(id)) {
              seen.add(id);
              result.push(id);
            }
          }
        }
      }
      return result;
    }

    clear() {
      this.cells.clear();
      this.entryCount = 0;
    }

    forEachCell(callback) {
      for (const [key, bucket] of this.cells) {
        const ix = Math.floor(key / 65536) - 32768;
        const iy = (key % 65536) - 32768;
        callback(ix, iy, bucket.length);
      }
    }

    stats() {
      let maxPerCell = 0;
      for (const bucket of this.cells.values()) {
        if (bucket.length > maxPerCell) maxPerCell = bucket.length;
      }
      return { cells: this.cells.size, entries: this.entryCount, maxPerCell: maxPerCell };
    }
  }

  function makeObb(cx, cy, hx, hy, angle) {
    return { cx: cx, cy: cy, hx: hx, hy: hy, angle: angle };
  }

  function obbBounds(b) {
    const c = Math.abs(Math.cos(b.angle));
    const s = Math.abs(Math.sin(b.angle));
    const ex = b.hx * c + b.hy * s;
    const ey = b.hx * s + b.hy * c;
    return { minX: b.cx - ex, minY: b.cy - ey, maxX: b.cx + ex, maxY: b.cy + ey };
  }

  /**
   * Separating axis test for two oriented boxes.
   * Returns null when separated, otherwise the minimum translation: a unit normal
   * pointing from a toward b and the penetration depth.
   */
  function obbOverlap(a, b) {
    const axes = [
      [Math.cos(a.angle), Math.sin(a.angle)],
      [-Math.sin(a.angle), Math.cos(a.angle)],
      [Math.cos(b.angle), Math.sin(b.angle)],
      [-Math.sin(b.angle), Math.cos(b.angle)]
    ];
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    let depth = Infinity;
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < 4; i++) {
      const ax = axes[i][0];
      const ay = axes[i][1];
      const ra = a.hx * Math.abs(ax * Math.cos(a.angle) + ay * Math.sin(a.angle)) +
        a.hy * Math.abs(ax * -Math.sin(a.angle) + ay * Math.cos(a.angle));
      const rb = b.hx * Math.abs(ax * Math.cos(b.angle) + ay * Math.sin(b.angle)) +
        b.hy * Math.abs(ax * -Math.sin(b.angle) + ay * Math.cos(b.angle));
      const dist = dx * ax + dy * ay;
      const overlap = ra + rb - Math.abs(dist);
      if (overlap <= 0) return null;
      if (overlap < depth) {
        depth = overlap;
        const sign = dist < 0 ? -1 : 1;
        nx = ax * sign;
        ny = ay * sign;
      }
    }
    return { depth: depth, nx: nx, ny: ny };
  }

  /* ------------------------------------------------------------------ */
  /* Vehicle physics                                                     */
  /* ------------------------------------------------------------------ */

  const VEHICLE = {
    wheelbase: 3.6,
    engineAccel: 24,
    engineSpeedCap: 80,
    brakeAccel: 38,
    reverseAccel: 9,
    reverseSpeedCap: 10,
    dragCoef: 0.0035,
    rollingResist: 0.3,
    gripBase: 12.3,
    downforce: 0.0016,
    slipStiffness: 6,
    maxSteerAngle: 0.55,
    steerSpeedScale: 25,
    yawRate: 8,
    driftYawRate: 5.5,
    driftYawBoost: 1.35,
    yawGripMargin: 1.1,
    driftYawMargin: 2.2,
    yawLimitMinSpeed: 4,
    driftSlipEaseStart: 0.45,
    driftSlipEaseEnd: 0.9,
    driftGripScale: 0.55,
    driftMinSlip: 0.12,
    driftMinSpeed: 12,
    driftChargeRate: 1.1,
    boostMinCharge: 0.25,
    boostBaseTime: 0.4,
    boostExtraTime: 1.6,
    boostAccel: 18,
    heatPerSecond: 0.5,
    heatDecaySeconds: 2.5,
    overheatLimit: 1,
    overheatRecover: 0.35,
    minLongForSlip: 1.5
  };

  function createVehicle(x, y, heading) {
    return {
      x: x, y: y, heading: heading,
      vx: 0, vy: 0, omega: 0,
      speed: 0, slip: 0,
      boostCharge: 0, boostTimer: 0, heat: 0,
      overheated: false, drifting: false
    };
  }

  /** Longitudinal and lateral acceleration in world axes for velocity (vx, vy). */
  function vehicleAcceleration(v, vx, vy, input, surface, boosting, out) {
    const P = VEHICLE;
    const c = Math.cos(v.heading);
    const s = Math.sin(v.heading);
    const vLong = vx * c + vy * s;
    const vLat = -vx * s + vy * c;
    const speed = Math.sqrt(vx * vx + vy * vy);

    let aLong = 0;
    if (input.throttle > 0) {
      const taper = clamp(1 - vLong / P.engineSpeedCap, 0, 1);
      aLong += input.throttle * P.engineAccel * taper;
    }
    if (input.brake > 0) {
      if (vLong > 0.5) {
        aLong -= input.brake * P.brakeAccel;
      } else if (vLong > -P.reverseSpeedCap) {
        aLong -= input.brake * P.reverseAccel;
      }
    }
    if (boosting) aLong += P.boostAccel;

    const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), P.minLongForSlip));
    const downforce = P.downforce * vLong * vLong;
    const gripScale = (v.drifting ? P.driftGripScale : 1) * surface.gripScale;
    const gripLimit = (P.gripBase + downforce) * gripScale;
    const aLat = -gripLimit * Math.tanh(slipAngle * P.slipStiffness);

    let ax = aLong * c - aLat * s;
    let ay = aLong * s + aLat * c;

    ax -= P.dragCoef * speed * vx;
    ay -= P.dragCoef * speed * vy;
    if (speed > 0.0001) {
      const roll = P.rollingResist + surface.extraDrag;
      ax -= roll * vx / speed;
      ay -= roll * vy / speed;
    }
    out.ax = ax;
    out.ay = ay;
    out.slip = slipAngle;
    return out;
  }

  const accelScratch = { ax: 0, ay: 0, slip: 0 };

  const DEFAULT_SURFACE = { gripScale: 1, extraDrag: 0 };

  /**
   * One fixed step. Yaw uses semi-implicit Euler (new rate first, then heading from the new rate).
   * Position and velocity use the RK2 midpoint method.
   * input: { steer, throttle, brake, drift }.
   */
  function stepVehiclePhysics(v, input, dt, surface) {
    const P = VEHICLE;
    const surf = surface || DEFAULT_SURFACE;
    const c0 = Math.cos(v.heading);
    const s0 = Math.sin(v.heading);
    const vLong0 = v.vx * c0 + v.vy * s0;

    /* drift state and boost trigger */
    const wasDrifting = v.drifting;
    v.drifting = !!input.drift && Math.abs(vLong0) > P.driftMinSpeed * 0.5;
    if (wasDrifting && !v.drifting && v.boostCharge >= P.boostMinCharge && !v.overheated) {
      v.boostTimer = P.boostBaseTime + P.boostExtraTime * v.boostCharge;
      v.boostCharge = 0;
    }
    if (v.drifting && Math.abs(v.slip) > P.driftMinSlip && Math.abs(vLong0) > P.driftMinSpeed) {
      v.boostCharge = Math.min(1, v.boostCharge + Math.abs(v.slip) * P.driftChargeRate * dt);
    }

    /* boost and heat */
    const boosting = v.boostTimer > 0 && !v.overheated;
    if (boosting) {
      v.boostTimer = Math.max(0, v.boostTimer - dt);
      v.heat += P.heatPerSecond * dt;
      if (v.heat >= P.overheatLimit) {
        v.heat = P.overheatLimit;
        v.overheated = true;
        v.boostTimer = 0;
      }
    } else {
      v.heat *= Math.exp(-dt / P.heatDecaySeconds);
      if (v.overheated && v.heat <= P.overheatRecover) v.overheated = false;
    }

    /* yaw: semi-implicit Euler toward the steering-demanded rate */
    const steerAngle = input.steer * P.maxSteerAngle / (1 + Math.abs(vLong0) / P.steerSpeedScale);
    let yawTarget = -(vLong0 / P.wheelbase) * Math.tan(steerAngle);
    let rate = P.yawRate;
    if (v.drifting) {
      yawTarget *= P.driftYawBoost;
      rate = P.driftYawRate;
      if (yawTarget * v.slip < 0) {
        yawTarget *= 1 - smoothstep(P.driftSlipEaseStart, P.driftSlipEaseEnd, Math.abs(v.slip));
      }
    }
    /* the tires cannot turn the car faster than grip allows, except while deliberately sliding */
    const grip = (P.gripBase + P.downforce * vLong0 * vLong0) * surf.gripScale;
    const margin = v.drifting ? P.driftYawMargin : P.yawGripMargin;
    const yawLimit = margin * grip / Math.max(Math.abs(vLong0), P.yawLimitMinSpeed);
    yawTarget = clamp(yawTarget, -yawLimit, yawLimit);
    v.omega += (yawTarget - v.omega) * rate * dt;
    v.heading = wrapAngle(v.heading + v.omega * dt);

    /* RK2 midpoint for velocity and position */
    vehicleAcceleration(v, v.vx, v.vy, input, surf, boosting, accelScratch);
    const midVx = v.vx + accelScratch.ax * dt * 0.5;
    const midVy = v.vy + accelScratch.ay * dt * 0.5;
    vehicleAcceleration(v, midVx, midVy, input, surf, boosting, accelScratch);
    v.vx += accelScratch.ax * dt;
    v.vy += accelScratch.ay * dt;
    v.x += midVx * dt;
    v.y += midVy * dt;
    v.slip = accelScratch.slip;
    v.speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
    return v;
  }

  /* ------------------------------------------------------------------ */
  /* Track generation                                                    */
  /* ------------------------------------------------------------------ */

  const TRACK_DEFAULTS = {
    radius: 260,
    controlPoints: 16,
    samplesPerSegment: 20,
    halfWidth: 9,
    kerbWidth: 1.4,
    gateCount: 8,
    cellCount: 24,
    pylonCount: 14
  };

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * ((2 * p1) + (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (3 * p1 - p0 - 3 * p2 + p3) * t3);
  }

  /** Binary search with a fixed iteration budget: the segment whose start distance is at or below s. */
  function segmentIndexAtDistance(track, s) {
    const target = wrapDistance(track, s);
    let lo = 0;
    let hi = track.count - 1;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi + 1) >> 1;
      if (track.cum[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function wrapDistance(track, s) {
    return ((s % track.length) + track.length) % track.length;
  }

  function pointAtDistance(track, s) {
    const target = wrapDistance(track, s);
    const i = segmentIndexAtDistance(track, target);
    const j = (i + 1) % track.count;
    const t = (target - track.cum[i]) / track.segLen[i];
    return {
      x: lerp(track.xs[i], track.xs[j], t),
      y: lerp(track.ys[i], track.ys[j], t),
      heading: track.headings[i],
      curvature: track.curvature[i],
      index: i
    };
  }

  function nearestOnTrack(track, x, y) {
    const n = track.count;
    let best = Infinity;
    let bi = 0;
    let bt = 0;
    let bx = 0;
    let by = 0;
    for (let i = 0; i < n; i++) {
      const ax = track.xs[i];
      const ay = track.ys[i];
      const j = (i + 1) % n;
      const ex = track.xs[j] - ax;
      const ey = track.ys[j] - ay;
      const t = clamp(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey), 0, 1);
      const px = ax + ex * t;
      const py = ay + ey * t;
      const d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
        bx = px;
        by = py;
      }
    }
    const h = track.headings[bi];
    const offset = Math.cos(h) * (y - by) - Math.sin(h) * (x - bx);
    return {
      index: bi,
      t: bt,
      s: track.cum[bi] + bt * track.segLen[bi],
      x: bx,
      y: by,
      dist: Math.sqrt(best),
      offset: offset,
      heading: h
    };
  }

  /** Surface under the car: asphalt and kerb grip fully, grass grips less and drags. */
  function trackSurface(track, x, y) {
    const near = nearestOnTrack(track, x, y);
    const onRoad = near.dist <= track.halfWidth + track.kerbWidth;
    return {
      gripScale: onRoad ? 1 : 0.62,
      extraDrag: onRoad ? 0 : 7,
      onRoad: onRoad,
      near: near
    };
  }

  function generateTrackCircuit(seed, options) {
    const o = Object.assign({}, TRACK_DEFAULTS, options || {});
    const rng = mulberry32(seed);
    const maxAmps = [0.17, 0.11, 0.07];
    const harmonics = maxAmps.map(function (amp, i) {
      return { k: i + 1, amp: amp * (0.45 + 0.55 * rng()), phase: rng() * TWO_PI };
    });

    const n = o.controlPoints;
    const cx = [];
    const cy = [];
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TWO_PI;
      let r = 1;
      for (let h = 0; h < harmonics.length; h++) {
        r += harmonics[h].amp * Math.cos(harmonics[h].k * theta + harmonics[h].phase);
      }
      cx.push(Math.cos(theta) * o.radius * r);
      cy.push(Math.sin(theta) * o.radius * r);
    }

    const xs = [];
    const ys = [];
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = i;
      const c = (i + 1) % n;
      const d = (i + 2) % n;
      for (let k = 0; k < o.samplesPerSegment; k++) {
        const t = k / o.samplesPerSegment;
        xs.push(catmullRom(cx[a], cx[b], cx[c], cx[d], t));
        ys.push(catmullRom(cy[a], cy[b], cy[c], cy[d], t));
      }
    }

    const count = xs.length;
    const segLen = new Float64Array(count);
    const cum = new Float64Array(count);
    const headings = new Float64Array(count);
    let length = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      segLen[i] = Math.sqrt(dx * dx + dy * dy);
      headings[i] = Math.atan2(dy, dx);
      cum[i] = length;
      length += segLen[i];
    }
    const curvature = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const mean = (segLen[i] + segLen[j]) * 0.5;
      curvature[i] = wrapAngle(headings[j] - headings[i]) / mean;
    }

    const track = {
      seed: seed,
      count: count,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      segLen: segLen,
      cum: cum,
      headings: headings,
      curvature: curvature,
      length: length,
      halfWidth: o.halfWidth,
      kerbWidth: o.kerbWidth,
      gates: [],
      cells: [],
      pylons: []
    };

    /* gates: gate zero is the start and finish line */
    for (let g = 0; g < o.gateCount; g++) {
      const s = (g / o.gateCount) * length;
      const p = pointAtDistance(track, s);
      track.gates.push({
        id: g, kind: 'gate', s: s,
        box: makeObb(p.x, p.y, 1.5, o.halfWidth + 2, p.heading),
        active: true
      });
    }

    /* energy cells near the racing line, pylons toward the edges */
    for (let k = 0; k < o.cellCount; k++) {
      const s = ((k + 0.5) / o.cellCount) * length + (rng() - 0.5) * 12;
      const p = pointAtDistance(track, s);
      const side = (rng() - 0.5) * 2 * o.halfWidth * 0.6;
      const px = p.x - Math.sin(p.heading) * side;
      const py = p.y + Math.cos(p.heading) * side;
      track.cells.push({ id: k, kind: 'cell', s: wrapDistance(track, s), box: makeObb(px, py, 0.9, 0.9, 0), active: true });
    }
    for (let k = 0; k < o.pylonCount; k++) {
      const s = ((k + 0.25) / o.pylonCount) * length + rng() * 20;
      const p = pointAtDistance(track, s);
      const sign = rng() < 0.5 ? -1 : 1;
      const side = sign * o.halfWidth * (0.45 + 0.35 * rng());
      const px = p.x - Math.sin(p.heading) * side;
      const py = p.y + Math.cos(p.heading) * side;
      track.pylons.push({ id: k, kind: 'pylon', s: wrapDistance(track, s), box: makeObb(px, py, 0.7, 0.7, p.heading), active: true });
    }

    return track;
  }

  /* ------------------------------------------------------------------ */
  /* Distance fields for the ground rasterizer                           */
  /* ------------------------------------------------------------------ */

  /**
   * Bakes the distance to the track centre line and the arc length of the nearest
   * point into coarse grids. Sampling the distance bilinearly and thresholding it
   * gives crisp road edges from a small texture. Candidate segments come from a spatial hash.
   */
  function buildTrackFields(track, size, margin) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < track.count; i++) {
      minX = Math.min(minX, track.xs[i]);
      maxX = Math.max(maxX, track.xs[i]);
      minY = Math.min(minY, track.ys[i]);
      maxY = Math.max(maxY, track.ys[i]);
    }
    const extent = Math.max(maxX - minX, maxY - minY) + margin * 2;
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;
    const originX = midX - extent * 0.5;
    const originY = midY - extent * 0.5;
    const cell = extent / size;
    const reach = 40;

    const grid = new SpatialHashGrid(reach);
    for (let i = 0; i < track.count; i++) {
      const j = (i + 1) % track.count;
      grid.insert(i, Math.min(track.xs[i], track.xs[j]), Math.min(track.ys[i], track.ys[j]),
        Math.max(track.xs[i], track.xs[j]), Math.max(track.ys[i], track.ys[j]));
    }

    const dist = new Float32Array(size * size);
    const sArc = new Float32Array(size * size);
    const candidates = [];
    for (let gy = 0; gy < size; gy++) {
      for (let gx = 0; gx < size; gx++) {
        const wx = originX + (gx + 0.5) * cell;
        const wy = originY + (gy + 0.5) * cell;
        grid.query(wx - reach, wy - reach, wx + reach, wy + reach, candidates);
        let best = reach * reach;
        let bs = 0;
        for (let k = 0; k < candidates.length; k++) {
          const i = candidates[k];
          const j = (i + 1) % track.count;
          const ax = track.xs[i];
          const ay = track.ys[i];
          const ex = track.xs[j] - ax;
          const ey = track.ys[j] - ay;
          const t = clamp(((wx - ax) * ex + (wy - ay) * ey) / (ex * ex + ey * ey), 0, 1);
          const dx = wx - (ax + ex * t);
          const dy = wy - (ay + ey * t);
          const d2 = dx * dx + dy * dy;
          if (d2 < best) {
            best = d2;
            bs = track.cum[i] + t * track.segLen[i];
          }
        }
        dist[gy * size + gx] = Math.sqrt(best);
        sArc[gy * size + gx] = bs;
      }
    }
    return { size: size, originX: originX, originY: originY, cell: cell, reach: reach, dist: dist, s: sArc };
  }

  function fieldBilinear(fields, wx, wy) {
    const size = fields.size;
    const gx = (wx - fields.originX) / fields.cell - 0.5;
    const gy = (wy - fields.originY) / fields.cell - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const xa = clamp(x0, 0, size - 1);
    const xb = clamp(x0 + 1, 0, size - 1);
    const ya = clamp(y0, 0, size - 1);
    const yb = clamp(y0 + 1, 0, size - 1);
    const d = fields.dist;
    const top = lerp(d[ya * size + xa], d[ya * size + xb], tx);
    const bottom = lerp(d[yb * size + xa], d[yb * size + xb], tx);
    return lerp(top, bottom, ty);
  }

  function fieldNearestArc(fields, wx, wy) {
    const size = fields.size;
    const gx = clamp(Math.floor((wx - fields.originX) / fields.cell), 0, size - 1);
    const gy = clamp(Math.floor((wy - fields.originY) / fields.cell), 0, size - 1);
    return fields.s[gy * size + gx];
  }

  /* ------------------------------------------------------------------ */
  /* Software ground-plane rasterizer                                    */
  /* ------------------------------------------------------------------ */

  function createRenderTarget(width, height) {
    return {
      width: width,
      height: height,
      rgba: new Uint8ClampedArray(width * height * 4),
      lod: new Float32Array(width * height),
      heat: new Uint8ClampedArray(width * height * 4)
    };
  }

  /** Ground point to screen. Returns null at or behind the camera plane. */
  function projectGroundPoint(scene, width, wx, wy, wz) {
    const fx = Math.cos(scene.cameraHeading);
    const fy = Math.sin(scene.cameraHeading);
    const rx = Math.sin(scene.cameraHeading);
    const ry = -Math.cos(scene.cameraHeading);
    const relX = wx - scene.cameraX;
    const relY = wy - scene.cameraY;
    const depth = relX * fx + relY * fy;
    if (depth < 0.5) return null;
    const lateral = relX * rx + relY * ry;
    const scale = scene.focal / depth;
    return {
      x: width * 0.5 + lateral * scale,
      y: scene.horizonY + (scene.cameraHeight - (wz || 0)) * scale,
      scale: scale,
      depth: depth
    };
  }

  function mixInto(a, b, t, out) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }

  function edgeCoverage(d, edge, width) {
    return clamp((edge - d) / width + 0.5, 0, 1);
  }

  /**
   * Floor casting with exact derivatives. For screen row dy below the horizon the
   * depth is z = H * f / dy. World position is linear in x, so the Jacobian of
   * (u, v) with respect to screen x and y is analytic, not estimated.
   * scene: camera, texture pyramid, track fields, palette, sampling mode.
   */
  function renderGround(target, scene) {
    const W = target.width;
    const H = target.height;
    const rgba = target.rgba;
    const lod = target.lod;
    const pyr = scene.pyramid;
    const base = pyr.levels[0];
    const pal = scene.palette;
    const fields = scene.fields;
    const focal = scene.focal;
    const camH = scene.cameraHeight;
    const ts = scene.textureScale;
    const hw = scene.halfWidth;
    const kerb = scene.kerbWidth;
    const fwdX = Math.cos(scene.cameraHeading);
    const fwdY = Math.sin(scene.cameraHeading);
    const rgtX = Math.sin(scene.cameraHeading);
    const rgtY = -Math.cos(scene.cameraHeading);
    const tex = [0, 0, 0, 0];
    const color = [0, 0, 0];
    const region = [0, 0, 0];
    const stripe = [0, 0, 0];
    const stats = { skyRows: 0, groundPixels: 0, lodMin: Infinity, lodMax: -Infinity, lodSum: 0 };

    for (let y = 0; y < H; y++) {
      const dy = y + 0.5 - scene.horizonY;
      const rowStart = y * W;
      if (dy <= 0.001) {
        const t = clamp((y + 0.5) / Math.max(scene.horizonY, 1), 0, 1);
        mixInto(pal.skyTop, pal.skyHorizon, t, color);
        for (let x = 0; x < W; x++) {
          const o = (rowStart + x) * 4;
          rgba[o] = color[0];
          rgba[o + 1] = color[1];
          rgba[o + 2] = color[2];
          rgba[o + 3] = 255;
          lod[rowStart + x] = NO_LOD;
        }
        stats.skyRows++;
        continue;
      }
      const z = camH * focal / dy;
      const zOverF = z / focal;
      const dzdy = -z / dy;
      const rowX = scene.cameraX + fwdX * z;
      const rowY = scene.cameraY + fwdY * z;
      const fog = Math.pow(clamp(z / scene.fogDistance, 0, 1), 1.4);

      for (let x = 0; x < W; x++) {
        const dx = x + 0.5 - W * 0.5;
        const lateral = dx * zOverF;
        const wx = rowX + rgtX * lateral;
        const wy = rowY + rgtY * lateral;

        const dWxdx = rgtX * zOverF;
        const dWydx = rgtY * zOverF;
        const dWxdy = (fwdX + rgtX * dx / focal) * dzdy;
        const dWydy = (fwdY + rgtY * dx / focal) * dzdy;
        const lambda = computeMipLevelFromJacobian(dWxdx * ts, dWydx * ts, dWxdy * ts, dWydy * ts, base.width, base.height);

        sampleTexture(pyr, scene.mode, wx * ts, wy * ts, lambda, tex);
        const lum = tex[0] / 255;

        const footprint = Math.max(Math.sqrt(dWxdx * dWxdx + dWydx * dWydx), Math.sqrt(dWxdy * dWxdy + dWydy * dWydy), 0.05);
        const d = fieldBilinear(fields, wx, wy);
        const arc = fieldNearestArc(fields, wx, wy);

        const covOuter = edgeCoverage(d, hw + kerb, footprint);
        const covRoad = edgeCoverage(d, hw, footprint);
        const covDash = edgeCoverage(d, 0.28, footprint) * (arc % 12 < 5 ? 1 : 0);

        region[0] = pal.grass[0];
        region[1] = pal.grass[1];
        region[2] = pal.grass[2];
        const kerbColor = (Math.floor(arc / 5) & 1) === 0 ? pal.kerbA : pal.kerbB;
        mixInto(region, kerbColor, covOuter, region);
        mixInto(region, pal.asphalt, covRoad, region);
        mixInto(region, pal.dash, covDash, region);

        const strength = lerp(0.9, 0.45, covRoad);
        const shade = 1 + (lum - 0.5) * 2 * strength;
        stripe[0] = region[0] * shade;
        stripe[1] = region[1] * shade;
        stripe[2] = region[2] * shade;
        mixInto(stripe, pal.fog, fog, color);

        const o = (rowStart + x) * 4;
        rgba[o] = color[0];
        rgba[o + 1] = color[1];
        rgba[o + 2] = color[2];
        rgba[o + 3] = 255;
        lod[rowStart + x] = lambda;
        stats.groundPixels++;
        stats.lodSum += lambda;
        if (lambda < stats.lodMin) stats.lodMin = lambda;
        if (lambda > stats.lodMax) stats.lodMax = lambda;
      }
    }
    stats.lodMean = stats.groundPixels > 0 ? stats.lodSum / stats.groundPixels : 0;
    return stats;
  }

  /** Three-stop ramp: low lambda to high lambda. t is in [0, 1]. */
  function heatColor(t, ramp, out) {
    const u = clamp(t, 0, 1) * 2;
    if (u < 1) {
      return mixInto(ramp[0], ramp[1], u, out);
    }
    return mixInto(ramp[1], ramp[2], u - 1, out);
  }

  /** Colours every ground pixel by its level of detail. Sky pixels stay neutral. */
  function renderHeatmap(target, ramp, neutral, maxLevel) {
    const n = target.width * target.height;
    const color = [0, 0, 0];
    const heat = target.heat;
    for (let i = 0; i < n; i++) {
      const l = target.lod[i];
      if (l <= NO_LOD * 0.5) {
        color[0] = neutral[0];
        color[1] = neutral[1];
        color[2] = neutral[2];
      } else {
        heatColor(l / maxLevel, ramp, color);
      }
      const o = i * 4;
      heat[o] = color[0];
      heat[o + 1] = color[1];
      heat[o + 2] = color[2];
      heat[o + 3] = 255;
    }
    return heat;
  }

  /** Left of the split shows the lit scene, right of it shows the heatmap, with a divider column. */
  function compositeSplit(target, out, splitFraction, dividerColor) {
    const W = target.width;
    const H = target.height;
    const splitX = Math.round(clamp(splitFraction, 0, 1) * W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const src = x < splitX ? target.rgba : target.heat;
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
        out[o + 3] = 255;
      }
      if (splitX > 0 && splitX < W) {
        const o = (y * W + splitX) * 4;
        out[o] = dividerColor[0];
        out[o + 1] = dividerColor[1];
        out[o + 2] = dividerColor[2];
      }
    }
    return splitX;
  }

  /* ------------------------------------------------------------------ */
  /* Fixed timestep and frame statistics                                 */
  /* ------------------------------------------------------------------ */

  function createFixedStepper(dt, maxSteps) {
    return {
      dt: dt,
      maxSteps: maxSteps,
      accumulator: 0,
      advance: function advance(frameSeconds, stepFn) {
        this.accumulator += Math.max(0, frameSeconds);
        let steps = 0;
        for (; this.accumulator >= this.dt && steps < this.maxSteps; steps++) {
          stepFn(this.dt);
          this.accumulator -= this.dt;
        }
        if (steps >= this.maxSteps) this.accumulator = 0;
        return steps;
      },
      alpha: function alpha() {
        return this.accumulator / this.dt;
      }
    };
  }

  function createFrameStats(capacity) {
    return {
      capacity: capacity,
      samples: new Float64Array(capacity),
      count: 0,
      cursor: 0,
      push: function push(ms) {
        this.samples[this.cursor] = ms;
        this.cursor = (this.cursor + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
      },
      ordered: function ordered() {
        const out = [];
        const start = this.count < this.capacity ? 0 : this.cursor;
        for (let i = 0; i < this.count; i++) {
          out.push(this.samples[(start + i) % this.capacity]);
        }
        return out;
      },
      mean: function mean() {
        if (this.count === 0) return 0;
        let sum = 0;
        for (let i = 0; i < this.count; i++) sum += this.samples[i];
        return sum / this.count;
      },
      worst: function worst() {
        let w = 0;
        for (let i = 0; i < this.count; i++) {
          if (this.samples[i] > w) w = this.samples[i];
        }
        return w;
      },
      percentile: function percentile(p) {
        if (this.count === 0) return 0;
        const sorted = this.ordered().sort(function (a, b) { return a - b; });
        const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
        return sorted[idx];
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Input packing and ghost replay                                      */
  /* ------------------------------------------------------------------ */

  function quantizeInput(input) {
    const steerQ = Math.round(clamp(input.steer || 0, -1, 1) * 127);
    const throttleQ = Math.round(clamp(input.throttle || 0, 0, 1) * 15);
    const brakeQ = Math.round(clamp(input.brake || 0, 0, 1) * 15);
    return {
      steer: steerQ / 127,
      throttle: throttleQ / 15,
      brake: brakeQ / 15,
      drift: !!input.drift
    };
  }

  /** 17 bits: steer 8, throttle 4, brake 4, drift 1. */
  function packInput(input) {
    const steerQ = Math.round(clamp(input.steer || 0, -1, 1) * 127);
    const throttleQ = Math.round(clamp(input.throttle || 0, 0, 1) * 15);
    const brakeQ = Math.round(clamp(input.brake || 0, 0, 1) * 15);
    return (steerQ + 127) | (throttleQ << 8) | (brakeQ << 12) | ((input.drift ? 1 : 0) << 16);
  }

  function unpackInput(packed) {
    return {
      steer: ((packed & 0xFF) - 127) / 127,
      throttle: ((packed >> 8) & 0xF) / 15,
      brake: ((packed >> 12) & 0xF) / 15,
      drift: ((packed >> 16) & 1) === 1
    };
  }

  const GHOST_MAGIC = [0x4C, 0x5A, 0x47, 0x31];

  function writeVarint(out, value) {
    let v = value >>> 0;
    for (let i = 0; i < 5; i++) {
      const b = v & 0x7F;
      v >>>= 7;
      if (v > 0) {
        out.push(b | 0x80);
      } else {
        out.push(b);
        return;
      }
    }
  }

  function readVarint(bytes, cursor) {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      if (cursor.pos >= bytes.length) throw new RangeError('ghost replay is truncated');
      const b = bytes[cursor.pos];
      cursor.pos++;
      result |= (b & 0x7F) << (7 * i);
      if ((b & 0x80) === 0) return result >>> 0;
    }
    throw new RangeError('ghost replay has an oversized number');
  }

  /** Run-length encodes packed input frames: magic, seed, frame count, run count, then (length, value) pairs. */
  function encodeGhostReplay(seed, frames) {
    const runs = [];
    for (let i = 0; i < frames.length; i++) {
      const last = runs.length > 0 ? runs[runs.length - 1] : null;
      if (last && last.value === frames[i]) last.length++;
      else runs.push({ value: frames[i], length: 1 });
    }
    const out = GHOST_MAGIC.slice();
    writeVarint(out, seed);
    writeVarint(out, frames.length);
    writeVarint(out, runs.length);
    for (let r = 0; r < runs.length; r++) {
      writeVarint(out, runs[r].length);
      writeVarint(out, runs[r].value);
    }
    return Uint8Array.from(out);
  }

  function decodeGhostReplay(bytes) {
    for (let i = 0; i < GHOST_MAGIC.length; i++) {
      if (bytes[i] !== GHOST_MAGIC[i]) throw new RangeError('not a ghost replay');
    }
    const cursor = { pos: GHOST_MAGIC.length };
    const seed = readVarint(bytes, cursor);
    const total = readVarint(bytes, cursor);
    const runCount = readVarint(bytes, cursor);
    const frames = new Array(total);
    let filled = 0;
    for (let r = 0; r < runCount; r++) {
      const length = readVarint(bytes, cursor);
      const value = readVarint(bytes, cursor);
      if (filled + length > total) throw new RangeError('ghost replay runs exceed the frame count');
      for (let k = 0; k < length; k++) frames[filled + k] = value;
      filled += length;
    }
    if (filled !== total) throw new RangeError('ghost replay is shorter than its frame count');
    if (cursor.pos !== bytes.length) throw new RangeError('ghost replay has trailing bytes');
    return { seed: seed, frames: frames };
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function base64ToBytes(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Race rules                                                          */
  /* ------------------------------------------------------------------ */

  const RACE = {
    laps: 3,
    countdownSeconds: 3,
    carHalfLength: 2.1,
    carHalfWidth: 0.95,
    cellCharge: 0.34,
    pylonCooldown: 0.4,
    pylonScrub: 0.85,
    pylonBounce: 1.4,
    gridCell: 24,
    startOffset: 7
  };

  function createRace(seed, options) {
    const o = Object.assign({}, options || {});
    const track = generateTrackCircuit(seed, o.track);
    const start = pointAtDistance(track, track.length - RACE.startOffset);
    const car = createVehicle(start.x, start.y, start.heading);
    const grid = new SpatialHashGrid(RACE.gridCell);
    const entities = [];
    const all = track.gates.concat(track.cells, track.pylons);
    for (let i = 0; i < all.length; i++) {
      const e = Object.assign({}, all[i], { active: true, uid: i });
      const b = obbBounds(e.box);
      grid.insert(i, b.minX, b.minY, b.maxX, b.maxY);
      entities.push(e);
    }
    return {
      seed: seed,
      track: track,
      car: car,
      grid: grid,
      entities: entities,
      tick: 0,
      time: 0,
      phase: 'countdown',
      countdown: RACE.countdownSeconds,
      totalLaps: o.laps || RACE.laps,
      lap: 0,
      lapStart: 0,
      lapTimes: [],
      nextGate: 1,
      cells: 0,
      pylonHits: 0,
      pylonTimer: 0,
      progress: nearestOnTrack(track, car.x, car.y),
      inputLog: [],
      lastBroadphase: 0,
      lastNarrowphase: 0,
      queryBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    };
  }

  const ZERO_INPUT = { steer: 0, throttle: 0, brake: 0, drift: false };
  const brakeInput = { steer: 0, throttle: 0, brake: 1, drift: false };
  const candidateScratch = [];

  /** Advances one fixed step and returns the events it produced. */
  function stepRace(race, rawInput, dt) {
    const step = dt || FIXED_DT;
    const events = [];
    const input = quantizeInput(rawInput);
    race.inputLog.push(packInput(input));
    race.tick++;

    let applied = input;
    if (race.phase === 'countdown') {
      applied = ZERO_INPUT;
      race.countdown -= step;
      if (race.countdown <= 0) {
        race.countdown = 0;
        race.phase = 'running';
        events.push({ type: 'go', time: race.time });
      }
    } else if (race.phase === 'running') {
      race.time += step;
    } else {
      applied = brakeInput;
    }

    const car = race.car;
    const surface = trackSurface(race.track, car.x, car.y);
    stepVehiclePhysics(car, applied, step, surface);
    race.progress = surface.near;
    race.onRoad = surface.onRoad;
    race.pylonTimer = Math.max(0, race.pylonTimer - step);

    const carBox = makeObb(car.x, car.y, RACE.carHalfLength, RACE.carHalfWidth, car.heading);
    const b = obbBounds(carBox);
    race.queryBox = b;
    race.grid.query(b.minX, b.minY, b.maxX, b.maxY, candidateScratch);
    race.lastBroadphase = candidateScratch.length;
    let narrow = 0;
    for (let k = 0; k < candidateScratch.length; k++) {
      const e = race.entities[candidateScratch[k]];
      if (!e.active) continue;
      narrow++;
      const hit = obbOverlap(carBox, e.box);
      if (!hit) continue;
      if (e.kind === 'gate') {
        if (race.phase === 'running' && e.id === race.nextGate) {
          race.nextGate = (race.nextGate + 1) % race.track.gates.length;
          events.push({ type: 'gate', id: e.id, time: race.time });
          if (e.id === 0) {
            race.lapTimes.push(race.time - race.lapStart);
            race.lapStart = race.time;
            race.lap++;
            events.push({ type: 'lap', lap: race.lap, time: race.time });
            if (race.lap >= race.totalLaps) {
              race.phase = 'finished';
              events.push({ type: 'finish', time: race.time });
            }
          }
        }
      } else if (e.kind === 'cell') {
        e.active = false;
        race.cells++;
        car.boostCharge = Math.min(1, car.boostCharge + RACE.cellCharge);
        events.push({ type: 'cell', id: e.id, time: race.time });
      } else if (e.kind === 'pylon' && race.pylonTimer <= 0) {
        race.pylonTimer = RACE.pylonCooldown;
        race.pylonHits++;
        car.x -= hit.nx * hit.depth;
        car.y -= hit.ny * hit.depth;
        const vn = car.vx * hit.nx + car.vy * hit.ny;
        if (vn > 0) {
          car.vx -= RACE.pylonBounce * vn * hit.nx;
          car.vy -= RACE.pylonBounce * vn * hit.ny;
        }
        car.vx *= RACE.pylonScrub;
        car.vy *= RACE.pylonScrub;
        car.speed = Math.sqrt(car.vx * car.vx + car.vy * car.vy);
        events.push({ type: 'pylon', id: e.id, time: race.time });
      }
    }
    race.lastNarrowphase = narrow;
    return events;
  }

  /** FNV-1a over the bit patterns of the values that define a run. Equal hashes mean equal runs. */
  function hashRaceState(race) {
    const values = [race.car.x, race.car.y, race.car.heading, race.car.vx, race.car.vy, race.car.omega,
      race.car.boostCharge, race.car.heat, race.time, race.cells, race.pylonHits, race.lap, race.tick];
    const view = new DataView(new ArrayBuffer(8));
    let h = 0x811C9DC5;
    for (let i = 0; i < values.length; i++) {
      view.setFloat64(0, values[i]);
      for (let b = 0; b < 8; b++) {
        h ^= view.getUint8(b);
        h = Math.imul(h, 0x01000193);
      }
    }
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ */
  /* AI pace car                                                         */
  /* ------------------------------------------------------------------ */

  const AI = {
    lookaheadBase: 10,
    lookaheadSpeed: 0.5,
    steerGain: 2.2,
    cornerAccel: 11,
    cornerSafety: 0.95,
    minTarget: 16,
    maxTarget: 78,
    scanDistance: 90,
    scanStep: 6,
    speedTolerance: 1.5
  };

  /** Pure pursuit steering plus a curvature-limited speed target. Returns the same input shape a player makes. */
  function computeAIInput(race) {
    const car = race.car;
    const track = race.track;
    const near = race.progress;
    const speed = Math.max(car.speed, 0);
    const look = AI.lookaheadBase + speed * AI.lookaheadSpeed;
    const target = pointAtDistance(track, near.s + look);
    const bearing = Math.atan2(target.y - car.y, target.x - car.x);
    const error = wrapAngle(bearing - car.heading);
    const steer = clamp(-error * AI.steerGain, -1, 1);

    let maxCurve = 0;
    for (let d = 0; d <= AI.scanDistance; d += AI.scanStep) {
      const p = pointAtDistance(track, near.s + d);
      maxCurve = Math.max(maxCurve, Math.abs(p.curvature));
    }
    const limit = Math.sqrt(AI.cornerAccel / Math.max(maxCurve, 0.0005)) * AI.cornerSafety;
    const targetSpeed = clamp(limit, AI.minTarget, AI.maxTarget);

    let throttle = 0;
    let brake = 0;
    if (speed < targetSpeed - AI.speedTolerance) {
      throttle = 1;
    } else if (speed > targetSpeed + AI.speedTolerance) {
      brake = clamp((speed - targetSpeed) / 8, 0.2, 1);
    } else {
      throttle = 0.35;
    }
    return { steer: steer, throttle: throttle, brake: brake, drift: false };
  }

  /** Runs the pace car on a fresh race. Used by the tests and by the page for its lap benchmark. */
  function runAIRace(seed, maxSeconds, options) {
    const race = createRace(seed, options);
    const steps = Math.round(maxSeconds / FIXED_DT);
    let maxOffset = 0;
    for (let i = 0; i < steps && race.phase !== 'finished'; i++) {
      stepRace(race, computeAIInput(race), FIXED_DT);
      maxOffset = Math.max(maxOffset, Math.abs(race.progress.offset));
    }
    race.maxOffset = maxOffset;
    return race;
  }

  /** Re-simulates a recorded run from its input frames alone. */
  function replayRace(seed, frames, options) {
    const race = createRace(seed, options);
    for (let i = 0; i < frames.length; i++) {
      stepRace(race, unpackInput(frames[i]), FIXED_DT);
    }
    return race;
  }

  return {
    FIXED_DT: FIXED_DT,
    NO_LOD: NO_LOD,
    SAMPLE_POINT: SAMPLE_POINT,
    SAMPLE_BILINEAR: SAMPLE_BILINEAR,
    SAMPLE_TRILINEAR: SAMPLE_TRILINEAR,
    VEHICLE: VEHICLE,
    RACE: RACE,
    AI: AI,
    clamp: clamp,
    lerp: lerp,
    wrapAngle: wrapAngle,
    wrapIndex: wrapIndex,
    smoothstep: smoothstep,
    mulberry32: mulberry32,
    isPowerOfTwo: isPowerOfTwo,
    mipLevelCount: mipLevelCount,
    buildMipmapPyramid: buildMipmapPyramid,
    computeMipLevelFromJacobian: computeMipLevelFromJacobian,
    sampleNearest: sampleNearest,
    sampleBilinear: sampleBilinear,
    sampleTrilinearMipmap: sampleTrilinearMipmap,
    sampleTexture: sampleTexture,
    generateDetailTexture: generateDetailTexture,
    SpatialHashGrid: SpatialHashGrid,
    makeObb: makeObb,
    obbBounds: obbBounds,
    obbOverlap: obbOverlap,
    createVehicle: createVehicle,
    stepVehiclePhysics: stepVehiclePhysics,
    generateTrackCircuit: generateTrackCircuit,
    pointAtDistance: pointAtDistance,
    wrapDistance: wrapDistance,
    nearestOnTrack: nearestOnTrack,
    trackSurface: trackSurface,
    buildTrackFields: buildTrackFields,
    fieldBilinear: fieldBilinear,
    createRenderTarget: createRenderTarget,
    projectGroundPoint: projectGroundPoint,
    renderGround: renderGround,
    heatColor: heatColor,
    renderHeatmap: renderHeatmap,
    compositeSplit: compositeSplit,
    createFixedStepper: createFixedStepper,
    createFrameStats: createFrameStats,
    quantizeInput: quantizeInput,
    packInput: packInput,
    unpackInput: unpackInput,
    encodeGhostReplay: encodeGhostReplay,
    decodeGhostReplay: decodeGhostReplay,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    createRace: createRace,
    stepRace: stepRace,
    hashRaceState: hashRaceState,
    computeAIInput: computeAIInput,
    runAIRace: runAIRace,
    replayRace: replayRace
  };
}));
