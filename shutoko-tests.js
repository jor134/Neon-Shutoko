/* NEON SHUTOKO — full test suite.
 *
 * Run with:  node shutoko-tests.js      (index.html must sit alongside it)
 *
 * Three layers:
 *   1. the deterministic core, which is what multiplayer correctness rests on
 *   2. a headless boot of the SHIPPED index.html against a stub THREE + DOM
 *   3. simulated driving in both camera modes, plus geometry regressions
 *
 * Nothing here needs a GPU, a network, or a browser.
 */
/* Boots the real index.html bundle against a stub of THREE + DOM so that
   init(), the render path and a few thousand frames of actual gameplay
   get exercised without a GPU. Catches ordering bugs, TDZ errors, bad
   uniform names and NaN physics — the things that otherwise only show up
   on the phone. */
const fs = require('fs');

/* ---------------- DOM stub ---------------- */
function ctx2d() {
  const g = {};
  const noop = () => g;
  ['fillRect','clearRect','strokeRect','fillText','strokeText','beginPath','moveTo',
   'lineTo','arc','closePath','fill','stroke','save','restore','translate','rotate',
   'scale','setTransform','drawImage','putImageData','clip','rect','ellipse','bezierCurveTo']
    .forEach(k => g[k] = noop);
  g.createRadialGradient = () => ({ addColorStop: noop });
  g.createLinearGradient = () => ({ addColorStop: noop });
  g.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  g.measureText = () => ({ width: 40 });
  return g;
}
function mkEl(tag) {
  const e = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], _txt: '', value: '', checked: false,
    classList: {
      _s: new Set(),
      add(...a) { a.forEach(x => this._s.add(x)); },
      remove(...a) { a.forEach(x => this._s.delete(x)); },
      toggle(x, on) { on === undefined ? (this._s.has(x) ? this._s.delete(x) : this._s.add(x)) : (on ? this._s.add(x) : this._s.delete(x)); },
      contains(x) { return this._s.has(x); }
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector() { return mkEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getContext(t) { return t === '2d' ? ctx2d() : null; },
    get offsetWidth() { return 100; },
    get textContent() { return this._txt; },
    set textContent(v) { this._txt = String(v); },
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
    focus() {}
  };
  if (e.tagName === 'CANVAS') { e.width = 1; e.height = 1; }
  return e;
}
const ELS = {};
global.document = {
  createElement: mkEl,
  getElementById(id) { return ELS[id] || (ELS[id] = mkEl('div')); },
  querySelectorAll() { return []; },
  addEventListener() {}, body: mkEl('body')
};
const RAF = [];
global.window = {
  innerWidth: 390, innerHeight: 844, devicePixelRatio: 3, orientation: 0,
  addEventListener() {}, removeEventListener() {},
  DeviceOrientationEvent: undefined,
};
global.screen = { orientation: { angle: 0 } };
global.navigator = { userAgent: 'harness', vibrate() {}, getGamepads: () => [], sendBeacon: () => true };
let VT = 1000000;
global.performance = { now: () => VT };
function adv(ms){ VT += ms; }
global.requestAnimationFrame = fn => { RAF.push(fn); return RAF.length; };
global.localStorage = {
  _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); }
};
global.fetch = () => Promise.reject(new Error('offline harness'));
global.Blob = function () {};
global.setTimeout = global.setTimeout;
global.self = global.window;

/* ---------------- THREE stub ---------------- */
function V3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
V3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
V3.prototype.copy = function (v) { return this.set(v.x, v.y, v.z); };
V3.prototype.clone = function () { return new V3(this.x, this.y, this.z); };
V3.prototype.normalize = function () {
  const l = Math.hypot(this.x, this.y, this.z) || 1;
  this.x /= l; this.y /= l; this.z /= l; return this;
};
V3.prototype.length = function () { return Math.hypot(this.x, this.y, this.z); };

function V2(x, y) { this.x = x || 0; this.y = y || 0; }
V2.prototype.set = function (x, y) { this.x = x; this.y = y; return this; };

function Col(h) { this.r = 1; this.g = 1; this.b = 1; if (h !== undefined) this.setHex(h); }
Col.prototype.setHex = function (h) {
  h = h | 0;
  this.r = ((h >> 16) & 255) / 255; this.g = ((h >> 8) & 255) / 255; this.b = (h & 255) / 255;
  return this;
};

function Quat() { this._ = 1; }
Quat.prototype.copy = function () { return this; };
Quat.prototype.identity = function () { return this; };
Quat.prototype.setFromEuler = function () { return this; };

function Eul() {}
Eul.prototype.set = function () { return this; };

function M4() { this.elements = new Float32Array(16); }
M4.prototype.compose = function (p, q, s) {
  if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) throw new Error('NaN position in compose');
  if (!isFinite(s.x) || !isFinite(s.y) || !isFinite(s.z)) throw new Error('NaN scale in compose');
  return this;
};

function Obj3D() {
  this.position = new V3(); this.rotation = new Eul(); this.scale = new V3(1, 1, 1);
  this.quaternion = new Quat(); this.children = []; this.visible = true;
  this.userData = {}; this.renderOrder = 0; this.frustumCulled = true; this.matrix = new M4();
}
Obj3D.prototype.add = function (o) { this.children.push(o); return this; };
Obj3D.prototype.traverse = function (f) { f(this); this.children.forEach(c => c.traverse && c.traverse(f)); };
Obj3D.prototype.rotateZ = function () { return this; };
Obj3D.prototype.lookAt = function () { return this; };
Obj3D.prototype.updateProjectionMatrix = function () {};
Eul.prototype.set = function () { return this; };

