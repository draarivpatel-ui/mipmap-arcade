'use strict';
/*
 * A very small stand-in for the browser, just enough to run app.js under node:test.
 * It records what the page does (text, attributes, listeners, canvas calls) so the
 * smoke tests can assert on it. No dependencies.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readTokens() {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  const tokens = {};
  const re = /--([a-z0-9-]+):\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block))) tokens[m[1]] = m[2].trim();
  return tokens;
}

function makeContext() {
  const state = { calls: {}, images: 0, lastImage: null };
  const target = {
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) {
      state.images++;
      state.lastImage = img;
    }
  };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === '__state') return state;
      return function record() {
        state.calls[key] = (state.calls[key] || 0) + 1;
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    }
  });
  return ctx;
}

class FakeElement {
  constructor(id, tagName) {
    this.id = id;
    this.tagName = tagName || 'DIV';
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.children = [];
    this.textContent = '';
    this.hidden = false;
    this.value = '0';
    this.width = 0;
    this.height = 0;
    this.ownerDocument = null;
    this.ctx = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  emit(type, extra) {
    const event = Object.assign({
      type: type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    }, extra || {});
    (this.listeners[type] || []).forEach((fn) => fn(event));
    return event;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  querySelectorAll(selector) {
    if (selector === '[data-touch]') return this.children.filter((c) => c.dataset.touch);
    return [];
  }

  getContext() {
    if (!this.ctx) this.ctx = makeContext();
    return this.ctx;
  }

  focus() {}
  blur() {}
}

function createEnvironment(options) {
  const opts = Object.assign({ reducedMotion: false, audio: false, search: '', storage: null, blockStorage: false }, options || {});
  const tokens = readTokens();
  const elements = {};
  const docListeners = {};
  const winListeners = {};
  const rafQueue = [];
  const storageData = opts.storage || {};
  let clock = 0;

  const doc = {
    documentElement: {},
    body: new FakeElement('body', 'BODY'),
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = new FakeElement(id, id === 'split' ? 'INPUT' : 'DIV');
        elements[id].ownerDocument = doc;
        if (id === 'touch') {
          ['left', 'right', 'drift', 'brake', 'gas'].forEach((name) => {
            const b = new FakeElement('touch-' + name, 'BUTTON');
            b.dataset.touch = name;
            elements.touch.children.push(b);
          });
        }
      }
      return elements[id];
    },
    createElement(tag) {
      const el = new FakeElement('', String(tag).toUpperCase());
      el.ownerDocument = doc;
      return el;
    },
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    emit(type, extra) {
      const event = Object.assign({
        type: type,
        target: doc.body,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }
      }, extra || {});
      (docListeners[type] || []).forEach((fn) => fn(event));
      return event;
    }
  };

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.made = { oscillators: 0, gains: 0 };
      FakeAudioContext.instances.push(this);
    }
    createOscillator() {
      this.made.oscillators++;
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    createBiquadFilter() {
      return { type: '', frequency: { value: 0 }, connect() {} };
    }
    createGain() {
      this.made.gains++;
      return { gain: { value: 1 }, connect() {} };
    }
    resume() {
      this.state = 'running';
    }
  }
  FakeAudioContext.instances = [];

  const win = {
    document: doc,
    location: { search: opts.search },
    localStorage: {
      getItem(k) {
        if (opts.blockStorage) throw new Error('blocked');
        return Object.prototype.hasOwnProperty.call(storageData, k) ? storageData[k] : null;
      },
      setItem(k, v) {
        if (opts.blockStorage) throw new Error('blocked');
        storageData[k] = String(v);
      }
    },
    getComputedStyle() {
      return { getPropertyValue(name) { return tokens[String(name).replace(/^--/, '')] || ''; } };
    },
    matchMedia() {
      return { matches: opts.reducedMotion };
    },
    requestAnimationFrame(fn) {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame() {},
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    emit(type) {
      (winListeners[type] || []).forEach((fn) => fn({ type: type }));
    },
    AudioContext: opts.audio ? FakeAudioContext : undefined
  };

  return {
    doc: doc,
    win: win,
    tokens: tokens,
    storage: storageData,
    elements: elements,
    AudioContext: FakeAudioContext,
    now() { return clock; },
    advanceClock(ms) { clock += ms; },
    rafPending() { return rafQueue.length; },
    runFrames(count, ms) {
      const step = ms || 1000 / 60;
      for (let i = 0; i < count; i++) {
        const fn = rafQueue.shift();
        if (!fn) return i;
        clock += step;
        fn(clock);
      }
      return count;
    }
  };
}

module.exports = { createEnvironment, readTokens, ROOT, FakeElement };