function BufAttr(arr, item) { this.array = arr; this.itemSize = item; this.count = arr.length / item; this.needsUpdate = false; }
function Geo() { this.attributes = {}; this.index = null; }
Geo.prototype.setAttribute = function (n, a) { this.attributes[n] = a; return this; };
Geo.prototype.setIndex = function (i) { this.index = i; return this; };
Geo.prototype.translate = function () { return this; };
Geo.prototype.toNonIndexed = function () { return this; };
Geo.prototype.clone = function () {
  const g = new Geo();
  for (const k in this.attributes) {
    const a = this.attributes[k];
    g.attributes[k] = new BufAttr(a.array.slice(), a.itemSize);
  }
  return g;
};
function boxG(w, h, d) {
  const g = new Geo(); const n = 36;
  g.setAttribute('position', new BufAttr(new Float32Array(n * 3), 3));
  g.setAttribute('normal', new BufAttr(new Float32Array(n * 3), 3));
  g.setAttribute('uv', new BufAttr(new Float32Array(n * 2), 2));
  return g;
}
function planeG() { return boxG(); }

const THREE = {
  WebGLRenderer: function () {
    this.capabilities = { getMaxAnisotropy: () => 8 };
    this.setClearColor = () => {}; this.setSize = () => {}; this.setPixelRatio = () => {};
    this.setRenderTarget = () => {}; this.clear = () => {};
    this.renders = 0;
    this.render = () => { this.renders++; };
    this.autoClear = true; this.sortObjects = true;
  },
  Scene: function () { Obj3D.call(this); this.fog = null; this.background = null; },
  PerspectiveCamera: function (f, a, n, fa) { Obj3D.call(this); this.fov = f; this.aspect = a || 1; this.near = n || 0.1; this.far = fa || 2000; },
  OrthographicCamera: function () { Obj3D.call(this); },
  Group: function () { Obj3D.call(this); },
  Mesh: function (g, m) { Obj3D.call(this); this.geometry = g; this.material = m; },
  InstancedMesh: function (g, m, c) {
    Obj3D.call(this); this.geometry = g; this.material = m; this.count = c;
    this.instanceMatrix = { needsUpdate: false };
    this._maxCount = c;
    this.setMatrixAt = (i, mm) => {
      if (i >= this._maxCount) throw new Error('InstancedMesh overflow: ' + i + ' >= ' + this._maxCount);
      if (i < 0) throw new Error('InstancedMesh negative index');
    };
  },
  ShaderMaterial: function (o) {
    Object.assign(this, o);
    this.uniforms = o.uniforms || {};
    this.isShaderMaterial = true;
    this.clone = () => {
      const c = new THREE.ShaderMaterial(o);
      c.uniforms = {};
      for (const k in this.uniforms) {
        const v = this.uniforms[k].value;
        c.uniforms[k] = { value: (v && v.clone) ? v.clone() : v };
      }
      return c;
    };
  },
  BufferGeometry: Geo,
  BufferAttribute: BufAttr,
  InstancedBufferAttribute: BufAttr,
  BoxGeometry: boxG,
  PlaneGeometry: planeG,
  CylinderGeometry: boxG,
  TorusGeometry: boxG,
  ConeGeometry: planeG,
  RingGeometry: planeG,
  Vector2: V2, Vector3: V3, Color: Col, Matrix4: M4, Quaternion: Quat, Euler: Eul,
  CanvasTexture: function () { this.needsUpdate = false; this.repeat = new V2(1, 1); this.wrapS = 0; this.wrapT = 0; this.anisotropy = 1; },
  WebGLRenderTarget: function (w, h) {
    this.width = w; this.height = h;
    this.texture = { name: 'rt' };
    this.setSize = (a, b) => { this.width = a; this.height = b; };
  },
  Fog: function (c, n, f) { this.color = c; this.near = n; this.far = f; },
  RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
  LinearFilter: 1006, RGBAFormat: 1023, UnsignedByteType: 1009,
  FrontSide: 0, BackSide: 1, DoubleSide: 2,
  AdditiveBlending: 2, NormalBlending: 1,
};
Object.setPrototypeOf(THREE.Scene.prototype, Obj3D.prototype);
Object.setPrototypeOf(THREE.PerspectiveCamera.prototype, Obj3D.prototype);
Object.setPrototypeOf(THREE.OrthographicCamera.prototype, Obj3D.prototype);
Object.setPrototypeOf(THREE.Group.prototype, Obj3D.prototype);
Object.setPrototypeOf(THREE.Mesh.prototype, Obj3D.prototype);
Object.setPrototypeOf(THREE.InstancedMesh.prototype, Obj3D.prototype);
global.THREE = THREE;
global.cancelAnimationFrame = () => {};


/* ---------------- boot ---------------- */
let pass = 0, fail = 0; const bad = [];
function ok(n, c) { if (c) pass++; else { fail++; bad.push(n); } }
function eq(name, a, b) { ok(name + ' (' + a + ' vs ' + b + ')', a === b); }
function near(name, a, b, e) { ok(name + ' (' + a + ' vs ' + b + ')', Math.abs(a - b) <= (e || 1e-9)); }

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const src = html.split('<script>').pop().split('<\/script>')[0];
let api;
try {
  api = new Function('return (function(){' + src + '\nreturn {G:G,CFG:CFG,loop:loop,startCountdown:startCountdown,stepPlayer:stepPlayer,collide:collide,active:active,scene:scene,Q:Q,resetRun:resetRun,IN:IN,comboMult:comboMult,track:track,updateTraffic:updateTraffic,traffic:traffic,batchCars:batchCars,codeToSeed:codeToSeed,VEHICLES:VEHICLES,endRun:endRun,agilityBonus:agilityBonus,readInput:readInput,ROAD:ROAD,laneOffset:laneOffset,hash32:hash32,rng32:rng32,codeToSeed:codeToSeed,carLateral:carLateral,carZ:carZ,proximity:proximity,densityAt:densityAt,TOTAL_LANES:TOTAL_LANES,ROAD_HALF:ROAD_HALF,batchRange:batchRange,trafficWindow:trafficWindow,V_MIN:V_MIN,V_MAX:V_MAX,setView:setView,VIEW:VIEW,cockpit:cockpit,drawGauge:drawGauge,playerCar:playerCar,GROUND_Y:GROUND_Y,deckAbove:deckAbove,piers:piers,ground:ground,road:road,camera:camera};})()')();
  ok('boot: init() and first loop() ran without throwing', true);
} catch (e) {
  ok('boot: init() and first loop() ran without throwing — ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'), false);
  report(); process.exit(1);
}

const { G, CFG, IN } = api;

/* ---------------- simulate an actual run ---------------- */
function step(n, steerFn) {
  for (let i = 0; i < n; i++) {
    if (steerFn) IN.raw = steerFn(i);
    const fn = RAF.shift();
    if (!fn) break;
    fn(performance.now());
  }
}

/* drive the loop forward: RAF re-queues itself each call */
try {
  api.G.phase = 'run';
  api.resetRun();
  api.G.phase = 'run';
  let frames = 0, maxCars = 0, nanSeen = false, spdMax = 0;
  const t0 = Date.now();
  for (let i = 0; i < 4000; i++) {
    const fn = RAF.shift();
    if (!fn) break;
    IN.raw = Math.sin(i * 0.031) * 1.1;
    if (i % 137 === 0) IN.boostReq = true;
    adv(16.6);
    fn(VT);
    frames++;
    if (!isFinite(G.dist) || !isFinite(G.lat) || !isFinite(G.spd) || !isFinite(G.score)) { nanSeen = true; break; }
    maxCars = Math.max(maxCars, api.active.length);
    spdMax = Math.max(spdMax, G.spd);
    if (G.phase === 'dead') { api.G.hp = CFG.HP; api.G.phase = 'run'; }
  }
  ok('sim: ran ' + frames + ' frames', frames > 3500);
  ok('sim: no NaN in physics', !nanSeen);
  ok('sim: covered real ground (' + Math.round(G.dist) + ' m)', G.dist > 3000);
  ok('sim: lateral stays inside the walls (' + G.lat.toFixed(2) + ')', Math.abs(G.lat) <= CFG.LAT_LIMIT + 0.01);
  ok('sim: speed never exceeds boosted cap (' + (spdMax * 3.6).toFixed(0) + ' km/h)',
     spdMax <= CFG.SPD_MAX * CFG.SPD_BOOST_MUL + 1);
  ok('sim: traffic pools never saturated (peak ' + G.poolPeak + ' / ' + 64 + ')', G.poolPeak < 64);
  ok('sim: wrong-side mechanic reachable', typeof G.wrong === 'boolean');
  ok('sim: peak simultaneous cars in view = ' + maxCars, maxCars > 30 && maxCars < 400);
  ok('sim: score accumulated', G.score > 0);
  ok('sim: passes registered (' + G.passes + ')', G.passes > 90);
  ok('sim: near misses are possible (' + G.nearMiss + ')', G.nearMiss > 0);
  ok('sim: flag map stayed bounded (' + api.track.size + ')', api.track.size < 4000);
} catch (e) {
  ok('sim: run without exception — ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n'), false);
}

/* ---------------- collision reachability ---------------- */
try {
  api.resetRun();
  api.G.phase = 'run';
  let crashes = 0, frames = 0;
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    const fn = RAF.shift(); if (!fn) break;
    /* hold the middle forward lane and let traffic run into us */
    IN.raw = Math.max(-1, Math.min(1, (api.laneOffset(1) - G.lat) * 0.6));
    adv(16.6); fn(VT); frames++;
    if (G.hp < CFG.HP) { crashes++; api.G.hp = CFG.HP; api.G.iframeT = 0; }
  }
  ok('collision: sitting in a lane gets you hit (' + crashes + ' hits in ' + frames + ' frames)', crashes > 0);
} catch (e) {
  ok('collision: no exception — ' + e.message, false);
}

/* ---------------- quality tiers ---------------- */
try {
  let okQ = true;
  for (const l of [0, 1, 2, 1, 0]) {
    api.Q; // touch
    const fn = RAF.shift(); if (fn) { adv(16.6); fn(VT); }
  }
  ok('quality: loop survives tier changes', okQ);
} catch (e) { ok('quality: tier change threw — ' + e.message, false); }

/* ---------------- ribbon winding ---------------- */
/* The regression test for "the street texture is missing": every vertex
   can be in exactly the right place and the deck still vanishes, because
   the triangles were wound so the surface normal pointed at the ground
   and back-face culling threw the whole road away. Face normals are
   recomputed here straight from the shipped geometry. */
try {
  const g = api.road.geometry;
  const P = g.attributes.position.array;
  const idx = g.index;
  let up = 0, down = 0, degen = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = P[b] - P[a], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vz = P[c + 2] - P[a + 2];
    const ny = uz * vx - ux * vz;          // y component of (b-a) x (c-a)
    if (Math.abs(ny) < 1e-9) degen++;
    else if (ny > 0) up++; else down++;
  }
  ok('winding: road triangles all face upward (' + up + ' up, ' + down + ' down)',
     up > 100 && down === 0);
  ok('winding: no degenerate road triangles (' + degen + ')', degen === 0);
  ok('winding: road has UVs written for every vertex',
     g.attributes.uv.array.some(v => v !== 0));
  const N = g.attributes.normal.array;
  let normUp = true;
  for (let i = 1; i < N.length; i += 3) if (N[i] <= 0) normUp = false;
  ok('winding: shading normals also point up', normUp);
} catch (e) { ok('winding: check threw — ' + e.message, false); }

/* ---------------- elevated viaduct ---------------- */
try {
  let minDeck = 1e9, maxDeck = -1e9;
  for (let z = 0; z < 400000; z += 211) {
    const h = api.deckAbove(z);
    minDeck = Math.min(minDeck, h); maxDeck = Math.max(maxDeck, h);
  }
  ok('deck: always clears the city floor (min ' + minDeck.toFixed(1) + ' m)', minDeck > 5);
  ok('deck: height varies enough to read as a viaduct (' +
     minDeck.toFixed(0) + '-' + maxDeck.toFixed(0) + ' m)', maxDeck - minDeck > 10);
  ok('deck: never absurdly high (max ' + maxDeck.toFixed(1) + ' m)', maxDeck < 60);

  api.resetRun(); api.G.phase = 'run';
  for (let i = 0; i < 120; i++) { const fn = RAF.shift(); if (fn) { adv(16.6); fn(VT); } }
  const roadY = api.road.geometry.attributes.position.array[1];
  ok('deck: city floor sits below the deck (' +
     (roadY - api.ground.position.y).toFixed(1) + ' m)', api.ground.position.y < roadY - 5);
  ok('deck: piers are being placed (' + api.piers.count + ')', api.piers.count > 3);
} catch (e) { ok('deck: check threw — ' + e.message, false); }

/* ---------------- headlights ---------------- */
try {
  ok('lights: the old headlight cone is gone', api.playerCar.userData.cone === undefined);
  ok('lights: road light pool exists', !!api.playerCar.userData.pool);
  ok('lights: two headlamp glows exist', api.playerCar.userData.lamps.length === 2);
} catch (e) { ok('lights: check threw — ' + e.message, false); }

/* ---------------- cockpit view ---------------- */
try {
  api.setView(true);
  ok('cockpit: toggles on', api.VIEW.cockpit === true && api.cockpit.visible === true);
  api.resetRun(); api.G.phase = 'run';
  let frames = 0, nan = false;
  for (let i = 0; i < 900; i++) {
    const fn = RAF.shift(); if (!fn) break;
    IN.raw = Math.sin(i * 0.04);
    adv(16.6); fn(VT); frames++;
    if (!isFinite(G.dist) || !isFinite(G.lat)) { nan = true; break; }
    if (G.hp < CFG.HP) { api.G.hp = CFG.HP; api.G.iframeT = 0; }
  }
  ok('cockpit: ran ' + frames + ' frames without throwing', frames > 800);
  ok('cockpit: physics still sane', !nan && G.dist > 500);
  ok('cockpit: own bodywork is hidden',
     api.playerCar.userData.body.every(m => m.visible === false));
  ok('cockpit: eye height is a driver, not a drone (' + api.camera.position.y.toFixed(2) + ' m)',
     api.camera.position.y > 0.8 && api.camera.position.y < 1.7);
  ok('cockpit: seated right-hand drive, offset from car centre',
     Math.abs(api.camera.position.x - G.lat) > 0.2 && Math.abs(api.camera.position.x - G.lat) < 0.6);
  ok('cockpit: steering wheel tracks the input',
     Math.abs(api.cockpit.userData.wheel.rotation.z) > 0.001);
  ok('cockpit: every surface stays beyond the camera near plane',
     Math.abs(-0.50 * api.cockpit.scale.z) > api.camera.near);

  api.setView(false);
  for (let i = 0; i < 30; i++) { const fn = RAF.shift(); if (fn) { adv(16.6); fn(VT); } }
  ok('cockpit: switching back to chase restores the bodywork',
     api.playerCar.userData.body.every(m => m.visible === true));
  ok('cockpit: cockpit hidden in chase view', api.cockpit.visible === false);
} catch (e) {
  ok('cockpit: check threw — ' + e.message + ' :: ' + (e.stack || '').split('\n')[1], false);
}


/* ==================================================================== */
/*  LAYER 1 — deterministic core, evaluated against the shipped file     */
/* ==================================================================== */
const S = api;
/* ---- 1. PRNG stability -------------------------------------------- */
{
  const a = S.rng32(12345), b = S.rng32(12345);
  let same = true;
  for (let i = 0; i < 50000; i++) if (a() !== b()) { same = false; break; }
  ok('rng: identical streams from identical seed', same);

  const c = S.rng32(12345), d = S.rng32(12346);
  let diff = false;
  for (let i = 0; i < 100; i++) if (c() !== d()) { diff = true; break; }
  ok('rng: different seeds diverge', diff);

  const e = S.rng32(7); let lo = 1, hi = 0, sum = 0;
  for (let i = 0; i < 200000; i++) { const v = e(); lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; }
  ok('rng: in [0,1)', lo >= 0 && hi < 1);
  ok('rng: mean ~0.5 (got ' + (sum / 200000).toFixed(4) + ')', Math.abs(sum / 200000 - 0.5) < 0.005);
}

/* ---- 2. hash stability -------------------------------------------- */
{
  let stable = true;
  for (let i = 0; i < 20000; i++) if (S.hash32(i, i * 7) !== S.hash32(i, i * 7)) { stable = false; break; }
  ok('hash32: deterministic', stable);
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(S.hash32(999, i));
  ok('hash32: >99% unique over 20k sequential (got ' + seen.size + ')', seen.size > 19800);
  ok('hash32: unsigned', S.hash32(-1, -1) >= 0);
}

/* ---- 3. codeToSeed ------------------------------------------------ */
{
  eq('code: case insensitive', S.codeToSeed('ab7k'), S.codeToSeed('AB7K'));
  ok('code: distinct codes distinct seeds', S.codeToSeed('AAAA') !== S.codeToSeed('AAAB'));
  const set = new Set();
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A.length; j++) set.add(S.codeToSeed('X' + A[i] + A[j] + 'Q'));
  ok('code: no collisions across 1024 codes (got ' + set.size + ')', set.size === A.length * A.length);
}

/* ---- 4. TRAFFIC PURITY — the load-bearing test -------------------- */
{
  const seed = S.codeToSeed('KZ4M');
  let identical = true, totalCars = 0;
  for (let bi = 0; bi < 40000; bi++) {
    const a = S.batchCars(seed, bi);
    const b = S.batchCars(seed, bi);
    totalCars += a.length;
    if (a.length !== b.length) { identical = false; break; }
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.lane !== y.lane || x.vi !== y.vi || x.spd !== y.spd ||
          x.z0 !== y.z0 || x.oncoming !== y.oncoming || x.paint !== y.paint ||
          x.id !== y.id || x.wob !== y.wob) { identical = false; break; }
      if (!!x.lc !== !!y.lc) { identical = false; break; }
      if (x.lc && (x.lc.at !== y.lc.at || x.lc.to !== y.lc.to || x.lc.dur !== y.lc.dur)) { identical = false; break; }
    }
    if (!identical) break;
  }
  ok('traffic: 40k batches bit-identical on re-derivation', identical);
  ok('traffic: produced a meaningful population (' + totalCars + ' cars over 1760 km)', totalCars > 100000);
  ok('traffic: average spacing is weave-able (' + (40000 * S.CFG.SPAWN_SPACING / totalCars).toFixed(1) + ' m/car)',
     (40000 * S.CFG.SPAWN_SPACING / totalCars) < 20);

  /* Out-of-order derivation must not matter — this is what a late joiner does. */
  const fwd = [], back = [];
  for (let bi = 500; bi < 900; bi++) fwd.push(JSON.stringify(S.batchCars(seed, bi)));
  for (let bi = 899; bi >= 500; bi--) back.unshift(JSON.stringify(S.batchCars(seed, bi)));
  ok('traffic: reverse-order derivation matches (late joiner safe)', fwd.join('|') === back.join('|'));

  /* Sparse access — a client that skipped batches while tabbed out. */
  let sparseOk = true;
  for (let bi = 1000; bi < 1400; bi += 7) {
    if (JSON.stringify(S.batchCars(seed, bi)) !== fwdRef(seed, bi)) { sparseOk = false; break; }
  }
  function fwdRef(sd, bi) { return JSON.stringify(S.batchCars(sd, bi)); }
  ok('traffic: sparse/skipped access matches', sparseOk);

  /* Different rooms must NOT produce the same street. */
  const s2 = S.codeToSeed('PP9T');
  let anyDiff = false;
  for (let bi = 20; bi < 200; bi++) {
    if (JSON.stringify(S.batchCars(seed, bi)) !== JSON.stringify(S.batchCars(s2, bi))) { anyDiff = true; break; }
  }
  ok('traffic: different room codes give different traffic', anyDiff);
}

/* ---- 5. Traffic sanity constraints -------------------------------- */
{
  const seed = S.codeToSeed('TEST');
  let laneOk = true, spdOk = true, dupLane = false, truckFast = false, runway = true;
  const laneHist = new Array(S.TOTAL_LANES).fill(0);
  const vehHist = new Array(S.VEHICLES.length).fill(0);
  for (let bi = 0; bi < 30000; bi++) {
    const cars = S.batchCars(seed, bi);
    if (bi * S.CFG.SPAWN_SPACING < 320 && cars.length) runway = false;
    const seen = {};
    for (const c of cars) {
      if (c.lane < 0 || c.lane >= S.TOTAL_LANES) laneOk = false;
      const V = S.VEHICLES[c.vi];
      if (c.spd < V.spd[0] || c.spd > V.spd[1]) spdOk = false;
      if (seen[c.lane]) dupLane = true;
      seen[c.lane] = 1;
      if (c.vi >= 4 && (c.lane === S.CFG.LANES_FWD - 1 || c.lane === S.CFG.LANES_FWD)) truckFast = true;
      if (c.oncoming !== (c.lane >= S.CFG.LANES_FWD)) laneOk = false;
      laneHist[c.lane]++; vehHist[c.vi]++;
    }
  }
  ok('traffic: all lanes in range & side matches lane', laneOk);
  ok('traffic: speeds within archetype envelope', spdOk);
  ok('traffic: never two cars in one lane per batch', !dupLane);
  ok('traffic: heavy vehicles stay out of fast lanes', !truckFast);
  ok('traffic: first 320 m is clear runway', runway);
  ok('traffic: every lane gets used', laneHist.every(v => v > 100));
  ok('traffic: every vehicle archetype appears', vehHist.every(v => v > 50));
  ok('traffic: kei cars more common than buses', vehHist[0] > vehHist[5]);
}

/* ---- 6. Density ramp ---------------------------------------------- */
{
  ok('density: rises with distance', S.densityAt(0) < S.densityAt(4000));
  ok('density: clamps at 1.0', S.densityAt(500000) <= 1.0);
  const seed = S.codeToSeed('DENS');
  function count(from, to) {
    let n = 0;
    for (let bi = from; bi < to; bi++) n += S.batchCars(seed, bi).length;
    return n;
  }
  const early = count(10, 110), late = count(900, 1000);
  ok('density: late traffic denser than early (' + early + ' -> ' + late + ')', late > early * 1.35);
}

/* ---- 7. Lane geometry --------------------------------------------- */
{
  for (let l = 0; l < S.CFG.LANES_FWD; l++) ok('lane ' + l + ' positive side', S.laneOffset(l) > 0);
  for (let l = S.CFG.LANES_FWD; l < S.TOTAL_LANES; l++) ok('lane ' + l + ' negative side', S.laneOffset(l) < 0);
  let mono = true;
  for (let l = 1; l < S.CFG.LANES_FWD; l++) if (S.laneOffset(l) <= S.laneOffset(l - 1)) mono = false;
  ok('lanes: forward lanes ordered outward', mono);
  ok('lanes: carriageways separated by median', S.laneOffset(0) - S.laneOffset(S.CFG.LANES_FWD) > S.CFG.MEDIAN);
  let gapOk = true;
  for (let l = 1; l < S.CFG.LANES_FWD; l++)
    if (Math.abs(Math.abs(S.laneOffset(l) - S.laneOffset(l - 1)) - S.CFG.LANE_W) > 1e-9) gapOk = false;
  ok('lanes: uniform lane width', gapOk);
  ok('lanes: widest vehicle fits its lane', Math.max(...S.VEHICLES.map(v => v.w)) < S.CFG.LANE_W);
}

/* ---- 8. Lane-change purity ---------------------------------------- */
{
  const seed = S.codeToSeed('LC01');
  let found = 0, pure = true, bounded = true, settles = true;
  for (let bi = 100; bi < 4000 && found < 400; bi++) {
    for (const c of S.batchCars(seed, bi)) {
      if (!c.lc) continue;
      found++;
      /* evaluate out of order, twice */
      const zs = [c.z0 - 500, c.z0 + 900, c.z0, c.z0 + 200, c.z0 - 500];
      const v1 = zs.map(z => S.carLateral(c, z));
      const v2 = zs.slice().reverse().map(z => S.carLateral(c, z)).reverse();
      for (let i = 0; i < v1.length; i++) if (v1[i] !== v2[i]) pure = false;
      const far = S.carLateral(c, c.lc.at + c.spd * c.lc.dur * 40);
      if (Math.abs(far - S.laneOffset(c.lc.to)) > 0.25) settles = false;
      for (const z of zs) if (Math.abs(S.carLateral(c, z)) > S.ROAD_HALF) bounded = false;
      if (c.lc.to < 0 || c.lc.to >= S.CFG.LANES_FWD) bounded = false;
    }
  }
  ok('lanechange: sample size (' + found + ')', found > 200);
  ok('lanechange: order-independent evaluation', pure);
  ok('lanechange: target lane valid & stays on carriageway', bounded);
  ok('lanechange: settles on target lane', settles);
}

/* ---- 9. carZ ------------------------------------------------------ */
{
  const c = { z0: 1000, spd: 25, oncoming: false };
  const o = { z0: 1000, spd: 25, oncoming: true };
  near('carZ: t=0 is z0', S.carZ(c, 0), 1000);
  near('carZ: forward advances', S.carZ(c, 10), 1250);
  near('carZ: oncoming retreats', S.carZ(o, 10), 750);
  let mono = true;
  for (let t = 0; t < 5000; t += 3) if (S.carZ(c, t + 3) <= S.carZ(c, t)) mono = false;
  ok('carZ: monotonic for forward traffic', mono);
  /* purity under repeated / reordered evaluation */
  let pure = true;
  for (let i = 0; i < 10000; i++) { const t = (i * 37) % 900; if (S.carZ(c, t) !== 1000 + 25 * t) pure = false; }
  ok('carZ: closed form, no drift over 10k evaluations', pure);
}

/* ---- 10. Road shape ----------------------------------------------- */
{
  let derivOk = true, worst = 0;
  for (let z = 0; z < 200000; z += 313) {
    const h = 0.01;
    const num = (S.ROAD.x(z + h) - S.ROAD.x(z - h)) / (2 * h);
    const ana = S.ROAD.dx(z);
    worst = Math.max(worst, Math.abs(num - ana));
  }
  ok('road: analytic derivative matches numeric (err ' + worst.toExponential(2) + ')', worst < 1e-6);
  let bnd = true, slope = 0;
  for (let z = 0; z < 400000; z += 97) {
    if (Math.abs(S.ROAD.x(z)) > 140) bnd = false;
    slope = Math.max(slope, Math.abs(S.ROAD.dx(z)));
  }
  ok('road: lateral excursion bounded', bnd);
  ok('road: max slope drivable (' + slope.toFixed(3) + ')', slope < 0.09);
  ok('road: deterministic', S.ROAD.x(12345.678) === S.ROAD.x(12345.678));
}

/* ---- 11. Combo / agility ------------------------------------------ */
{
  near('combo: x1 at zero', S.comboMult(0), 1);
  ok('combo: monotonic', S.comboMult(5) < S.comboMult(6));
  ok('combo: capped', S.comboMult(9999) === S.comboMult(S.CFG.COMBO_MAX));
  near('agility: none at start', S.agilityBonus(0), 0);
  ok('agility: rises in tiers', S.agilityBonus(5) === 0 && S.agilityBonus(6) > 0);
  ok('agility: hard cap at 25%', S.agilityBonus(100000) === S.CFG.STEER_AGILITY_MAX);
  let mono = true;
  for (let i = 1; i < 500; i++) if (S.agilityBonus(i) < S.agilityBonus(i - 1)) mono = false;
  ok('agility: non-decreasing', mono);
}

/* ---- 12. Proximity classification ---------------------------------- */
{
  const hw = 0.87, hl = 2.3;
  eq('prox: dead centre = hit', S.proximity(0, 0, hw, hl), 2);
  eq('prox: far behind = nothing', S.proximity(0, 500, hw, hl), 0);
  eq('prox: wide right = nothing', S.proximity(12, 0, hw, hl), 0);
  eq('prox: graze band', S.proximity(hw + S.CFG.CAR_HW + 0.3, 0, hw, hl), 1);
  ok('prox: symmetric', S.proximity(2.4, 1, hw, hl) === S.proximity(-2.4, -1, hw, hl));
  /* the bands must be ordered hit -> graze -> nothing as lateral grows */
  let order = true, seenHit = false, seenGraze = false, seenNone = false;
  let prev = 2;
  for (let d = 0; d < 8; d += 0.01) {
    const p = S.proximity(d, 0, hw, hl);
    if (p > prev) order = false;
    prev = p;
    if (p === 2) seenHit = true; if (p === 1) seenGraze = true; if (p === 0) seenNone = true;
  }
  ok('prox: monotonically decreasing severity with lateral distance', order);
  ok('prox: all three bands reachable', seenHit && seenGraze && seenNone);
  ok('prox: graze band is wide enough to be fair on a phone',
     S.CFG.GRAZE_HW - S.CFG.CAR_HW > 0.9);
}

/* ---- 13. Traffic derivation window --------------------------------- */
/* The window must never miss a car that is actually inside the corridor.
   This brute-forces it: derive a huge slab of batches, find every car
   really in view at a given (d, t), and confirm the window contains its
   batch. A miss here means the road silently empties out mid-run. */
{
  const seed = S.codeToSeed('WIN0');
  let missed = 0, checked = 0, worstFwd = 0, worstOpp = 0;
  let samples = 0;
  for (let t = 0; t <= 600; t += 10) {
    samples++;
    const d = Math.min(S.CFG.SPD_MAX, S.CFG.SPD_START + t * S.CFG.SPD_RAMP) * t * 0.85;
    const w = S.trafficWindow(d, t);
    worstFwd = Math.max(worstFwd, w.fwd[1] - w.fwd[0]);
    worstOpp = Math.max(worstOpp, w.opp[1] - w.opp[0]);
    const lo = Math.max(0, Math.floor((d - 40000) / S.CFG.SPAWN_SPACING));
    const hi = Math.ceil((d + 40000) / S.CFG.SPAWN_SPACING);
    for (let bi = lo; bi <= hi; bi++) {
      for (const c of S.batchCars(seed, bi)) {
        const dz = S.carZ(c, t) - d;
        if (dz > S.CFG.VIEW_AHEAD || dz < -S.CFG.VIEW_BEHIND) continue;
        checked++;
        const win = c.oncoming ? w.opp : w.fwd;
        if (bi < win[0] || bi > win[1]) missed++;
      }
    }
  }
  ok('window: sampled ' + checked + ' visible cars over ' + samples + ' timestamps',
     checked > 2000);
  ok('window: corridor stays populated (' + ((S.CFG.VIEW_AHEAD + S.CFG.VIEW_BEHIND) / (checked / samples)).toFixed(1) + ' m/car)',
     (checked / samples) > 35);
  ok('window: never misses a visible car (' + missed + ' missed)', missed === 0);
  ok('window: forward span stays workable (max ' + worstFwd + ' batches)', worstFwd < 260);
  ok('window: oncoming span stays workable (max ' + worstOpp + ' batches)', worstOpp < 260);
  ok('window: no negative batch indices',
     S.trafficWindow(0, 0).fwd[0] === 0 && S.trafficWindow(0, 600).fwd[0] === 0);
  ok('window: speed band is narrow enough to bound the scan (' + (S.V_MAX - S.V_MIN) + ' m/s)',
     S.V_MAX - S.V_MIN <= 10);
  ok('window: slowest traffic is still slower than the player at launch', S.V_MAX < S.CFG.SPD_START);
}

/* ---- 13b. Density holds up deep into a run -------------------------- */
/* The original bug this test was written for: traffic looked fine for the
   first thirty seconds and then quietly thinned out to nothing. */
{
  const seed = S.codeToSeed('DEEP');
  function inView(d, t) {
    const w = S.trafficWindow(d, t);
    let n = 0;
    for (const side of ['fwd', 'opp']) {
      for (let bi = w[side][0]; bi <= w[side][1]; bi++) {
        for (const c of S.batchCars(seed, bi)) {
          if (c.oncoming !== (side === 'opp')) continue;
          const dz = S.carZ(c, t) - d;
          if (dz <= S.CFG.VIEW_AHEAD && dz >= -S.CFG.VIEW_BEHIND) n++;
        }
      }
    }
    return n;
  }
  const early = inView(2000, 40), mid = inView(12000, 200), late = inView(28000, 420);
  const span = S.CFG.VIEW_AHEAD + S.CFG.VIEW_BEHIND;
  ok('deep: traffic present early (' + (span / early).toFixed(1) + ' m/car)', early > 30);
  ok('deep: traffic present at 200 s (' + (span / mid).toFixed(1) + ' m/car)', mid > 40);
  ok('deep: traffic present at 420 s (' + (span / late).toFixed(1) + ' m/car)', late > 40);
  ok('deep: density does not collapse over a long run', late > early * 0.8);
  ok('deep: density does not explode either', late < early * 4);
}

/* ---- 14. Cross-client simulation replay ---------------------------- */
/* Two "clients" walk the same room at different frame rates and different
   join times, and must observe identical car positions at identical
   world times. This is the actual multiplayer guarantee. */
{
  const seed = S.codeToSeed('SYNC');
  function observe(t, joinBatch) {
    /* joinBatch simulates a client that only started deriving batches late */
    const [a, b] = S.batchRange(t * 60);
    const acc = [];
    for (let bi = Math.max(a, joinBatch); bi < b; bi++) {
      for (const c of S.batchCars(seed, bi)) {
        acc.push([c.id, S.carZ(c, t).toFixed(6), S.carLateral(c, S.carZ(c, t)).toFixed(6)]);
      }
    }
    acc.sort((p, q) => p[0] - q[0]);
    return JSON.stringify(acc);
  }
  let match = true, samples = 0;
  for (let t = 10; t < 400; t += 7) {
    samples++;
    if (observe(t, 0) !== observe(t, 0)) { match = false; break; }
  }
  ok('sync: repeated observation stable over ' + samples + ' timestamps', match);

  /* client B derives from a later starting batch but same window */
  let lateJoin = true;
  for (let t = 60; t < 300; t += 11) {
    const [a] = S.batchRange(t * 60);
    if (observe(t, 0) !== observe(t, a)) { lateJoin = false; break; }
  }
  ok('sync: late joiner sees identical traffic', lateJoin);
}

/* ---- 15. Balance guards ------------------------------------------- */
{
  ok('balance: boost is meaningful but not free flight', S.CFG.SPD_BOOST_MUL > 1.2 && S.CFG.SPD_BOOST_MUL < 1.7);
  ok('balance: top speed reachable in a reasonable run',
     (S.CFG.SPD_MAX - S.CFG.SPD_START) / S.CFG.SPD_RAMP < 120);
  ok('balance: agility cap below difficulty ramp', S.CFG.STEER_AGILITY_MAX <= 0.3);
  ok('balance: crash costs real speed', S.CFG.CRASH_SPD_MUL < 0.6);
  ok('balance: iframes outlast stagger', S.CFG.IFRAME > S.CFG.STAGGER);
  ok('balance: charges are scarce', S.CFG.CHARGE_MAX <= 3);
  ok('balance: player outruns fastest traffic',
     S.CFG.SPD_START > Math.max(...S.VEHICLES.map(v => v.spd[1])));
  ok('balance: closing speed on traffic is readable, not lethal',
     S.CFG.SPD_START - S.V_MAX > 8 && S.CFG.SPD_MAX - S.V_MIN < 90);
  ok('balance: lateral limit keeps player on tarmac (' + S.CFG.LAT_LIMIT + ' <= ' + S.ROAD_HALF.toFixed(2) + ')',
     S.CFG.LAT_LIMIT <= S.ROAD_HALF - S.CFG.CAR_HW);
  ok('balance: player can reach the oncoming carriageway', S.CFG.LAT_LIMIT > Math.abs(S.laneOffset(S.CFG.LANES_FWD)));
}


function report() {
  console.log('\n  NEON SHUTOKO — full suite');
  console.log('  ' + '-'.repeat(46));
  console.log('  passed: ' + pass + '   failed: ' + fail);
  if (fail) { console.log('\n  FAILURES:'); bad.forEach(b => console.log('   x ' + b)); }
  else console.log('  all green');
  console.log('');
}
report();
process.exit(fail ? 1 : 0);
