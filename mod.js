/**
 * Fast Roads Studio v9.1  —  Slow Roads mod menu + fullscreen 3D CAD editor
 * Standalone script (mod.js). Paste into the console / load as a userscript.
 *
 * VIEWPORT   LMB click = select · LMB drag (object mode) = orbit · LMB drag (edit mode) = box select
 *            RMB / MMB / Alt+LMB drag = orbit · + Shift = pan · wheel = zoom
 * KEYS       Tab object/edit · 1/2/3 vertex/edge/face · G/R/S move/rotate/scale (X/Y/Z lock, type numbers)
 *            E extrude · F make face from selected verts · Del delete · A all · Alt+A none · Ctrl+I invert
 *            Shift+D duplicate · Ctrl+Z / Ctrl+Shift+Z undo/redo · . frame selection · Home frame all
 *            Numpad 1/3/7 (Ctrl = opposite) views · Esc cancel / exit studio
 * MENU       \ or `  toggles the floating mod menu
 */
(function () {
  "use strict";

  if (window.__fastRoadsStudioHost) {
    const h = window.__fastRoadsStudioHost;
    h.style.display = h.style.display === "none" ? "block" : "none";
    return;
  }

  const RAF = window.requestAnimationFrame.bind(window); // un-wrapped rAF for the editor loop
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r5 = (n) => Math.round(n * 1e5) / 1e5;
  const isHex = (s) => /^#[0-9a-f]{6}$/i.test(s || "");

  //#POLY-START
  // =========================================================================
  // 1. POLY — pure mesh data (welded vertices + triangles). No THREE needed.
  //    v: flat xyz of UNIQUE vertices · t: 3 vertex ids per triangle
  //    uv: 6 floats per triangle (per corner, so seams survive) · col: per-triangle hex or null
  //    srcMap: corner -> vertex index in the original game geometry (null once topology changed)
  //    RULE: once a Poly has been recorded in history it is never mutated; edits clone first.
  // =========================================================================
  class Poly {
    constructor() { this.v = []; this.t = []; this.uv = []; this.col = []; this.srcMap = null; }
    get nv() { return this.v.length / 3; }
    get nt() { return this.t.length / 3; }

    clone() {
      const p = new Poly();
      p.v = this.v.slice(); p.t = this.t.slice(); p.uv = this.uv.slice(); p.col = this.col.slice();
      p.srcMap = this.srcMap;
      return p;
    }

    static ek(a, b) { return a < b ? a + "_" + b : b + "_" + a; }

    // Build from any BufferGeometry-like object (indexed or not). Welds by position.
    static fromGeometry(geo) {
      const pa = geo.attributes.position, ua = geo.attributes.uv, ix = geo.index;
      const total = ix ? ix.count : pa.count, T = Math.floor(total / 3);
      const p = new Poly(), map = new Map(), srcMap = new Array(T * 3), K = 1e4;
      for (let c = 0; c < T * 3; c++) {
        const vi = ix ? ix.getX(c) : c;
        srcMap[c] = vi;
        const x = pa.getX(vi), y = pa.getY(vi), z = pa.getZ(vi);
        const key = Math.round(x * K) + "," + Math.round(y * K) + "," + Math.round(z * K);
        let id = map.get(key);
        if (id === undefined) { id = p.v.length / 3; p.v.push(x, y, z); map.set(key, id); }
        p.t.push(id);
        if (ua) p.uv.push(ua.getX(vi), ua.getY(vi)); else p.uv.push(0, 0);
      }
      for (let i = 0; i < T; i++) p.col.push(null);
      p.srcMap = srcMap;
      return p;
    }

    append(o, dx = 0, dy = 0, dz = 0) {
      const base = this.nv;
      for (let i = 0; i < o.nv; i++) this.v.push(o.v[3 * i] + dx, o.v[3 * i + 1] + dy, o.v[3 * i + 2] + dz);
      for (let i = 0; i < o.t.length; i++) this.t.push(o.t[i] + base);
      for (let i = 0; i < o.uv.length; i++) this.uv.push(o.uv[i]);
      for (let i = 0; i < o.col.length; i++) this.col.push(o.col[i]);
      this.srcMap = null;
      return this;
    }

    toJSON() {
      const col = {};
      this.col.forEach((c, i) => { if (c) col[i] = c; });
      return { v: this.v.map(r5), t: this.t.slice(), uv: this.uv.map((n) => Math.round(n * 1e4) / 1e4), col };
    }
    static fromJSON(d) {
      const p = new Poly();
      p.v = d.v.slice(); p.t = d.t.slice();
      p.uv = d.uv && d.uv.length === d.t.length * 2 ? d.uv.slice() : new Array(d.t.length * 2).fill(0);
      p.col = new Array(d.t.length / 3).fill(null);
      for (const k in d.col || {}) p.col[+k] = d.col[k];
      return p;
    }

    sameTopology(o) {
      if (!o || this.t.length !== o.t.length) return false;
      for (let i = 0; i < this.t.length; i++) if (this.t[i] !== o.t[i]) return false;
      return true;
    }

    // Unnormalised face normal (length = 2 × area)
    nrm(i) {
      const t = this.t, v = this.v;
      const a = t[3 * i] * 3, b = t[3 * i + 1] * 3, c = t[3 * i + 2] * 3;
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    }

    edgeMap() {
      const m = new Map();
      for (let i = 0; i < this.nt; i++) {
        for (let k = 0; k < 3; k++) {
          const a = this.t[3 * i + k], b = this.t[3 * i + (k + 1) % 3];
          if (a === b) continue;
          const key = Poly.ek(a, b);
          let l = m.get(key);
          if (!l) { l = []; m.set(key, l); }
          l.push(i);
        }
      }
      return m;
    }

    // Unique edges as flat [a,b,a,b,...] pairs
    edgeList() {
      const nv = this.nv, seen = new Set(), out = [];
      for (let i = 0; i < this.nt; i++) {
        for (let k = 0; k < 3; k++) {
          const a = this.t[3 * i + k], b = this.t[3 * i + (k + 1) % 3];
          if (a === b) continue;
          const lo = a < b ? a : b, hi = a < b ? b : a, key = lo * nv + hi;
          if (!seen.has(key)) { seen.add(key); out.push(lo, hi); }
        }
      }
      return out;
    }

    // Drop unused vertices and renumber. Invalidates any vertex-id based selection.
    compact() {
      const map = new Int32Array(this.nv).fill(-1);
      let n = 0;
      for (const id of this.t) if (map[id] < 0) map[id] = n++;
      const v = new Array(n * 3);
      for (let i = 0; i < map.length; i++) {
        if (map[i] < 0) continue;
        const j = map[i] * 3;
        v[j] = this.v[3 * i]; v[j + 1] = this.v[3 * i + 1]; v[j + 2] = this.v[3 * i + 2];
      }
      this.v = v;
      this.t = this.t.map((id) => map[id]);
    }

    deleteTris(set) {
      const t = [], uv = [], col = [];
      for (let i = 0; i < this.nt; i++) {
        if (set.has(i)) continue;
        t.push(this.t[3 * i], this.t[3 * i + 1], this.t[3 * i + 2]);
        for (let k = 0; k < 6; k++) uv.push(this.uv[6 * i + k]);
        col.push(this.col[i]);
      }
      this.t = t; this.uv = uv; this.col = col; this.srcMap = null;
      this.compact();
    }

    trisWithVerts(vset) {
      const out = new Set();
      for (let i = 0; i < this.nt; i++) {
        if (vset.has(this.t[3 * i]) || vset.has(this.t[3 * i + 1]) || vset.has(this.t[3 * i + 2])) out.add(i);
      }
      return out;
    }
    trisWithEdges(eset) {
      const out = new Set(), em = this.edgeMap();
      for (const k of eset) { const l = em.get(k); if (l) l.forEach((i) => out.add(i)); }
      return out;
    }

    _addTri(a, b, c, uv, col) {
      this.t.push(a, b, c);
      for (let k = 0; k < 6; k++) this.uv.push(uv ? uv[k] : 0);
      this.col.push(col || null);
      this.srcMap = null;
      return this.nt - 1;
    }
    _dupVert(id) {
      const n = this.nv;
      this.v.push(this.v[3 * id], this.v[3 * id + 1], this.v[3 * id + 2]);
      return n;
    }

    // Extrude selected triangles: duplicates their vertices, re-points the faces at the copies and
    // stitches side walls along the boundary. Returns the new vertex ids and the average face normal.
    extrudeFaces(fset) {
      const F = [...fset], bound = new Map();
      let dx = 0, dy = 0, dz = 0;
      for (const i of F) {
        const n = this.nrm(i); dx += n[0]; dy += n[1]; dz += n[2];
        for (let k = 0; k < 3; k++) {
          const a = this.t[3 * i + k], b = this.t[3 * i + (k + 1) % 3], key = Poly.ek(a, b);
          const e = bound.get(key);
          if (e) e.n++; else bound.set(key, { n: 1, u: a, v: b });
        }
      }
      const dup = new Map(), newVerts = new Set();
      const get = (id) => {
        let d = dup.get(id);
        if (d === undefined) { d = this._dupVert(id); dup.set(id, d); newVerts.add(d); }
        return d;
      };
      for (const i of F) for (let k = 0; k < 3; k++) get(this.t[3 * i + k]);
      for (const i of F) for (let k = 0; k < 3; k++) this.t[3 * i + k] = dup.get(this.t[3 * i + k]);
      for (const e of bound.values()) {
        if (e.n !== 1) continue;
        const u = e.u, v = e.v, u2 = dup.get(u), v2 = dup.get(v);
        this._addTri(u, v, v2);
        this._addTri(u, v2, u2);
      }
      this.srcMap = null;
      const l = Math.hypot(dx, dy, dz) || 1;
      return { verts: newVerts, dir: [dx / l, dy / l, dz / l] };
    }

    // Extrude edges into a strip of quads. Returns new vertices and the new (copied) edge keys.
    extrudeEdges(eset) {
      const dup = new Map(), newVerts = new Set(), edges = [];
      const get = (id) => {
        let d = dup.get(id);
        if (d === undefined) { d = this._dupVert(id); dup.set(id, d); newVerts.add(d); }
        return d;
      };
      for (const key of eset) {
        const [u, v] = key.split("_").map(Number), u2 = get(u), v2 = get(v);
        this._addTri(u, v, v2);
        this._addTri(u, v2, u2);
        edges.push(Poly.ek(u2, v2));
      }
      this.srcMap = null;
      return { verts: newVerts, edges };
    }

    // Split every selected triangle into 4. Returns the set of all resulting triangle ids.
    subdivide(fset) {
      const mid = new Map(), out = new Set();
      const m = (a, b) => {
        const key = Poly.ek(a, b);
        let id = mid.get(key);
        if (id === undefined) {
          id = this.nv;
          this.v.push((this.v[3 * a] + this.v[3 * b]) / 2, (this.v[3 * a + 1] + this.v[3 * b + 1]) / 2, (this.v[3 * a + 2] + this.v[3 * b + 2]) / 2);
          mid.set(key, id);
        }
        return id;
      };
      for (const i of [...fset]) {
        const a = this.t[3 * i], b = this.t[3 * i + 1], c = this.t[3 * i + 2], u = this.uv.slice(6 * i, 6 * i + 6), col = this.col[i];
        const mab = m(a, b), mbc = m(b, c), mca = m(c, a);
        const ua = [u[0], u[1]], ub = [u[2], u[3]], uc = [u[4], u[5]];
        const av = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const uab = av(ua, ub), ubc = av(ub, uc), uca = av(uc, ua);
        this.t[3 * i] = a; this.t[3 * i + 1] = mab; this.t[3 * i + 2] = mca;
        [ua[0], ua[1], uab[0], uab[1], uca[0], uca[1]].forEach((x, k) => { this.uv[6 * i + k] = x; });
        out.add(i);
        out.add(this._addTri(mab, b, mbc, [uab[0], uab[1], ub[0], ub[1], ubc[0], ubc[1]], col));
        out.add(this._addTri(mca, mbc, c, [uca[0], uca[1], ubc[0], ubc[1], uc[0], uc[1]], col));
        out.add(this._addTri(mab, mbc, mca, [uab[0], uab[1], ubc[0], ubc[1], uca[0], uca[1]], col));
      }
      this.srcMap = null;
      return out;
    }

    // Create a face (fan-triangulated) from ordered vertex ids. view = direction camera→face,
    // used to wind the new face toward the camera.
    addFace(ids, view) {
      if (ids.length < 3) return [];
      const first = this.nt, out = [];
      for (let k = 1; k < ids.length - 1; k++) out.push(this._addTri(ids[0], ids[k], ids[k + 1]));
      if (view) {
        const n = this.nrm(first);
        if (n[0] * view[0] + n[1] * view[1] + n[2] * view[2] > 0) this.flip(new Set(out));
      }
      this.srcMap = null;
      return out;
    }

    flip(fset) {
      for (const i of fset) {
        const a = this.t[3 * i + 1]; this.t[3 * i + 1] = this.t[3 * i + 2]; this.t[3 * i + 2] = a;
        const u = this.uv, j = 6 * i;
        const x = u[j + 2], y = u[j + 3]; u[j + 2] = u[j + 4]; u[j + 3] = u[j + 5]; u[j + 4] = x; u[j + 5] = y;
      }
      this.srcMap = null;
    }

    // Per-corner normals. mode: flat | smooth | auto (smooth below `deg` degrees).
    normals(mode, deg) {
      const T = this.nt, out = new Float32Array(T * 9), fn = new Float32Array(T * 3), w = new Float32Array(T);
      for (let i = 0; i < T; i++) {
        const n = this.nrm(i), l = Math.hypot(n[0], n[1], n[2]);
        w[i] = l;
        if (l > 1e-12) { fn[3 * i] = n[0] / l; fn[3 * i + 1] = n[1] / l; fn[3 * i + 2] = n[2] / l; } else fn[3 * i + 1] = 1;
      }
      if (mode === "flat") {
        for (let i = 0; i < T; i++) for (let k = 0; k < 3; k++) {
          out[9 * i + 3 * k] = fn[3 * i]; out[9 * i + 3 * k + 1] = fn[3 * i + 1]; out[9 * i + 3 * k + 2] = fn[3 * i + 2];
        }
        return out;
      }
      const adj = new Array(this.nv);
      for (let i = 0; i < adj.length; i++) adj[i] = [];
      for (let i = 0; i < T; i++) for (let k = 0; k < 3; k++) adj[this.t[3 * i + k]].push(i);
      const cosT = mode === "smooth" ? -2 : Math.cos(((deg || 40) * Math.PI) / 180);
      for (let i = 0; i < T; i++) {
        const fx = fn[3 * i], fy = fn[3 * i + 1], fz = fn[3 * i + 2];
        for (let k = 0; k < 3; k++) {
          let sx = 0, sy = 0, sz = 0;
          for (const j of adj[this.t[3 * i + k]]) {
            const d = fx * fn[3 * j] + fy * fn[3 * j + 1] + fz * fn[3 * j + 2];
            if (d >= cosT) { sx += fn[3 * j] * w[j]; sy += fn[3 * j + 1] * w[j]; sz += fn[3 * j + 2] * w[j]; }
          }
          const l = Math.hypot(sx, sy, sz);
          if (l < 1e-12) { sx = fx; sy = fy; sz = fz; } else { sx /= l; sy /= l; sz /= l; }
          const o = 9 * i + 3 * k;
          out[o] = sx; out[o + 1] = sy; out[o + 2] = sz;
        }
      }
      return out;
    }
  }
  //#POLY-END

  // =========================================================================
  // 2. SETTINGS
  // =========================================================================
  const KEY = "fastroads_cad_studio_v9";
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };

  const S = (window.__FR_S = {
    tab: 0, tool: "select", selMode: "object", axis: null, snap: false,
    shading: "auto", angle: 40, xray: true, wire: false, grid: true,
    liveSync: true, autoApply: false,
    paintColor: "#ff3b6b", partColor: "#2dd4ff",
    neonActive: false, neonColor: "#ff007f",
    enginePower: 1.0, gravityY: -9.81,
    infiniteBoost: false, noClip: false, infiniteGrip: false,
    wheelRadius: 0.34, wheelbase: 2.75
  });
  Object.assign(S, loadSaved());
  S.tab = 0; S.tool = "select"; S.selMode = "object"; S.axis = null;

  // =========================================================================
  // 3. ENGINE RESOLVER (THREE + live car). Tolerant of minified builds.
  // =========================================================================
  const THREE_NEEDS = ["WebGLRenderer", "Scene", "PerspectiveCamera", "Mesh", "BufferGeometry", "BufferAttribute",
    "MeshStandardMaterial", "MeshBasicMaterial", "LineBasicMaterial", "LineSegments", "Points", "PointsMaterial",
    "Group", "Vector3", "Vector2", "Matrix4", "Quaternion", "Color", "Raycaster", "AmbientLight", "DirectionalLight",
    "HemisphereLight", "PointLight", "GridHelper", "AxesHelper", "BoxGeometry", "SphereGeometry", "CylinderGeometry",
    "ConeGeometry", "PlaneGeometry", "TorusGeometry", "DoubleSide", "Box3", "Euler"];
  const fullThree = (T) => !!T && THREE_NEEDS.every((k) => T[k] !== undefined);
  const looksLikeThree = (m) => !!m && typeof m === "object" && !!m.Mesh && !!m.BufferGeometry && !!m.Scene;

  function findGameThree() {
    if (looksLikeThree(window.THREE)) return window.THREE;
    try {
      for (const key of Object.keys(window)) {
        if (!/^webpack(Jsonp|Chunk)/i.test(key) || !Array.isArray(window[key])) continue;
        const arr = window[key], id = "__fr_probe_" + Math.random().toString(36).slice(2);
        let req = null;
        try {
          if (/^webpackChunk/i.test(key)) arr.push([[id], {}, (r) => { req = r; }]);
          else arr.push([[id], { [id]: (m, e, r) => { req = r; } }, [[id]]]);
        } catch (e) { /* ignore */ }
        if (req && req.c) {
          for (const mid in req.c) {
            const ex = req.c[mid] && req.c[mid].exports;
            if (looksLikeThree(ex)) return ex;
            if (ex && looksLikeThree(ex.default)) return ex.default;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  const protoWith = (obj, prop) => {
    let p = Object.getPrototypeOf(obj);
    while (p && !Object.prototype.hasOwnProperty.call(p, prop)) p = Object.getPrototypeOf(p);
    return p;
  };
  const isModNode = (n, root) => {
    while (n && n !== root) { if (n.name && String(n.name).indexOf("__mod") === 0) return true; n = n.parent; }
    return false;
  };

  const Engine = {
    gameThree: null, car: null, scene: null, currentType: "Roadster", _t: 0, _geo: null, onCar: null,

    init() { this.gameThree = findGameThree(); this.scan(true); },

    scan(force) {
      const now = performance.now();
      if (!force && now - this._t < (this.car ? 2000 : 600)) return this.car;
      this._t = now;
      const ok = (c) => c && typeof c === "object" && c.metrics && c.geo && typeof c.geo.traverse === "function";
      let c = [window.__FR_CAR, window.car, window.z].find(ok) || null;
      if (!c) {
        const sc = window.__FR_SCENE || window.qr || window.gameScene;
        if (sc && typeof sc.traverse === "function") sc.traverse((o) => { if (!c && ok(o)) c = o; });
      }
      this.car = c;
      if (c) { let r = c.geo; while (r.parent) r = r.parent; this.scene = r; }
      if (window.jr && window.jr.value && window.jr.value.type) this.currentType = window.jr.value.type;
      const g = c ? c.geo : null;
      if (g !== this._geo) { this._geo = g; if (this.onCar) this.onCar(g); }
      return this.car;
    },

    setVehicleType(type) {
      this.currentType = type;
      if (window.jr && typeof window.jr.set === "function") window.jr.set("type", type);
      setTimeout(() => this.scan(true), 400);
      setTimeout(() => this.scan(true), 1200);
    }
  };
  Engine.init();

  function gameClasses() {
    const car = Engine.car;
    if (!car || !car.geo) return null;
    const T = Engine.gameThree || {};
    let sample = null;
    car.geo.traverse((n) => {
      if (!sample && n.isMesh && n.geometry && n.geometry.attributes && n.geometry.attributes.position &&
        !n.isSkinnedMesh && !n.isInstancedMesh && !isModNode(n, car.geo)) sample = n;
    });
    if (!sample) return null;
    const sm = Array.isArray(sample.material) ? sample.material[0] : sample.material;
    const gp = protoWith(sample.geometry, "setAttribute");
    const pa = sample.geometry.attributes.position;
    const op = protoWith(car.geo, "traverse");
    return {
      Group: T.Group || T.Object3D || (op && op.constructor),
      Mesh: T.Mesh || sample.constructor,
      BufferGeometry: T.BufferGeometry || (gp && gp.constructor),
      BufferAttribute: T.BufferAttribute || (pa.isBufferAttribute ? pa.constructor : null),
      Standard: T.MeshStandardMaterial || (sm && sm.isMeshStandardMaterial ? sm.constructor : null),
      PointLight: T.PointLight || null,
      Color: T.Color || (sm && sm.color ? sm.color.constructor : null)
    };
  }

  // =========================================================================
  // 4. PHYSICS REWIRE (rAF hook) — only touches what you actually changed
  // =========================================================================
  const held = new Set();
  window.addEventListener("keydown", (e) => held.add(e.code), true);
  window.addEventListener("keyup", (e) => held.delete(e.code), true);
  window.addEventListener("blur", () => held.clear());

  const baseMetrics = new WeakMap();
  let lastGrav = null;

  const Rewire = {
    install() {
      const orig = window.requestAnimationFrame;
      window.requestAnimationFrame = function (cb) {
        return orig.call(window, function (t) { try { Rewire.watchdog(); } catch (e) { /* never break the game loop */ } return cb(t); });
      };
    },
    watchdog() {
      if (window.car && window.car !== Engine.car) Engine.scan(true);
      const c = Engine.car && Engine.car.geo ? Engine.car : Engine.scan();
      if (!c) return;

      if (c.metrics) {
        let b = baseMetrics.get(c.metrics);
        if (!b) {
          b = { top: typeof c.metrics.topSpeed === "number" ? c.metrics.topSpeed : 45, acc: typeof c.metrics.accel === "number" ? c.metrics.accel : 9 };
          baseMetrics.set(c.metrics, b);
        }
        if (S.enginePower !== 1 || b.touched) {
          c.metrics.topSpeed = b.top * S.enginePower;
          c.metrics.accel = b.acc * S.enginePower;
          b.touched = S.enginePower !== 1;
        }
      }
      if (S.infiniteGrip) {
        c.slip = 0;
        if (c.metrics) { c.metrics.slipBase = 0; c.metrics.slipMod = 0; }
      }
      if (S.infiniteBoost && (held.has("KeyW") || held.has("ArrowUp")) && c.vel && typeof c.vel.multiplyScalar === "function") {
        c.vel.multiplyScalar(1.025);
      }
      if (window.So && S.gravityY !== lastGrav && (lastGrav !== null || S.gravityY !== -9.81)) {
        if (typeof window.So.set === "function") window.So.set(S.gravityY); else window.So.value = S.gravityY;
        lastGrav = S.gravityY;
      }
      if (S.noClip) { c.didCollide = false; c.wrongWay = false; }
    }
  };
  Rewire.install();

  // =========================================================================
  // 5. UNDO / REDO
  // =========================================================================
  const History = {
    stack: [], index: -1, max: 150,
    record(name, undo, redo) {
      this.stack.length = this.index + 1;
      this.stack.push({ name, undo, redo });
      if (this.stack.length > this.max) this.stack.shift(); else this.index++;
      Studio.afterEdit(name);
    },
    execute(name, undo, redo) { redo(); this.record(name, undo, redo); },
    undo() {
      if (this.index < 0) return updateStatus("Nothing to undo");
      const s = this.stack[this.index--];
      s.undo(); Studio.afterEdit("Undo: " + s.name);
    },
    redo() {
      if (this.index >= this.stack.length - 1) return updateStatus("Nothing to redo");
      const s = this.stack[++this.index];
      s.redo(); Studio.afterEdit("Redo: " + s.name);
    },
    clear() { this.stack = []; this.index = -1; }
  };

  // =========================================================================
  // 6. SYNC — write editor state back into the live game car
  //    * only objects/aspects you changed are touched (dirty flags)
  //    * each edited mesh gets its OWN cloned material (no accidental recolouring of other parts)
  //    * each edited mesh gets its OWN geometry (never writes into geometry shared with other meshes)
  // =========================================================================
  const Sync = {
    run() {
      const car = Engine.car;
      if (!car || !car.geo) return false;
      const G = gameClasses();
      if (!G) return false;
      let n = 0;
      for (const o of Studio.objs) if (o.src && (o.dirty.t || o.dirty.m || o.dirty.g)) { try { this.src(o, car, G); n++; } catch (e) { console.warn("[FastRoads] sync failed for", o.name, e); } }
      try { this.customs(car, G); } catch (e) { console.warn("[FastRoads] custom sync failed", e); }
      try { this.neon(car, G); } catch (e) { /* ignore */ }
      return true;
    },

    src(o, car, G) {
      const n = o.src, T = Studio.T;
      if (!n.parent) return; // game rebuilt the car; reload the editor
      if (o.dirty.t) {
        car.geo.updateWorldMatrix(true, false);
        n.parent.updateWorldMatrix(true, false);
        const pInv = new T.Matrix4().fromArray(n.parent.matrixWorld.elements).invert();
        const gW = new T.Matrix4().fromArray(car.geo.matrixWorld.elements);
        o.mesh.updateMatrix();
        const loc = pInv.multiply(gW).multiply(o.mesh.matrix);
        const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
        loc.decompose(p, q, s);
        n.position.set(p.x, p.y, p.z); n.quaternion.set(q.x, q.y, q.z, q.w); n.scale.set(s.x, s.y, s.z);
        n.visible = o.visible && !o.deleted;
        n.updateMatrix();
        o.dirty.t = false;
      }
      const faceCols = o.poly.col.some(Boolean);
      if (o.dirty.m || (o.dirty.g && faceCols)) {
        if (!o._ownMat) {
          o._ownMat = true;
          n.material = Array.isArray(n.material) ? n.material.map((m) => m.clone()) : n.material.clone();
        }
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        const changedColor = o.color.toLowerCase() !== (o.origColor || "").toLowerCase();
        for (const sm of mats) {
          if (sm.color) sm.color.set(faceCols ? "#ffffff" : o.color);
          if (faceCols) sm.vertexColors = true;
          else if (changedColor) sm.vertexColors = false;
          else sm.vertexColors = !!o.origVC;
          if ("metalness" in sm) sm.metalness = o.metal;
          if ("roughness" in sm) sm.roughness = o.rough;
          sm.opacity = o.opacity;
          sm.transparent = o.opacity < 0.999 || !!o.origTransparent;
          if (sm.emissive && sm.emissive.set) sm.emissive.set(o.emissive);
          if ("emissiveIntensity" in sm) sm.emissiveIntensity = o.emInt;
          sm.needsUpdate = true;
        }
        o.dirty.m = false;
      }
      if (o.dirty.g) {
        const p = o.poly;
        const rebuild = !p.srcMap || p.srcMap.length !== p.nt * 3 || faceCols;
        const pristine = p === (o.orig && o.orig.poly) && !faceCols;
        if (!o._origGeo) o._origGeo = n.geometry;
        if (pristine) {
          n.geometry = o._origGeo; o._geoReplaced = false;       // untouched shared original
        } else if (!rebuild) {
          if (!o._ownGeo) o._ownGeo = o._origGeo.clone();        // private copy, never the shared one
          const g = o._ownGeo; n.geometry = g; o._geoReplaced = false;
          const pa = g.attributes.position, na = g.attributes.normal;
          const nrm = p.normals(S.shading, S.angle);
          for (let c = 0; c < p.nt * 3; c++) {
            const vi = p.srcMap[c], id = p.t[c];
            pa.setXYZ(vi, p.v[3 * id], p.v[3 * id + 1], p.v[3 * id + 2]);
            if (na) na.setXYZ(vi, nrm[3 * c], nrm[3 * c + 1], nrm[3 * c + 2]);
          }
          pa.needsUpdate = true; if (na) na.needsUpdate = true;
          g.computeBoundingSphere(); g.computeBoundingBox();
        } else {
          n.geometry = this.buildGeo(o, G, faceCols); o._geoReplaced = true;
        }
        o.dirty.g = false;
      }
    },

    buildGeo(o, G, withColors) {
      if (!G.BufferGeometry || !G.BufferAttribute) throw new Error("game geometry classes not found");
      const colorFn = withColors && G.Color ? (h) => { const c = new G.Color(h); return [c.r, c.g, c.b]; } : (h) => [1, 1, 1];
      const b = o.buffers(colorFn);
      const g = new G.BufferGeometry();
      g.setAttribute("position", new G.BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new G.BufferAttribute(b.nrm, 3));
      g.setAttribute("uv", new G.BufferAttribute(b.uv, 2));
      if (withColors) g.setAttribute("color", new G.BufferAttribute(b.col, 3));
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    },

    customs(car, G) {
      let holder = car.geo.getObjectByName("__mod_cad_parts__");
      const list = Studio.objs.filter((o) => !o.src && !o.deleted && o.visible);
      if (!holder && !list.length) return;
      if (!G.Group || !G.Mesh || !G.Standard) return;
      if (!holder) { holder = new G.Group(); holder.name = "__mod_cad_parts__"; car.geo.add(holder); }
      while (holder.children.length) {
        const ch = holder.children[0];
        holder.remove(ch);
        if (ch.geometry) ch.geometry.dispose();
        if (ch.material && ch.material.dispose) ch.material.dispose();
      }
      const T = Studio.T;
      for (const o of list) {
        const faceCols = o.poly.col.some(Boolean);
        const mat = new G.Standard({
          color: faceCols ? "#ffffff" : o.color, metalness: o.metal, roughness: o.rough, opacity: o.opacity,
          transparent: o.opacity < 0.999, vertexColors: faceCols, side: 2
        });
        if (mat.emissive && mat.emissive.set) { mat.emissive.set(o.emissive); mat.emissiveIntensity = o.emInt; }
        const m = new G.Mesh(this.buildGeo(o, G, faceCols), mat);
        m.name = "__mod_part_" + o.name;
        o.mesh.updateMatrix();
        const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
        o.mesh.matrix.decompose(p, q, s);
        m.position.set(p.x, p.y, p.z); m.quaternion.set(q.x, q.y, q.z, q.w); m.scale.set(s.x, s.y, s.z);
        holder.add(m);
      }
    },

    neon(car, G) {
      let n = car.geo.getObjectByName("__mod_neon_light__");
      if (S.neonActive && G.PointLight) {
        if (!n) { n = new G.PointLight(S.neonColor, 2.5, 4.0); n.name = "__mod_neon_light__"; n.position.set(0, 0.1, 0); car.geo.add(n); }
        n.color.set(S.neonColor);
      } else if (n) car.geo.remove(n);
    }
  };

  // =========================================================================
  // 7. EDITABLE OBJECT (Poly + a THREE mesh + material + selection + overlays)
  // =========================================================================
  let UID = 1;
  const same3 = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

  class Obj {
    constructor(T, name, poly, kind) {
      this.T = T; this.id = UID++; this.name = name; this.key = name; this.base = []; this.kind = kind;
      this.poly = poly; this.src = null; this.orig = null;
      this.color = "#cccccc"; this.metal = 0.5; this.rough = 0.5; this.opacity = 1; this.emissive = "#000000"; this.emInt = 1;
      this.visible = true; this.deleted = false;
      this.origColor = null; this.origVC = false; this.origTransparent = false;
      this.sel = { v: new Set(), e: new Set(), f: new Set() };
      this.dirty = { t: false, m: false, g: false };
      this.mat = new T.MeshStandardMaterial({
        vertexColors: true, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
      });
      this.geo = null; this.ov = {}; this._cc = new Map();
      this.mesh = new T.Mesh(new T.BufferGeometry(), this.mat);
      this.mesh.userData.obj = this;
    }
    get path() { return this.base.concat(this.name); }

    rgb(hex) {
      let c = this._cc.get(hex);
      if (!c) { const k = new this.T.Color(hex); c = [k.r, k.g, k.b]; this._cc.set(hex, c); }
      return c;
    }

    // Flat per-corner buffers. colorFn(hex) -> [r,g,b]
    buffers(colorFn) {
      const p = this.poly, n = p.nt;
      const pos = new Float32Array(n * 9), uv = new Float32Array(n * 6), col = new Float32Array(n * 9);
      const nrm = p.normals(S.shading, S.angle), cache = new Map(), base = colorFn(this.color);
      for (let i = 0; i < n; i++) {
        let c = base;
        const ch = p.col[i];
        if (ch) { c = cache.get(ch); if (!c) { c = colorFn(ch); cache.set(ch, c); } }
        for (let k = 0; k < 3; k++) {
          const id = p.t[3 * i + k], o = 9 * i + 3 * k;
          pos[o] = p.v[3 * id]; pos[o + 1] = p.v[3 * id + 1]; pos[o + 2] = p.v[3 * id + 2];
          col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2];
          uv[6 * i + 2 * k] = p.uv[6 * i + 2 * k]; uv[6 * i + 2 * k + 1] = p.uv[6 * i + 2 * k + 1];
        }
      }
      return { pos, uv, nrm, col };
    }

    rebuild() {
      const T = this.T, b = this.buffers((h) => this.rgb(h));
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new T.BufferAttribute(b.nrm, 3));
      g.setAttribute("uv", new T.BufferAttribute(b.uv, 2));
      g.setAttribute("color", new T.BufferAttribute(b.col, 3));
      g.computeBoundingSphere(); g.computeBoundingBox();
      const old = this.geo;
      this.geo = g; this.mesh.geometry = g;
      if (old) old.dispose();
      this.applyMat();
      this.rebuildOverlay();
    }

    // Cheap path while dragging: positions only.
    updatePositions() {
      const pa = this.geo.attributes.position, p = this.poly;
      for (let c = 0; c < p.nt * 3; c++) { const id = p.t[c]; pa.setXYZ(c, p.v[3 * id], p.v[3 * id + 1], p.v[3 * id + 2]); }
      pa.needsUpdate = true;
      this.geo.computeBoundingSphere(); this.geo.computeBoundingBox();
      this.rebuildOverlay();
    }

    refreshColors() {
      const p = this.poly, ca = this.geo.attributes.color, base = this.rgb(this.color);
      for (let i = 0; i < p.nt; i++) {
        const c = p.col[i] ? this.rgb(p.col[i]) : base;
        for (let k = 0; k < 3; k++) ca.setXYZ(3 * i + k, c[0], c[1], c[2]);
      }
      ca.needsUpdate = true;
    }

    applyMat() {
      const m = this.mat;
      m.metalness = this.metal; m.roughness = this.rough; m.opacity = this.opacity;
      const tr = this.opacity < 0.999;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.emissive.set(this.emissive); m.emissiveIntensity = this.emInt;
      this.mesh.visible = this.visible && !this.deleted;
    }

    center() {
      const v = this.poly.v, T = this.T;
      if (!v.length) return new T.Vector3();
      let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
      for (let i = 0; i < v.length; i += 3) {
        x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
        y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]);
        z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]);
      }
      return new T.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    }

    // ---- selection ----
    affected() {
      const s = new Set(), sel = this.sel, p = this.poly;
      sel.v.forEach((v) => s.add(v));
      sel.e.forEach((k) => { const [a, b] = k.split("_"); s.add(+a); s.add(+b); });
      sel.f.forEach((i) => { for (let k = 0; k < 3; k++) s.add(p.t[3 * i + k]); });
      return s;
    }
    selCount() { return this.sel.v.size + this.sel.e.size + this.sel.f.size; }
    clearSel() { this.sel.v.clear(); this.sel.e.clear(); this.sel.f.clear(); }

    // ---- history snapshots (Poly is immutable once recorded, so refs are safe) ----
    snap() {
      const m = this.mesh;
      return {
        poly: this.poly, p: m.position.toArray(), q: m.quaternion.toArray(), s: m.scale.toArray(),
        name: this.name, color: this.color, metal: this.metal, rough: this.rough, opacity: this.opacity,
        emissive: this.emissive, emInt: this.emInt, visible: this.visible, deleted: this.deleted
      };
    }
    restore(s) {
      const gChanged = s.poly !== this.poly;
      const keep = s.poly.nv === this.poly.nv && s.poly.nt === this.poly.nt;
      this.poly = s.poly;
      if (!keep) this.clearSel();
      this.mesh.position.fromArray(s.p); this.mesh.quaternion.fromArray(s.q); this.mesh.scale.fromArray(s.s);
      this.name = s.name; this.color = s.color; this.metal = s.metal; this.rough = s.rough; this.opacity = s.opacity;
      this.emissive = s.emissive; this.emInt = s.emInt; this.visible = s.visible; this.deleted = s.deleted;
      this.dirty.t = true; this.dirty.m = true; if (gChanged) this.dirty.g = true;
      this.rebuild();
    }
    isEdited() {
      if (this.kind === "custom") return !this.deleted;
      const a = this.orig;
      if (!a) return true;
      const m = this.mesh;
      return this.poly !== a.poly || this.deleted !== a.deleted || this.visible !== a.visible ||
        !same3(m.position.toArray(), a.p) || !same3(m.quaternion.toArray(), a.q) || !same3(m.scale.toArray(), a.s) ||
        this.color !== a.color || this.metal !== a.metal || this.rough !== a.rough || this.opacity !== a.opacity ||
        this.emissive !== a.emissive || this.emInt !== a.emInt;
    }

    // ---- viewport overlays (wire / vertices / selected edges / selected faces) ----
    clearOverlay() {
      for (const k of Object.keys(this.ov)) {
        const x = this.ov[k];
        this.mesh.remove(x); x.geometry.dispose(); x.material.dispose();
      }
      this.ov = {};
    }
    rebuildOverlay() {
      this.clearOverlay();
      if (this.deleted || !this.visible || !this.geo) return;
      const T = this.T, M = this.mesh, p = this.poly, v = p.v;
      const active = Studio.active === this, mode = S.selMode, edit = active && mode !== "object";
      if (!(active || S.wire)) return;
      const dt = !(S.xray && edit);
      const add = (key, obj) => { obj.frustumCulled = false; obj.renderOrder = 10; obj.raycast = () => {}; M.add(obj); this.ov[key] = obj; };
      const attr = (arr) => { const g = new T.BufferGeometry(); g.setAttribute("position", new T.BufferAttribute(arr, 3)); return g; };

      const el = p.edgeList(), wire = new Float32Array(el.length * 3);
      for (let i = 0; i < el.length; i++) { const a = el[i] * 3; wire[3 * i] = v[a]; wire[3 * i + 1] = v[a + 1]; wire[3 * i + 2] = v[a + 2]; }
      add("wire", new T.LineSegments(attr(wire), new T.LineBasicMaterial({
        color: edit ? 0x7dd3fc : active ? 0xff9f1a : 0x64748b, transparent: true, opacity: edit ? 0.5 : active ? 0.4 : 0.8, depthTest: dt
      })));
      if (!edit) return;

      if (mode === "v") {
        const g = attr(new Float32Array(v)), col = new Float32Array(p.nv * 3);
        for (let i = 0; i < p.nv; i++) {
          const s = this.sel.v.has(i);
          col[3 * i] = s ? 1 : 0.4; col[3 * i + 1] = s ? 0.6 : 0.9; col[3 * i + 2] = s ? 0.1 : 1;
        }
        g.setAttribute("color", new T.BufferAttribute(col, 3));
        add("pts", new T.Points(g, new T.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: dt })));
      }
      if (mode === "e" && this.sel.e.size) {
        const keys = [...this.sel.e], a = new Float32Array(keys.length * 6);
        keys.forEach((k, i) => {
          const [x, y] = k.split("_"), A = +x * 3, B = +y * 3;
          a.set([v[A], v[A + 1], v[A + 2], v[B], v[B + 1], v[B + 2]], i * 6);
        });
        add("selE", new T.LineSegments(attr(a), new T.LineBasicMaterial({ color: 0xff9f1a, depthTest: dt })));
      }
      if (mode === "f" && this.sel.f.size) {
        const fs = [...this.sel.f], a = new Float32Array(fs.length * 9);
        fs.forEach((i, n) => { for (let k = 0; k < 3; k++) { const id = p.t[3 * i + k] * 3; a.set([v[id], v[id + 1], v[id + 2]], n * 9 + k * 3); } });
        add("selF", new T.Mesh(attr(a), new T.MeshBasicMaterial({
          color: 0xff9f1a, transparent: true, opacity: 0.55, side: T.DoubleSide, depthTest: dt, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
        })));
      }
    }

    dispose() { this.clearOverlay(); if (this.geo) this.geo.dispose(); this.mat.dispose(); }
  }

  // Part presets built from welded polys
  function makePoly(T, type) {
    const box = (w, h, d) => Poly.fromGeometry(new T.BoxGeometry(w, h, d));
    const P = (g) => Poly.fromGeometry(g);
    let p;
    switch (type) {
      case "cube": p = box(0.5, 0.5, 0.5); break;
      case "sphere": p = P(new T.SphereGeometry(0.3, 24, 16)); break;
      case "cylinder": p = P(new T.CylinderGeometry(0.2, 0.2, 0.6, 24)); break;
      case "cone": p = P(new T.ConeGeometry(0.25, 0.6, 24)); break;
      case "torus": p = P(new T.TorusGeometry(0.3, 0.08, 12, 28)); break;
      case "plane": { const g = new T.PlaneGeometry(0.8, 0.8); g.rotateX(-Math.PI / 2); p = P(g); break; }
      case "wing":
        p = box(1.3, 0.04, 0.35);
        p.append(box(0.03, 0.22, 0.4), -0.65, -0.09, 0); p.append(box(0.03, 0.22, 0.4), 0.65, -0.09, 0);
        p.append(box(0.04, 0.3, 0.08), -0.4, -0.2, 0); p.append(box(0.04, 0.3, 0.08), 0.4, -0.2, 0);
        break;
      case "spoiler":
        p = box(1.2, 0.05, 0.25);
        p.append(box(0.05, 0.18, 0.12), -0.45, -0.1, 0); p.append(box(0.05, 0.18, 0.12), 0.45, -0.1, 0);
        break;
      case "splitter": p = box(1.5, 0.04, 0.5); break;
      case "bumper": p = box(1.7, 0.25, 0.3); break;
      case "light": p = box(0.3, 0.1, 0.06); break;
      case "exhaust": { const g = new T.CylinderGeometry(0.045, 0.045, 0.5, 16); g.rotateX(Math.PI / 2); p = P(g); break; }
      default: p = box(0.5, 0.5, 0.5);
    }
    p.srcMap = null;
    return p;
  }

  // =========================================================================
  // 8. STUDIO — the fullscreen editor
  // =========================================================================
  const Studio = {
    T: null, objs: [], active: null, open: false, ready: false, _cdn: false,
    mouse: { x: 0, y: 0 }, ctrl: false, xf: null, nav: null, box: null, stroke: null, down: null,
    sph: { radius: 5.5, theta: 0.8, phi: 1.15 }, lastEdit: "v", _syncT: 0, _cct: 0, boundGeo: null,

    // ---------- setup ----------
    init(container) {
      this.container = container;
      const T = (this.T = [window.__FR_THREE, Engine.gameThree, window.THREE].find(fullThree) || null);
      if (!T) {
        if (!this._cdn) {
          this._cdn = true;
          updateStatus("Loading THREE.js from CDN…");
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
          s.onload = () => this.init(container);
          s.onerror = () => updateStatus("Could not load THREE.js (blocked?). Set window.__FR_THREE = THREE and re-run.");
          document.head.appendChild(s);
        }
        return;
      }
      this.canvas = document.createElement("canvas");
      this.canvas.tabIndex = 0;
      this.canvas.style.cssText = "width:100%;height:100%;display:block;outline:none;cursor:default;";
      container.appendChild(this.canvas);

      this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.scene = new T.Scene(); this.scene.__frEditor = true;
      this.camera = new T.PerspectiveCamera(45, 1, 0.05, 300);
      this.target = new T.Vector3(0, 0.45, 0);
      this.raycaster = new T.Raycaster();

      this.scene.add(new T.AmbientLight(0xffffff, 0.75));
      this.scene.add(new T.HemisphereLight(0xdfefff, 0x1b2433, 0.7));
      const key = new T.DirectionalLight(0xffffff, 1.2); key.position.set(7, 14, 9);
      const fill = new T.DirectionalLight(0x7dd3fc, 0.55); fill.position.set(-7, 4, -7);
      const back = new T.DirectionalLight(0xffffff, 0.5); back.position.set(0, -6, 8);
      this.scene.add(key, fill, back);

      this.grid = new T.GridHelper(20, 40, 0x00f0ff, 0x1e293b); this.grid.position.y = -0.002;
      this.axes = new T.AxesHelper(1.2); this.axes.position.y = 0.001;
      this.scene.add(this.grid, this.axes);
      this.root = new T.Group(); this.scene.add(this.root);
      this.neonViz = new T.Group(); this.scene.add(this.neonViz);

      this.bindControls();
      this.resize();
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(container);
      const loop = () => {
        RAF(loop);
        if (!this.open) return;
        this.grid.visible = S.grid; this.axes.visible = S.grid;
        this.renderer.render(this.scene, this.camera);
      };
      loop();

      Engine.onCar = (g) => this.carChanged(g);
      this.ready = true;
      this.updateCamera();
      this.updateNeonViz();
      this.loadCar();
      if (S.autoApply) Project.loadSaved(true);
    },

    resize() {
      if (!this.renderer || !this.container) return;
      const w = this.container.clientWidth, h = this.container.clientHeight;
      if (w > 0 && h > 0) {
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      }
    },

    // ---------- loading ----------
    loadCar() {
      const T = this.T;
      if (!T) return;
      this.xf = null; this.stroke = null;
      for (const o of this.objs) { this.root.remove(o.mesh); o.dispose(); }
      this.objs = []; this.active = null; History.clear();
      const car = Engine.scan(true);
      if (car && car.geo) this.importCar(car); else this.procedural();
      this.boundGeo = car ? car.geo : null;
      let best = null;
      for (const o of this.objs) if (!best || o.poly.nt > best.poly.nt) best = o;
      this.active = best;
      this.objs.forEach((o) => o.rebuildOverlay());
      this.frameAll();
      UI.refresh();
      updateStatus(car ? "Loaded " + this.objs.length + " meshes from the live car" : "No live car found: using the built-in rig (edits stay local; export still works)");
    },

    importCar(car) {
      const T = this.T, geo = car.geo;
      geo.updateWorldMatrix(true, true);
      const gInv = new T.Matrix4().fromArray(geo.matrixWorld.elements).invert();
      const keys = new Map();
      let idx = 0;
      geo.traverse((n) => {
        if (!n.isMesh || n.isSkinnedMesh || n.isInstancedMesh || !n.geometry || !n.geometry.attributes || !n.geometry.attributes.position) return;
        if (isModNode(n, geo)) return;
        const poly = Poly.fromGeometry(n.geometry);
        if (!poly.nt) return;
        const base = [];
        for (let p = n.parent; p && p !== geo; p = p.parent) base.unshift(p.name || "Group");
        const nm = n.name || "Mesh_" + ++idx;
        let key = base.concat(nm).join("/");
        const c = keys.get(key) || 0;
        keys.set(key, c + 1);
        if (c) key += "#" + c;
        const o = new Obj(T, nm, poly, "src");
        o.src = n; o.base = base; o.key = key;
        gInv.clone().multiply(new T.Matrix4().fromArray(n.matrixWorld.elements)).decompose(o.mesh.position, o.mesh.quaternion, o.mesh.scale);
        const sm = Array.isArray(n.material) ? n.material[0] : n.material;
        if (sm) {
          if (sm.color && sm.color.getHexString) o.color = "#" + sm.color.getHexString();
          if (typeof sm.metalness === "number") o.metal = sm.metalness;
          if (typeof sm.roughness === "number") o.rough = sm.roughness;
          if (typeof sm.opacity === "number") o.opacity = sm.opacity;
          if (sm.emissive && sm.emissive.getHexString) o.emissive = "#" + sm.emissive.getHexString();
          if (typeof sm.emissiveIntensity === "number") o.emInt = sm.emissiveIntensity;
          o.origVC = !!sm.vertexColors; o.origTransparent = !!sm.transparent;
        }
        o.origColor = o.color; o.visible = n.visible !== false;
        const pa = n.geometry.attributes.position, na = n.geometry.attributes.normal;
        if (pa.array && !pa.isInterleavedBufferAttribute) o.origPos = pa.array.slice();
        if (na && na.array && !na.isInterleavedBufferAttribute) o.origNrm = na.array.slice();
        this.addObj(o);
        o.orig = o.snap();
      });
    },

    procedural() {
      const T = this.T;
      const mk = (name, poly, x, y, z, color) => {
        const o = new Obj(T, name, poly, "custom");
        o.base = ["Built-in rig"]; o.color = color; o.metal = 0.6; o.rough = 0.3;
        poly.srcMap = null; o.mesh.position.set(x, y, z);
        this.addObj(o);
      };
      mk("Chassis", Poly.fromGeometry(new T.BoxGeometry(1.65, 0.42, 3.2)), 0, 0.38, 0, "#00c8ff");
      mk("Cabin", Poly.fromGeometry(new T.BoxGeometry(1.2, 0.38, 1.6)), 0, 0.76, -0.2, "#111827");
      [["FL", 1, 1], ["FR", -1, 1], ["RL", 1, -1], ["RR", -1, -1]].forEach(([n, sx, sz]) => {
        const g = new T.CylinderGeometry(0.34, 0.34, 0.2, 28); g.rotateZ(Math.PI / 2);
        mk("Wheel_" + n, Poly.fromGeometry(g), sx * 0.68, 0.34, sz * 1.3, "#e5e7eb");
      });
    },

    carChanged(g) {
      if (!this.ready || g === this.boundGeo) return;
      clearTimeout(this._cct);
      this._cct = setTimeout(() => {
        if (History.index >= 0 && this.open) { updateStatus("The game rebuilt the car. Press Reload car to re-import (unsaved edits will be lost)."); return; }
        this.loadCar();
        if (S.autoApply) Project.loadSaved(true);
      }, 500);
    },

    addObj(o) {
      this.objs.push(o); this.root.add(o.mesh);
      o.rebuild();
      return o;
    },
    uniqueName(base) {
      const names = new Set(this.objs.map((o) => o.name));
      if (!names.has(base)) return base;
      let i = 2;
      while (names.has(base + "_" + i)) i++;
      return base + "_" + i;
    },
    snapAll() { return { list: this.objs.slice(), snaps: this.objs.map((o) => o.snap()) }; },
    restoreAll(s) {
      for (const o of this.objs) if (!s.list.includes(o)) this.root.remove(o.mesh);
      for (const o of s.list) if (!this.objs.includes(o)) this.root.add(o.mesh);
      this.objs = s.list.slice();
      s.list.forEach((o, i) => o.restore(s.snaps[i]));
      if (!this.objs.includes(this.active)) this.active = this.objs[0] || null;
    },

    afterEdit(name) {
      updateStatus(name);
      if (this.active) this.active.rebuildOverlay();
      UI.refresh();
      this.scheduleSync();
    },
    scheduleSync() {
      if (!S.liveSync) return;
      clearTimeout(this._syncT);
      this._syncT = setTimeout(() => Sync.run(), 140);
    },
    markDirty(o, flags) {
      if (flags.includes("t")) o.dirty.t = true;
      if (flags.includes("m")) o.dirty.m = true;
      if (flags.includes("g")) o.dirty.g = true;
    },

    // Wrap a change to an object's non-poly properties in an undo step.
    commit(o, name, before, flags) {
      this.markDirty(o, flags);
      const after = o.snap();
      History.record(name, () => o.restore(before), () => o.restore(after));
    },
    // Clone-edit-record helper for mesh topology/vertex edits.
    editPoly(name, fn) {
      const o = this.active;
      if (!o) return null;
      const before = o.snap(), next = o.poly.clone();
      const r = fn(next, o);
      if (r === false) return null;
      o.poly = next; o.clearSel();
      if (r && r.select) r.select(o);
      o.dirty.g = true;
      if (next.col.some(Boolean)) o.dirty.m = true;
      o.rebuild();
      const after = o.snap();
      History.record(name, () => o.restore(before), () => o.restore(after));
      return r || true;
    },

    // ---------- camera ----------
    updateCamera() {
      const s = this.sph;
      this.camera.position.set(
        this.target.x + s.radius * Math.sin(s.phi) * Math.sin(s.theta),
        this.target.y + s.radius * Math.cos(s.phi),
        this.target.z + s.radius * Math.sin(s.phi) * Math.cos(s.theta));
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld(true);
    },
    setView(v) {
      const s = this.sph;
      if (v === "persp") { s.theta = 0.8; s.phi = 1.15; }
      else if (v === "front") { s.theta = 0; s.phi = Math.PI / 2; }
      else if (v === "back") { s.theta = Math.PI; s.phi = Math.PI / 2; }
      else if (v === "right") { s.theta = Math.PI / 2; s.phi = Math.PI / 2; }
      else if (v === "left") { s.theta = -Math.PI / 2; s.phi = Math.PI / 2; }
      else if (v === "top") { s.theta = 0; s.phi = 0.001; }
      else if (v === "under") { s.theta = 0; s.phi = Math.PI - 0.001; }
      this.updateCamera();
    },
    frameBox(b) {
      const T = this.T;
      if (!b || b.isEmpty()) return;
      const c = b.getCenter(new T.Vector3()), size = b.getSize(new T.Vector3());
      this.target.copy(c);
      this.sph.radius = clamp(Math.max(size.x, size.y, size.z) * 1.9, 0.6, 80);
      this.updateCamera();
    },
    worldBox(objs, onlySel) {
      const T = this.T, b = new T.Box3(), t = new T.Vector3();
      for (const o of objs) {
        if (o.deleted || !o.visible) continue;
        o.mesh.updateMatrixWorld(true);
        const ids = onlySel ? [...o.affected()] : null, v = o.poly.v;
        const n = ids ? ids.length : o.poly.nv;
        for (let k = 0; k < n; k++) {
          const i = (ids ? ids[k] : k) * 3;
          b.expandByPoint(t.set(v[i], v[i + 1], v[i + 2]).applyMatrix4(o.mesh.matrixWorld));
        }
      }
      return b;
    },
    frameAll() { this.frameBox(this.worldBox(this.objs, false)); },
    frameSel() {
      const o = this.active;
      if (!o) return this.frameAll();
      const useSel = S.selMode !== "object" && o.selCount() > 0;
      this.frameBox(this.worldBox([o], useSel));
    },

    // ---------- picking ----------
    ndc(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
    },
    rayAll(e) {
      const p = this.ndc(e);
      this.raycaster.setFromCamera(p, this.camera);
      const meshes = this.objs.filter((o) => !o.deleted && o.visible).map((o) => o.mesh);
      this.objs.forEach((o) => o.mesh.updateMatrixWorld(true));
      const h = this.raycaster.intersectObjects(meshes, false)[0];
      return h ? { obj: h.object.userData.obj, hit: h } : null;
    },
    rayObj(e, o) {
      const p = this.ndc(e);
      this.raycaster.setFromCamera(p, this.camera);
      o.mesh.updateMatrixWorld(true);
      return this.raycaster.intersectObject(o.mesh, false)[0] || null;
    },
    // project every vertex of o to canvas pixels
    screenVerts(o) {
      const T = this.T, r = this.canvas.getBoundingClientRect(), n = o.poly.nv, v = o.poly.v;
      const sx = new Float32Array(n), sy = new Float32Array(n), ok = new Uint8Array(n), t = new T.Vector3();
      o.mesh.updateMatrixWorld(true);
      const M = o.mesh.matrixWorld;
      for (let i = 0; i < n; i++) {
        t.set(v[3 * i], v[3 * i + 1], v[3 * i + 2]).applyMatrix4(M).project(this.camera);
        sx[i] = (t.x * 0.5 + 0.5) * r.width; sy[i] = (-t.y * 0.5 + 0.5) * r.height;
        ok[i] = t.z > -1 && t.z < 1 ? 1 : 0;
      }
      return { sx, sy, ok, rect: r };
    },
    visibleW(o, w) {
      const T = this.T, dir = w.clone().sub(this.camera.position), dist = dir.length();
      this.raycaster.set(this.camera.position, dir.normalize());
      const h = this.raycaster.intersectObject(o.mesh, false)[0];
      return !h || h.distance >= dist - 0.03;
    },
    worldOf(o, id) {
      return new this.T.Vector3(o.poly.v[3 * id], o.poly.v[3 * id + 1], o.poly.v[3 * id + 2]).applyMatrix4(o.mesh.matrixWorld);
    },
    nearestVert(e, o) {
      const sv = this.screenVerts(o), px = e.clientX - sv.rect.left, py = e.clientY - sv.rect.top, c = [];
      for (let i = 0; i < o.poly.nv; i++) {
        if (!sv.ok[i]) continue;
        const d = (sv.sx[i] - px) ** 2 + (sv.sy[i] - py) ** 2;
        if (d < 144) c.push([d, i]);
      }
      c.sort((a, b) => a[0] - b[0]);
      for (const [, id] of c.slice(0, 8)) if (S.xray || this.visibleW(o, this.worldOf(o, id))) return id;
      return -1;
    },
    nearestEdge(e, o) {
      const sv = this.screenVerts(o), px = e.clientX - sv.rect.left, py = e.clientY - sv.rect.top, el = o.poly.edgeList(), c = [];
      for (let i = 0; i < el.length; i += 2) {
        const a = el[i], b = el[i + 1];
        if (!sv.ok[a] || !sv.ok[b]) continue;
        const ax = sv.sx[a], ay = sv.sy[a], bx = sv.sx[b], by = sv.sy[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = clamp(t, 0, 1);
        const d = (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
        if (d < 100) c.push([d, a, b]);
      }
      c.sort((a, b) => a[0] - b[0]);
      for (const [, a, b] of c.slice(0, 8)) {
        const mid = this.worldOf(o, a).add(this.worldOf(o, b)).multiplyScalar(0.5);
        if (S.xray || this.visibleW(o, mid)) return Poly.ek(a, b);
      }
      return null;
    },

    setActive(o) {
      const old = this.active;
      if (old === o) return;
      this.active = o;
      if (old) { old.clearSel(); old.rebuildOverlay(); }
      if (o) { o.clearSel(); o.rebuildOverlay(); }
      UI.refresh();
    },
    click(e, shift) {
      if (S.selMode === "object") {
        const h = this.rayAll(e);
        this.setActive(h ? h.obj : null);
        return;
      }
      const h = this.rayAll(e);
      if (h && h.obj !== this.active && !(this.active && this.rayObj(e, this.active))) { this.setActive(h.obj); return; }
      const o = this.active;
      if (!o) return;
      const set = o.sel[S.selMode];
      let id = null;
      if (S.selMode === "f") { const hit = this.rayObj(e, o); id = hit ? hit.faceIndex : null; }
      else if (S.selMode === "v") { const v = this.nearestVert(e, o); id = v >= 0 ? v : null; }
      else id = this.nearestEdge(e, o);
      if (id === null) { if (!shift) { o.clearSel(); } }
      else if (shift) { if (set.has(id)) set.delete(id); else set.add(id); }
      else { o.clearSel(); set.add(id); }
      o.rebuildOverlay(); UI.refreshInfo();
    },
    boxSelect() {
      const b = this.box, o = this.active;
      if (!o || !b || S.selMode === "object") return;
      const r = this.canvas.getBoundingClientRect();
      const x0 = Math.min(b.x0, b.x1) - r.left, x1 = Math.max(b.x0, b.x1) - r.left;
      const y0 = Math.min(b.y0, b.y1) - r.top, y1 = Math.max(b.y0, b.y1) - r.top;
      const sv = this.screenVerts(o), p = o.poly;
      const inside = (i) => sv.ok[i] && sv.sx[i] >= x0 && sv.sx[i] <= x1 && sv.sy[i] >= y0 && sv.sy[i] <= y1;
      if (!b.shift) o.clearSel();
      if (S.selMode === "v") { for (let i = 0; i < p.nv; i++) if (inside(i)) o.sel.v.add(i); }
      else if (S.selMode === "e") {
        const el = p.edgeList();
        for (let i = 0; i < el.length; i += 2) if (inside(el[i]) && inside(el[i + 1])) o.sel.e.add(Poly.ek(el[i], el[i + 1]));
      } else {
        for (let i = 0; i < p.nt; i++) {
          const a = p.t[3 * i], bb = p.t[3 * i + 1], c = p.t[3 * i + 2];
          if (!sv.ok[a] || !sv.ok[bb] || !sv.ok[c]) continue;
          const cx = (sv.sx[a] + sv.sx[bb] + sv.sx[c]) / 3, cy = (sv.sy[a] + sv.sy[bb] + sv.sy[c]) / 3;
          if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) o.sel.f.add(i);
        }
      }
      o.rebuildOverlay(); UI.refreshInfo();
    },

    setMode(m) {
      if (m === S.selMode) return; // PATCH 6: re-pressing the current mode keeps your selection
      const o = this.active, prev = S.selMode;
      if (this.xf) this.finishXf(true);
      if (o && prev !== "object" && m !== "object" && prev !== m) {
        const ids = o.affected(), p = o.poly;
        o.clearSel();
        if (m === "v") ids.forEach((i) => o.sel.v.add(i));
        else if (m === "e") { const el = p.edgeList(); for (let i = 0; i < el.length; i += 2) if (ids.has(el[i]) && ids.has(el[i + 1])) o.sel.e.add(Poly.ek(el[i], el[i + 1])); }
        else { for (let i = 0; i < p.nt; i++) if (ids.has(p.t[3 * i]) && ids.has(p.t[3 * i + 1]) && ids.has(p.t[3 * i + 2])) o.sel.f.add(i); }
      } else if (o) o.clearSel();
      S.selMode = m;
      if (m !== "object") this.lastEdit = m;
      this.objs.forEach((x) => x.rebuildOverlay());
      UI.refresh();
    },
    selectAll() {
      const o = this.active; if (!o || S.selMode === "object") return;
      const p = o.poly; o.clearSel();
      if (S.selMode === "v") for (let i = 0; i < p.nv; i++) o.sel.v.add(i);
      else if (S.selMode === "f") for (let i = 0; i < p.nt; i++) o.sel.f.add(i);
      else { const el = p.edgeList(); for (let i = 0; i < el.length; i += 2) o.sel.e.add(Poly.ek(el[i], el[i + 1])); }
      o.rebuildOverlay(); UI.refreshInfo();
    },
    selectNone() { const o = this.active; if (!o) return; o.clearSel(); o.rebuildOverlay(); UI.refreshInfo(); },
    selectInvert() {
      const o = this.active; if (!o || S.selMode === "object") return;
      const p = o.poly, cur = new Set(o.sel[S.selMode]); o.clearSel();
      if (S.selMode === "v") { for (let i = 0; i < p.nv; i++) if (!cur.has(i)) o.sel.v.add(i); }
      else if (S.selMode === "f") { for (let i = 0; i < p.nt; i++) if (!cur.has(i)) o.sel.f.add(i); }
      else { const el = p.edgeList(); for (let i = 0; i < el.length; i += 2) { const k = Poly.ek(el[i], el[i + 1]); if (!cur.has(k)) o.sel.e.add(k); } }
      o.rebuildOverlay(); UI.refreshInfo();
    },

    // ---------- modal transforms (G / R / S, or drag with a transform tool) ----------
    startXform(kind, how, opts) {
      opts = opts || {};
      const o = this.active, T = this.T;
      if (!o || o.deleted) { updateStatus("Select an object first"); return false; }
      if (this.xf) this.finishXf(false);
      o.mesh.updateMatrixWorld(true);
      const obj = S.selMode === "object";
      const xf = { kind, how, o, obj, axis: opts.axisVec ? opts.axisVec : S.axis, num: "", sx: this.mouse.x, sy: this.mouse.y, before: opts.before || o.snap() };
      if (obj) {
        xf.p0 = o.mesh.position.clone(); xf.q0 = o.mesh.quaternion.clone(); xf.s0 = o.mesh.scale.clone();
        xf.c = o.center();
        xf.pivot = xf.c.clone().applyMatrix4(o.mesh.matrixWorld);
      } else {
        const ids = opts.ids || [...o.affected()];
        if (!ids.length) { updateStatus("Nothing selected"); return false; }
        xf.ids = ids;
        if (!opts.keepPoly) o.poly = o.poly.clone();
        xf.next = o.poly;
        xf.orig = ids.map((id) => [o.poly.v[3 * id], o.poly.v[3 * id + 1], o.poly.v[3 * id + 2]]);
        xf.M = o.mesh.matrixWorld.clone(); xf.Minv = xf.M.clone().invert();
        const pv = new T.Vector3();
        xf.orig.forEach((p) => pv.add(new T.Vector3(p[0], p[1], p[2]).applyMatrix4(xf.M)));
        xf.pivot = pv.multiplyScalar(1 / ids.length);
      }
      this.xf = xf;
      this.canvas.style.cursor = "move";
      this.applyXf();
      return true;
    },
    axisVec(xf) {
      const a = xf.axis, T = this.T;
      if (!a) return null;
      if (a === "x") return new T.Vector3(1, 0, 0);
      if (a === "y") return new T.Vector3(0, 1, 0);
      if (a === "z") return new T.Vector3(0, 0, 1);
      return a.clone();
    },
    applyXf() {
      const xf = this.xf;
      if (!xf) return;
      const T = this.T, cam = this.camera, o = xf.o, r = this.canvas.getBoundingClientRect();
      const px = this.mouse.x - xf.sx, py = this.mouse.y - xf.sy;
      const k = (2 * cam.position.distanceTo(xf.pivot) * Math.tan((cam.fov * Math.PI) / 360)) / r.height;
      const ax = this.axisVec(xf), snap = S.snap || this.ctrl, num = xf.num !== "" ? parseFloat(xf.num) : NaN;
      const aname = typeof xf.axis === "string" ? xf.axis.toUpperCase() : xf.axis ? "normal" : "";
      let tf, hint;

      if (xf.kind === "move") {
        let vec;
        if (!isNaN(num)) vec = (ax || new T.Vector3(1, 0, 0)).clone().multiplyScalar(num);
        else if (ax) {
          const toS = (w) => { const q = w.clone().project(cam); return { x: (q.x * 0.5 + 0.5) * r.width, y: (-q.y * 0.5 + 0.5) * r.height }; };
          const s0 = toS(xf.pivot), s1 = toS(xf.pivot.clone().add(ax));
          const sdx = s1.x - s0.x, sdy = s1.y - s0.y, l2 = sdx * sdx + sdy * sdy;
          let amt = l2 > 1e-6 ? (px * sdx + py * sdy) / l2 : 0;
          if (snap) amt = Math.round(amt / 0.05) * 0.05;
          vec = ax.clone().multiplyScalar(amt);
        } else {
          const right = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new T.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
          vec = right.multiplyScalar(px * k).add(up.multiplyScalar(-py * k));
          if (snap) vec.set(Math.round(vec.x / 0.05) * 0.05, Math.round(vec.y / 0.05) * 0.05, Math.round(vec.z / 0.05) * 0.05);
        }
        tf = (w) => w.add(vec);
        hint = "Move " + aname + " " + vec.x.toFixed(3) + ", " + vec.y.toFixed(3) + ", " + vec.z.toFixed(3);
        xf.vec = vec;
      } else if (xf.kind === "rotate") {
        let ang = !isNaN(num) ? (num * Math.PI) / 180 : px * 0.01;
        if (snap && isNaN(num)) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
        const axis = ax ? ax.clone().normalize() : cam.getWorldDirection(new T.Vector3()).negate();
        const q = new T.Quaternion().setFromAxisAngle(axis, ang);
        tf = (w) => w.sub(xf.pivot).applyQuaternion(q).add(xf.pivot);
        xf.q = q;
        hint = "Rotate " + (aname || "view") + " " + ((ang * 180) / Math.PI).toFixed(1) + "°";
      } else {
        let f = !isNaN(num) ? num : Math.max(0.01, 1 + px * 0.01);
        if (snap && isNaN(num)) f = Math.round(f / 0.05) * 0.05 || 0.05;
        tf = (w) => {
          const d = w.sub(xf.pivot);
          if (ax) d.add(ax.clone().multiplyScalar((f - 1) * d.dot(ax)));
          else d.multiplyScalar(f);
          return d.add(xf.pivot);
        };
        xf.f = f;
        hint = "Scale " + (aname || "uniform") + " ×" + f.toFixed(3);
      }

      if (xf.obj) {
        const m = o.mesh;
        m.position.copy(xf.p0); m.quaternion.copy(xf.q0); m.scale.copy(xf.s0);
        if (xf.kind === "move") m.position.add(xf.vec);
        else if (xf.kind === "rotate") { m.quaternion.premultiply(xf.q); m.updateMatrixWorld(true); m.position.add(xf.pivot.clone().sub(xf.c.clone().applyMatrix4(m.matrixWorld))); }
        else {
          if (typeof xf.axis === "string") m.scale[xf.axis] = xf.s0[xf.axis] * xf.f; else m.scale.copy(xf.s0).multiplyScalar(xf.f);
          m.updateMatrixWorld(true); m.position.add(xf.pivot.clone().sub(xf.c.clone().applyMatrix4(m.matrixWorld)));
        }
        m.updateMatrixWorld(true);
      } else {
        const p = xf.next, w = new T.Vector3();
        xf.ids.forEach((id, i) => {
          const q = xf.orig[i];
          w.set(q[0], q[1], q[2]).applyMatrix4(xf.M);
          tf(w);
          w.applyMatrix4(xf.Minv);
          p.v[3 * id] = w.x; p.v[3 * id + 1] = w.y; p.v[3 * id + 2] = w.z;
        });
        o.updatePositions();
      }
      UI.hint(hint + (isNaN(num) ? "" : "  (typed)") + "   · X/Y/Z axis · type a number · Enter/click confirm · Esc cancel");
    },
    finishXf(cancel) {
      const xf = this.xf;
      if (!xf) return;
      this.xf = null;
      // PATCH 7: reset sticky axis after keyboard ops; ignore click-without-drag
      if (xf.how === "key") { S.axis = null; UI.refreshAxis(); }
      if (!cancel && xf.how === "drag" && xf.num === "" && this.mouse.x === xf.sx && this.mouse.y === xf.sy) cancel = true;
      this.canvas.style.cursor = "default";
      const o = xf.o;
      UI.hint("");
      if (cancel) { o.restore(xf.before); UI.refresh(); updateStatus("Cancelled"); return; }
      if (!xf.obj) o.rebuild();
      const label = (xf.obj ? "Object " : "Mesh ") + xf.kind;
      this.commit(o, label, xf.before, xf.obj ? "t" : "g");
    },

    // ---------- mesh operations ----------
    deleteSel() {
      const o = this.active;
      if (!o) return;
      if (S.selMode === "object") return this.deleteObj(o);
      const sel = o.sel, p = o.poly;
      let tris;
      if (S.selMode === "f") tris = new Set(sel.f);
      else if (S.selMode === "v") tris = p.trisWithVerts(sel.v);
      else tris = p.trisWithEdges(sel.e);
      if (!tris.size) return updateStatus("Nothing selected to delete");
      this.editPoly("Delete " + tris.size + " faces", (np) => { np.deleteTris(tris); });
    },
    deleteObj(o) {
      if (!o) return;
      const before = o.snap();
      o.deleted = true;
      o.applyMat(); o.rebuildOverlay(); // PATCH 1: actually hide the mesh
      this.commit(o, "Delete " + o.name, before, "t");
      if (this.active === o) { this.active = null; UI.refresh(); }
    },
    extrude() {
      const o = this.active, T = this.T;
      if (!o || S.selMode === "object" || S.selMode === "v") return updateStatus("Extrude works on selected faces or edges");
      const faces = S.selMode === "f";
      if (!(faces ? o.sel.f.size : o.sel.e.size)) return updateStatus("Select " + (faces ? "faces" : "edges") + " first");
      const before = o.snap(), next = o.poly.clone();
      let res, dirW = null;
      const keepF = new Set(o.sel.f);
      if (faces) { res = next.extrudeFaces(o.sel.f); dirW = new T.Vector3(res.dir[0], res.dir[1], res.dir[2]).transformDirection(o.mesh.matrixWorld); }
      else res = next.extrudeEdges(o.sel.e);
      o.poly = next; o.clearSel();
      if (faces) keepF.forEach((i) => o.sel.f.add(i)); else res.edges.forEach((k) => o.sel.e.add(k));
      o.dirty.g = true;
      o.rebuild();
      this.startXform("move", "key", { before, ids: [...res.verts], keepPoly: true, axisVec: dirW });
    },
    makeFace() {
      const o = this.active;
      if (!o || S.selMode !== "v" || o.sel.v.size < 3) return updateStatus("Vertex mode: select 3 or more vertices (in order), then F");
      const ids = [...o.sel.v], T = this.T;
      const c = new T.Vector3();
      ids.forEach((id) => c.add(this.worldOf(o, id)));
      c.multiplyScalar(1 / ids.length);
      const inv = o.mesh.matrixWorld.clone().invert();
      const vd = c.sub(this.camera.position).normalize().transformDirection(inv);
      this.editPoly("Create face", (p) => {
        p.addFace(ids, [vd.x, vd.y, vd.z]);
        return { select: (ob) => ids.forEach((id) => ob.sel.v.add(id)) };
      });
    },
    subdivide() {
      const o = this.active;
      if (!o || S.selMode !== "f" || !o.sel.f.size) return updateStatus("Face mode: select faces to subdivide");
      const f = new Set(o.sel.f);
      this.editPoly("Subdivide", (p) => { const out = p.subdivide(f); return { select: (ob) => out.forEach((i) => ob.sel.f.add(i)) }; });
    },
    flipFaces() {
      const o = this.active;
      if (!o) return;
      const f = S.selMode === "f" && o.sel.f.size ? new Set(o.sel.f) : new Set(Array.from({ length: o.poly.nt }, (_, i) => i));
      this.editPoly("Flip normals", (p) => { p.flip(f); return { select: (ob) => f.forEach((i) => { if (S.selMode === "f") ob.sel.f.add(i); }) }; });
    },
    recalc() {
      const o = this.active;
      if (!o) return;
      const before = o.snap();
      o.poly = o.poly.clone();
      o.rebuild();
      this.commit(o, "Recalculate normals (" + S.shading + ")", before, "g");
    },
    setShading(mode, angle) {
      S.shading = mode; if (angle) S.angle = angle;
      this.objs.forEach((o) => { o.rebuild(); if (o.src) o.dirty.g = o.dirty.g || o.poly !== (o.orig && o.orig.poly); });
      this.scheduleSync();
    },
    // numeric median editing of selected elements
    median() {
      const o = this.active;
      if (!o) return null;
      const ids = [...o.affected()];
      if (!ids.length) return null;
      const m = [0, 0, 0];
      ids.forEach((id) => { m[0] += o.poly.v[3 * id]; m[1] += o.poly.v[3 * id + 1]; m[2] += o.poly.v[3 * id + 2]; });
      return m.map((x) => x / ids.length);
    },
    setMedian(axis, val) {
      const o = this.active, m = this.median();
      if (!o || !m) return;
      const d = val - m[axis], ids = [...o.affected()], sel = { v: new Set(o.sel.v), e: new Set(o.sel.e), f: new Set(o.sel.f) };
      this.editPoly("Move selection", (p) => { ids.forEach((id) => { p.v[3 * id + axis] += d; }); return { select: (ob) => { sel.v.forEach((x) => ob.sel.v.add(x)); sel.e.forEach((x) => ob.sel.e.add(x)); sel.f.forEach((x) => ob.sel.f.add(x)); } }; });
    },

    // ---------- objects & parts ----------
    addPart(type, label) {
      const T = this.T, before = this.snapAll();
      const o = new Obj(T, this.uniqueName(label), makePoly(T, type), "custom");
      o.base = ["Custom parts"]; o.color = S.partColor; o.metal = 0.6; o.rough = 0.3;
      if (type === "light") { o.color = "#ffffff"; o.emissive = "#ffffcc"; o.emInt = 1.6; }
      o.mesh.position.set(this.target.x, Math.max(this.target.y, 0.3), this.target.z);
      this.addObj(o);
      this.active = o; if (S.selMode !== "object") { S.selMode = "object"; this.objs.forEach((x) => x.rebuildOverlay()); }
      const after = this.snapAll();
      History.record("Add " + label, () => this.restoreAll(before), () => this.restoreAll(after));
    },
    duplicate(o) {
      o = o || this.active;
      if (!o) return;
      const T = this.T, before = this.snapAll();
      const c = new Obj(T, this.uniqueName(o.name.replace(/_\d+$/, "") + "_copy"), o.poly.clone(), "custom");
      c.poly.srcMap = null;
      c.base = ["Custom parts"];
      c.color = o.color; c.metal = o.metal; c.rough = o.rough; c.opacity = o.opacity; c.emissive = o.emissive; c.emInt = o.emInt; c.visible = true;
      c.mesh.position.copy(o.mesh.position).x += 0.15;
      c.mesh.quaternion.copy(o.mesh.quaternion); c.mesh.scale.copy(o.mesh.scale);
      this.addObj(c);
      this.active = c;
      const after = this.snapAll();
      History.record("Duplicate " + o.name, () => this.restoreAll(before), () => this.restoreAll(after));
    },
    revert(o) {
      o = o || this.active;
      if (!o || !o.orig) return updateStatus("Only parts of the original car can be reverted");
      const before = o.snap();
      o.restore(o.orig);
      this.commit(o, "Revert " + o.name, before, "tmg");
    },
    revertAll() {
      const before = this.snapAll();
      this.objs.forEach((o) => { if (o.orig) o.restore(o.orig); });
      this.objs.filter((o) => !o.orig).forEach((o) => { o.deleted = true; o.rebuild(); });
      const after = this.snapAll();
      History.record("Revert all", () => this.restoreAll(before), () => this.restoreAll(after));
    },

    // ---------- painting ----------
    paintDown(e) {
      const T = this.T;
      let o = this.active;
      if (S.selMode === "object" || !o) {
        const h = this.rayAll(e);
        if (!h) return;
        o = h.obj;
        if (S.selMode === "object") {
          this.setActive(o);
          const before = o.snap();
          o.poly = o.poly.clone(); o.poly.col.fill(null);
          o.color = S.paintColor;
          o.refreshColors(); o.rebuild();
          this.commit(o, "Paint " + o.name, before, "mg");
          return;
        }
        this.setActive(o);
      }
      this.stroke = { o, before: o.snap(), next: o.poly.clone(), changed: false };
      o.poly = this.stroke.next;
      this.paintFace(e);
    },
    paintFace(e) {
      const st = this.stroke;
      if (!st) return;
      const h = this.rayObj(e, st.o);
      if (!h || h.faceIndex === undefined) return;
      if (st.next.col[h.faceIndex] !== S.paintColor) { st.next.col[h.faceIndex] = S.paintColor; st.changed = true; st.o.refreshColors(); }
    },
    paintUp() {
      const st = this.stroke;
      this.stroke = null;
      if (!st) return;
      if (!st.changed) { st.o.poly = st.before.poly; return; }
      this.commit(st.o, "Paint faces", st.before, "gm");
    },
    paintSelected(clear) {
      const o = this.active;
      if (!o) return;
      if (S.selMode === "object") {
        const before = o.snap();
        if (clear) { o.poly = o.poly.clone(); o.poly.col.fill(null); } else { o.poly = o.poly.clone(); o.poly.col.fill(null); o.color = S.paintColor; }
        o.rebuild(); return this.commit(o, clear ? "Clear face paint" : "Paint object", before, "mg");
      }
      const ids = new Set(S.selMode === "f" ? o.sel.f : o.poly.trisWithVerts(o.affected()));
      if (!ids.size) return updateStatus("Select something to paint first");
      const sel = { v: new Set(o.sel.v), e: new Set(o.sel.e), f: new Set(o.sel.f) }, c = clear ? null : S.paintColor;
      this.editPoly(clear ? "Clear face paint" : "Paint faces", (p) => {
        ids.forEach((i) => { p.col[i] = c; });
        return { select: (ob) => { sel.v.forEach((x) => ob.sel.v.add(x)); sel.e.forEach((x) => ob.sel.e.add(x)); sel.f.forEach((x) => ob.sel.f.add(x)); } };
      });
    },

    // ---------- neon preview ----------
    updateNeonViz() {
      const T = this.T;
      if (!T) return;
      while (this.neonViz.children.length) {
        const c = this.neonViz.children[0]; this.neonViz.remove(c);
        if (c.geometry) c.geometry.dispose(); if (c.material && c.material.dispose) c.material.dispose();
      }
      this.neonViz.visible = !!S.neonActive;
      const mat = new T.MeshBasicMaterial({ color: S.neonColor }), g = new T.CylinderGeometry(0.02, 0.02, 2.2);
      g.rotateX(Math.PI / 2);
      const a = new T.Mesh(g, mat); a.position.set(-0.75, 0.08, 0);
      const b = new T.Mesh(g.clone(), mat); b.position.set(0.75, 0.08, 0);
      const l = new T.PointLight(S.neonColor, 2.5, 4.0); l.position.set(0, 0.05, 0);
      this.neonViz.add(a, b, l);
    },

    // ---------- input ----------
    bindControls() {
      const cv = this.canvas;
      cv.addEventListener("contextmenu", (e) => e.preventDefault());
      cv.addEventListener("pointerdown", (e) => {
        cv.focus();
        this.mouse = { x: e.clientX, y: e.clientY }; this.ctrl = e.ctrlKey || e.metaKey;
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (this.xf && this.xf.how === "key") { if (e.button === 0) this.finishXf(false); else if (e.button === 2) this.finishXf(true); return; }
        if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
          this.nav = { type: e.shiftKey ? "pan" : "orbit", x: e.clientX, y: e.clientY };
          cv.style.cursor = "grabbing";
          return;
        }
        if (e.button !== 0) return;
        if (S.tool === "move" || S.tool === "rotate" || S.tool === "scale") {
          if (S.selMode === "object") { const h = this.rayAll(e); if (h && h.obj !== this.active) this.setActive(h.obj); }
          this.startXform(S.tool, "drag");
          return;
        }
        if (S.tool === "paint") { this.paintDown(e); return; }
        this.down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, moved: false };
      });
      cv.addEventListener("pointermove", (e) => {
        this.mouse = { x: e.clientX, y: e.clientY }; this.ctrl = e.ctrlKey || e.metaKey;
        if (this.down && !this.nav && !this.box && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) {
          if (S.selMode === "object") { this.nav = { type: e.shiftKey ? "pan" : "orbit", x: this.down.x, y: this.down.y }; this.down = null; cv.style.cursor = "grabbing"; }
          else { this.box = { x0: this.down.x, y0: this.down.y, x1: e.clientX, y1: e.clientY, shift: this.down.shift }; this.down.moved = true; }
        }
        if (this.nav) {
          const dx = e.clientX - this.nav.x, dy = e.clientY - this.nav.y;
          this.nav.x = e.clientX; this.nav.y = e.clientY;
          if (this.nav.type === "orbit") {
            this.sph.theta -= dx * 0.008;
            this.sph.phi = clamp(this.sph.phi - dy * 0.008, 0.001, Math.PI - 0.001);
          } else {
            const T = this.T, h = cv.clientHeight || 1, k = (2 * this.sph.radius * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
            const right = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0), up = new T.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
            this.target.addScaledVector(right, -dx * k); this.target.addScaledVector(up, dy * k);
          }
          this.updateCamera();
        } else if (this.box) {
          this.box.x1 = e.clientX; this.box.y1 = e.clientY; UI.drawBox(this.box);
        } else if (this.xf) this.applyXf();
        else if (this.stroke) this.paintFace(e);
      });
      const up = (e, cancelled) => {
        if (this.nav) { this.nav = null; cv.style.cursor = "default"; return; }
        if (this.xf && this.xf.how === "drag") { this.finishXf(!!cancelled); return; }
        if (this.stroke) { this.paintUp(); return; }
        if (this.box) { if (!cancelled) this.boxSelect(); this.box = null; UI.drawBox(null); this.down = null; return; }
        if (this.down) { const d = this.down; this.down = null; if (!d.moved && !cancelled) this.click(e, d.shift); }
      };
      cv.addEventListener("pointerup", (e) => up(e, false));
      cv.addEventListener("pointercancel", (e) => up(e, true));
      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.sph.radius = clamp(this.sph.radius * Math.exp(e.deltaY * 0.0012), 0.3, 120);
        this.updateCamera();
      }, { passive: false });
    },

    onKey(e) {
      if (!this.open) return;
      const tgt = e.composedPath ? e.composedPath()[0] : e.target, tag = tgt && tgt.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (tgt && tgt.isContentEditable)) {
        if (e.code === "Escape" || e.code === "Enter") tgt.blur();
        return;
      }
      e.stopImmediatePropagation();
      const k = e.code, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey;
      this.ctrl = ctrl;
      if (this.xf) {
        const xf = this.xf;
        if (k === "Escape") this.finishXf(true);
        else if (k === "Enter" || k === "NumpadEnter") this.finishXf(false);
        else if (k === "KeyX" || k === "KeyY" || k === "KeyZ") {
          const a = k.slice(3).toLowerCase();
          xf.axis = xf.axis === a ? null : a; S.axis = xf.axis; this.applyXf(); UI.refreshAxis();
        } else if (/^[0-9.\-]$/.test(e.key)) { xf.num += e.key; this.applyXf(); }
        else if (k === "Backspace") { xf.num = xf.num.slice(0, -1); this.applyXf(); }
        e.preventDefault();
        return;
      }
      const prevent = () => e.preventDefault();
      if (ctrl && k === "KeyZ") { prevent(); if (sh) History.redo(); else History.undo(); }
      else if (ctrl && k === "KeyY") { prevent(); History.redo(); }
      else if (ctrl && k === "KeyI") { prevent(); this.selectInvert(); }
      else if (ctrl && k.startsWith("Numpad")) { prevent(); this.numpadView(k, true); }
      else if (k === "Escape") { if (S.tool !== "select") { S.tool = "select"; UI.refresh(); } else UI.exitStudio(); }
      else if (k === "Tab") { prevent(); this.setMode(S.selMode === "object" ? this.lastEdit : "object"); }
      else if (k === "Digit1") this.setMode("v");
      else if (k === "Digit2") this.setMode("e");
      else if (k === "Digit3") this.setMode("f");
      else if (k === "Digit0") this.setMode("object");
      else if (k === "KeyG") { prevent(); this.startXform("move", "key"); }
      else if (k === "KeyR") { prevent(); this.startXform("rotate", "key"); }
      else if (k === "KeyS" && !ctrl) { prevent(); this.startXform("scale", "key"); }
      else if (k === "KeyE") { prevent(); this.extrude(); }
      else if (k === "KeyF") { prevent(); this.makeFace(); }
      else if (k === "Delete" || k === "Backspace" || k === "KeyX") { prevent(); this.deleteSel(); }
      else if (k === "KeyA") { prevent(); if (alt) this.selectNone(); else this.selectAll(); }
      else if (k === "KeyD" && sh) { prevent(); this.duplicate(); }
      else if (k === "Period" || k === "NumpadDecimal") { prevent(); this.frameSel(); }
      else if (k === "Home") { prevent(); this.frameAll(); }
      else if (k.startsWith("Numpad")) { prevent(); this.numpadView(k, false); }
      else if (k === "KeyB") { prevent(); S.tool = "select"; UI.refresh(); }
    },
    numpadView(k, opp) {
      const map = { Numpad1: ["front", "back"], Numpad3: ["right", "left"], Numpad7: ["top", "under"], Numpad5: ["persp", "persp"] };
      if (map[k]) this.setView(map[k][opp ? 1 : 0]);
    }
  };
  Studio.ctrlKeyHandler = (e) => Studio.onKey(e);

  // =========================================================================
  // 9. PROJECT: export / import / persist
  // =========================================================================
  const Project = {
    serialize() {
      const objs = Studio.objs.filter((o) => o.isEdited() || (o.src && o.deleted)).map((o) => {
        const m = o.mesh;
        return {
          key: o.key, name: o.name, kind: o.src ? "src" : "custom", visible: o.visible, deleted: o.deleted,
          p: m.position.toArray().map(r5), q: m.quaternion.toArray().map(r5), s: m.scale.toArray().map(r5),
          mat: { color: o.color, metal: o.metal, rough: o.rough, opacity: o.opacity, emissive: o.emissive, emInt: o.emInt },
          geo: o.poly.toJSON()
        };
      });
      return { format: "fastroads-cad", version: 2, vehicle: Engine.currentType, objects: objs };
    },
    apply(data) {
      if (!data || data.format !== "fastroads-cad" || !Array.isArray(data.objects)) throw new Error("Not a Fast Roads project file");
      const T = Studio.T, before = Studio.snapAll();
      const byKey = new Map(Studio.objs.filter((o) => o.src).map((o) => [o.key, o]));
      // PATCH 5: drop existing custom parts first so re-loading doesn't duplicate them (undo restores them)
      Studio.objs.filter((o) => !o.src).forEach((o) => Studio.root.remove(o.mesh));
      Studio.objs = Studio.objs.filter((o) => o.src);
      if (!Studio.objs.includes(Studio.active)) Studio.active = null;
      let applied = 0, skipped = 0;
      for (const d of data.objects) {
        const poly = Poly.fromJSON(d.geo);
        let o;
        if (d.kind === "src") {
          o = byKey.get(d.key);
          if (!o) { skipped++; continue; }
          if (o.orig && poly.sameTopology(o.orig.poly)) poly.srcMap = o.orig.poly.srcMap;
        } else {
          o = new Obj(T, d.name, poly, "custom");
          o.base = ["Custom parts"];
          Studio.addObj(o);
        }
        o.poly = poly; o.name = d.name || o.name;
        o.mesh.position.fromArray(d.p); o.mesh.quaternion.fromArray(d.q); o.mesh.scale.fromArray(d.s);
        const m = d.mat || {};
        o.color = m.color || o.color; o.metal = m.metal ?? o.metal; o.rough = m.rough ?? o.rough; o.opacity = m.opacity ?? o.opacity;
        o.emissive = m.emissive || o.emissive; o.emInt = m.emInt ?? o.emInt;
        o.visible = d.visible !== false; o.deleted = !!d.deleted;
        o.clearSel(); o.dirty = { t: true, m: true, g: true };
        o.rebuild();
        applied++;
      }
      const after = Studio.snapAll();
      History.record("Import project", () => Studio.restoreAll(before), () => Studio.restoreAll(after));
      return { applied, skipped };
    },
    download(name, text, mime) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: mime || "application/json" }));
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    exportJSON() {
      const data = this.serialize();
      this.download("fastroads-" + String(Engine.currentType).toLowerCase() + ".json", JSON.stringify(data));
      updateStatus("Exported " + data.objects.length + " edited objects");
    },
    exportOBJ() {
      const T = Studio.T, t = new T.Vector3();
      let out = "# Fast Roads Studio export\n", vo = 1, uo = 1;
      for (const o of Studio.objs) {
        if (o.deleted || !o.visible) continue;
        o.mesh.updateMatrixWorld(true);
        const p = o.poly, M = o.mesh.matrixWorld;
        out += "o " + o.name.replace(/\s+/g, "_") + "\n";
        for (let i = 0; i < p.nv; i++) { t.set(p.v[3 * i], p.v[3 * i + 1], p.v[3 * i + 2]).applyMatrix4(M); out += "v " + r5(t.x) + " " + r5(t.y) + " " + r5(t.z) + "\n"; }
        for (let c = 0; c < p.nt * 3; c++) out += "vt " + r5(p.uv[2 * c]) + " " + r5(p.uv[2 * c + 1]) + "\n";
        for (let i = 0; i < p.nt; i++) {
          out += "f";
          for (let k = 0; k < 3; k++) out += " " + (vo + p.t[3 * i + k]) + "/" + (uo + 3 * i + k);
          out += "\n";
        }
        vo += p.nv; uo += p.nt * 3;
      }
      this.download("fastroads-model.obj", out, "text/plain");
      updateStatus("Exported OBJ");
    },
    importFile(file) {
      const rd = new FileReader();
      rd.onload = () => {
        try { const r = this.apply(JSON.parse(rd.result)); updateStatus("Imported " + r.applied + " objects" + (r.skipped ? " (" + r.skipped + " unmatched skipped)" : "")); }
        catch (err) { updateStatus("Import failed: " + err.message); }
      };
      rd.readAsText(file);
    },
    saveLocal() {
      try {
        localStorage.setItem(KEY + "_project", JSON.stringify(this.serialize()));
        updateStatus("Saved to this browser");
      } catch (err) { updateStatus("Save failed (storage full?). Use Export JSON instead."); }
    },
    loadSaved(silent) {
      try {
        const raw = localStorage.getItem(KEY + "_project");
        if (!raw) { if (!silent) updateStatus("No saved project in this browser"); return; }
        const r = this.apply(JSON.parse(raw));
        updateStatus("Loaded saved project: " + r.applied + " objects");
      } catch (err) { if (!silent) updateStatus("Load failed: " + err.message); }
    }
  };

  // =========================================================================
  // 10. UI — shared helpers
  // =========================================================================
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    (kids || []).forEach((k) => { if (k == null || k === false) return; n.appendChild(typeof k === "string" ? document.createTextNode(k) : k); });
    return n;
  };
  const btn = (label, fn, cls, title) => el("button", { className: "cb " + (cls || ""), textContent: label, onclick: fn, title: title || "" });
  const statusEls = [];
  const updateStatus = (t) => statusEls.forEach((s) => { s.textContent = t; });
  const MONO = "ui-monospace,Menlo,Consolas,monospace";
  const spring = "cubic-bezier(.34,1.56,.64,1)";

  const css = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    /* ---------- floating liquid-glass mod menu ---------- */
    .p { position: relative; width: 420px; color: #000; font: 13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      border-radius: 34px; background: linear-gradient(135deg, rgba(255,255,255,.24), rgba(255,255,255,.08));
      -webkit-backdrop-filter: blur(14px) saturate(190%) brightness(1.08); backdrop-filter: blur(14px) saturate(190%) brightness(1.08);
      backdrop-filter: url(#lgfilter) blur(6px) saturate(190%) brightness(1.08);
      box-shadow: 0 18px 50px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.2), inset 0 0 0 1px rgba(255,255,255,.18), inset 0 1px 1px rgba(255,255,255,.6);
      transition: transform .6s ${spring}; user-select: none; overflow: hidden; }
    .p::before { content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px; pointer-events: none; z-index: 3;
      background: linear-gradient(140deg, rgba(255,255,255,.95), rgba(255,255,255,.08) 28%, rgba(255,255,255,.04) 62%, rgba(255,255,255,.7));
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
    .p::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 0;
      background: radial-gradient(230px circle at var(--mx,30%) var(--my,0%), rgba(255,255,255,.26), rgba(255,255,255,0) 62%); }
    .h, .b { position: relative; z-index: 1; }
    .h { padding: 15px 18px 9px; display: flex; justify-content: space-between; align-items: center; cursor: grab; touch-action: none; font-weight: 700; font-size: 14.5px; }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34c759; margin-left: 8px; box-shadow: 0 0 8px #34c759; }
    .dot.bad { background: #ff453a; box-shadow: 0 0 8px #ff453a; }
    .win-btns { display: flex; gap: 6px; }
    .min { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,.4); background: linear-gradient(160deg, rgba(255,255,255,.35), rgba(255,255,255,.1));
      box-shadow: inset 0 1px 1px rgba(255,255,255,.6); color: #000; font-size: 15px; line-height: 24px; text-align: center; cursor: pointer; padding: 0; transition: transform .3s ${spring}; }
    .min:hover { transform: scale(1.1); } .min:active { transform: scale(.9); }
    .b { padding: 2px 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .b.hide { display: none !important; }
    .tabs { position: relative; display: flex; padding: 3px; border-radius: 18px; background: rgba(0,0,0,.22); box-shadow: inset 0 1px 3px rgba(0,0,0,.25), 0 1px 0 rgba(255,255,255,.2); }
    .tab { flex: 1; text-align: center; padding: 8px 0; font-weight: 600; font-size: 12px; cursor: pointer; position: relative; z-index: 1; opacity: .7; }
    .tab.on { opacity: 1; }
    .ind { position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3); border-radius: 15px;
      background: linear-gradient(160deg, rgba(255,255,255,.42), rgba(255,255,255,.14)); box-shadow: inset 0 1px 1px rgba(255,255,255,.7), 0 2px 8px rgba(0,0,0,.2); transition: transform .55s ${spring}; }
    .tabs.t1 .ind { transform: translateX(100%); } .tabs.t2 .ind { transform: translateX(200%); }
    .pg { display: flex; flex-direction: column; gap: 10px; animation: pgin .45s ${spring}; }
    .pg.hide { display: none; }
    @keyframes pgin { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }
    .card { background: linear-gradient(160deg, rgba(255,255,255,.2), rgba(255,255,255,.06)); border-radius: 24px; padding: 11px 13px;
      box-shadow: inset 0 1px 1px rgba(255,255,255,.5), inset 0 0 0 1px rgba(255,255,255,.12), 0 4px 14px rgba(0,0,0,.12); display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .lbl { font-weight: 600; font-size: 12.5px; } .lbl small { display: block; opacity: .75; font-size: 10.5px; font-weight: 400; margin-top: 1px; }
    .step { display: flex; align-items: center; gap: 2px; background: rgba(0,0,0,.22); border-radius: 16px; padding: 3px; box-shadow: inset 0 1px 3px rgba(0,0,0,.25), 0 1px 0 rgba(255,255,255,.2); }
    .step button { width: 28px; height: 28px; border: 0; border-radius: 13px; background: linear-gradient(160deg, rgba(255,255,255,.34), rgba(255,255,255,.12)); box-shadow: inset 0 1px 1px rgba(255,255,255,.6); color: #000; font-size: 17px; line-height: 26px; cursor: pointer; padding: 0; }
    .step input { width: 50px; text-align: center; background: transparent; border: 0; color: #000; font: 700 13px -apple-system, system-ui, sans-serif; outline: none; padding: 0; }
    .sw { width: 50px; height: 30px; border-radius: 15px; background: rgba(255,255,255,.2); box-shadow: inset 0 1px 3px rgba(0,0,0,.28), 0 1px 0 rgba(255,255,255,.25); position: relative; cursor: pointer; transition: background .3s; flex: none; }
    .sw i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 12px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4); transition: transform .45s ${spring}; }
    .sw.on { background: rgba(52,199,89,.9); } .sw.on i { transform: translateX(20px); }
    .rbtn { border: 0; border-radius: 14px; padding: 6px 14px; background: linear-gradient(160deg, rgba(255,255,255,.38), rgba(255,255,255,.14)); box-shadow: inset 0 1px 1px rgba(255,255,255,.6), 0 2px 6px rgba(0,0,0,.15); color: #000; font: 600 12px -apple-system, system-ui, sans-serif; cursor: pointer; transition: transform .2s ${spring}; }
    .rbtn:hover { transform: scale(1.04); }
    .rbtn.launch { width: 100%; padding: 12px; font-size: 13.5px; font-weight: 700; color: #fff; background: linear-gradient(135deg, #0ea5e9, #0284c7); box-shadow: 0 4px 16px rgba(2,132,199,.4); }
    select.glass-select { background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.3); border-radius: 14px; padding: 5px 12px; color: #000; font-weight: 600; font-size: 12px; outline: none; cursor: pointer; }
    .status { font: 11px ${MONO}; opacity: .85; min-height: 13px; padding: 0 6px; }
    .diag { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { font: 600 11px -apple-system, system-ui, sans-serif; padding: 3px 9px; border-radius: 10px; background: rgba(0,0,0,.18); }
    .chip.ok { background: rgba(52,199,89,.55); } .chip.no { background: rgba(255,69,58,.5); }

    /* ---------- fullscreen CAD studio ---------- */
    .cad { position: fixed; inset: 0; background: #0b1220; color: #e2e8f0; font: 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; display: flex; flex-direction: column; user-select: none; }
    .cad-top { height: 46px; flex: none; background: #111a2e; border-bottom: 1px solid rgba(255,255,255,.08); display: flex; align-items: center; justify-content: space-between; padding: 0 12px; gap: 12px; }
    .grp { display: flex; align-items: center; gap: 6px; }
    .brand { font-weight: 800; color: #00f0ff; letter-spacing: .4px; margin-right: 6px; }
    .seg { display: flex; background: #0b1220; border-radius: 9px; padding: 2px; border: 1px solid rgba(255,255,255,.08); }
    .seg button { background: transparent; border: 0; color: #94a3b8; font: 600 12px system-ui, sans-serif; padding: 5px 11px; border-radius: 7px; cursor: pointer; }
    .seg button:hover { color: #fff; } .seg button.on { background: #00f0ff; color: #001018; }
    .cb { background: #25324b; border: 1px solid rgba(255,255,255,.12); color: #e2e8f0; font: 600 11.5px system-ui, sans-serif; padding: 5px 10px; border-radius: 8px; cursor: pointer; }
    .cb:hover { background: #33446a; } .cb:disabled { opacity: .4; cursor: default; }
    .cb.pri { background: #00c8e0; color: #001018; border-color: #00f0ff; } .cb.dan { background: #b91c1c; border-color: #ef4444; }
    .cb.on { background: #00f0ff; color: #001018; } .cb.sm { padding: 3px 7px; font-size: 11px; }
    .cad-main { flex: 1; display: flex; min-height: 0; }
    .view { flex: 1; position: relative; min-width: 0; background: radial-gradient(circle at 50% 40%, #1c2a45 0%, #070b14 100%); overflow: hidden; }
    .shelf { position: absolute; top: 12px; left: 12px; display: flex; flex-direction: column; gap: 4px; z-index: 5; background: rgba(15,23,42,.8); padding: 5px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); backdrop-filter: blur(6px); }
    .shelf .cb { text-align: left; min-width: 96px; background: transparent; border-color: transparent; color: #94a3b8; }
    .shelf .cb:hover { background: rgba(255,255,255,.1); color: #fff; } .shelf .cb.on { background: #00f0ff; color: #001018; }
    .shelf hr { border: 0; border-top: 1px solid rgba(255,255,255,.1); margin: 3px 0; }
    .vbar { position: absolute; left: 12px; right: 12px; bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px; z-index: 5; pointer-events: none; }
    .vbar > * { pointer-events: auto; }
    .hint { background: rgba(15,23,42,.82); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 6px 12px; font: 11.5px ${MONO}; max-width: 70%; }
    .vinfo { position: absolute; right: 12px; top: 12px; z-index: 5; background: rgba(15,23,42,.8); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 6px 10px; font: 11px ${MONO}; text-align: right; }
    .boxsel { position: absolute; border: 1px dashed #00f0ff; background: rgba(0,240,255,.09); pointer-events: none; display: none; z-index: 4; }
    .side { width: 320px; flex: none; background: #111a2e; border-left: 1px solid rgba(255,255,255,.08); display: flex; flex-direction: column; min-height: 0; }
    .out { flex: none; height: 34%; min-height: 160px; display: flex; flex-direction: column; border-bottom: 1px solid rgba(255,255,255,.08); padding: 8px; gap: 6px; }
    .out input.search, .side input[type=text] { background: #0b1220; border: 1px solid rgba(255,255,255,.12); color: #e2e8f0; border-radius: 8px; padding: 5px 8px; font: 12px system-ui, sans-serif; outline: none; width: 100%; user-select: text; }
    .tree { flex: 1; overflow: auto; background: rgba(0,0,0,.25); border-radius: 8px; padding: 3px; }
    .ti { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .ti:hover { background: rgba(255,255,255,.07); } .ti.on { background: rgba(0,240,255,.18); outline: 1px solid rgba(0,240,255,.45); color: #00f0ff; font-weight: 700; }
    .ti .eye { opacity: .7; width: 16px; text-align: center; } .ti .eye.off { opacity: .25; }
    .ti .nm { overflow: hidden; text-overflow: ellipsis; flex: 1; } .ti small { color: #64748b; font-size: 10px; }
    .ti.fold { color: #94a3b8; font-weight: 600; }
    .scroll { flex: 1; overflow: auto; padding: 6px 8px 14px; }
    details { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; margin-bottom: 6px; }
    summary { cursor: pointer; padding: 7px 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; font-size: 10.5px; letter-spacing: .6px; }
    .dbody { padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
    .rowf { display: flex; align-items: center; gap: 6px; } .rowf > label { width: 66px; color: #94a3b8; flex: none; }
    .rowf .grow { flex: 1; } .wrapb { display: flex; flex-wrap: wrap; gap: 5px; }
    input.num { width: 0; flex: 1; min-width: 0; background: #0b1220; border: 1px solid rgba(255,255,255,.12); color: #e2e8f0; border-radius: 6px; padding: 4px 5px; font: 11.5px ${MONO}; outline: none; user-select: text; }
    input[type=range] { flex: 1; min-width: 0; accent-color: #00f0ff; } input[type=color] { width: 34px; height: 24px; border: 0; background: none; padding: 0; cursor: pointer; }
    input.hex { width: 78px !important; font-family: ${MONO}; } .val { width: 38px; text-align: right; font: 11px ${MONO}; color: #94a3b8; }
    select.cs { background: #0b1220; border: 1px solid rgba(255,255,255,.12); color: #e2e8f0; border-radius: 6px; padding: 4px; font: 12px system-ui, sans-serif; }
    .note { color: #64748b; font-size: 10.5px; line-height: 1.35; }
    .ax.on { background: #00f0ff; color: #001018; }
  `;

  const stepper = (init, min, max, step, onSet) => {
    const input = el("input", { type: "number", min, max, step: "any", value: init });
    const wrap = el("div", { className: "step" }, [el("button", { textContent: "−" }), input, el("button", { textContent: "+" })]);
    const set = (v) => { v = parseFloat(v); if (isNaN(v)) v = min; v = clamp(v, min, max); input.value = r5(v); onSet(v); };
    input.onchange = () => set(input.value);
    wrap.children[0].onclick = () => set(parseFloat(input.value) - step);
    wrap.children[2].onclick = () => set(parseFloat(input.value) + step);
    return { wrap, input, set };
  };
  const mkSwitch = (val, onToggle) => {
    const sw = el("div", { className: "sw" + (val ? " on" : "") }, [el("i")]);
    sw.onclick = () => { const v = !sw.classList.contains("on"); sw.classList.toggle("on", v); onToggle(v); };
    return sw;
  };

  // =========================================================================
  // 11. FLOATING MOD MENU
  // =========================================================================
  const host = document.createElement("div");
  host.id = "fastroads-cad-host";
  host.style.cssText = "position:fixed;top:40px;left:20px;z-index:2147483645;";
  window.__fastRoadsStudioHost = host;
  const mhost = document.createElement("div");
  mhost.id = "fastroads-cad-modal-host";
  mhost.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:none;";

  const STOP = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "touchstart", "touchmove", "touchend", "touchcancel",
    "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "keydown", "keyup", "keypress", "input", "change"];
  [host, mhost].forEach((h) => STOP.forEach((ev) => h.addEventListener(ev, (e) => e.stopPropagation())));

  const root = host.attachShadow({ mode: "open" });
  const mroot = mhost.attachShadow({ mode: "open" });

  const svgs = [];
  const mkSvg = () => {
    const d = document.createElement("div");
    d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;pointer-events:none"><defs>
      <filter id="lgfilter" filterUnits="userSpaceOnUse" x="0" y="0" width="700" height="700" color-interpolation-filters="sRGB">
      <feImage x="0" y="0" width="700" height="700" preserveAspectRatio="none" result="map"/>
      <feDisplacementMap in="SourceGraphic" in2="map" scale="36" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>`;
    const s = d.firstChild; svgs.push(s); return s;
  };
  const makeMap = (w, h, r, bezel) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"), img = ctx.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + 0.5 - w / 2, py = y + 0.5 - h / 2, qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
      const dist = -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r);
      let dx = 0, dy = 0;
      if (dist >= 0 && dist < bezel) {
        const t = 1 - dist / bezel, mag = t * t;
        let nx, ny;
        if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); nx = Math.sign(px) * qx / l; ny = Math.sign(py) * qy / l; }
        else if (qx > qy) { nx = Math.sign(px); ny = 0; } else { nx = 0; ny = Math.sign(py); }
        dx = -nx * mag; dy = -ny * mag;
      }
      const i = (y * w + x) * 4;
      d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  };

  const minBtn = el("button", { className: "min", textContent: "–" });
  const closeBtn = el("button", { className: "min", textContent: "×", style: "font-size:16px;line-height:22px;" });
  const dot = el("span", { className: "dot" });
  const head = el("div", { className: "h" }, [el("span", {}, ["Fast Roads Studio ", dot]), el("div", { className: "win-btns" }, [minBtn, closeBtn])]);
  const menuStatus = el("div", { className: "status", textContent: "Ready" });
  statusEls.push(menuStatus);

  // --- tab 0: Studio ---
  const vehicleDropdown = el("select", { className: "glass-select" });
  ["Roadster", "Coach", "Bike", "Lambo", "Supercar"].forEach((t) => {
    const o = el("option", { value: t, textContent: t });
    if (t === Engine.currentType) o.selected = true;
    vehicleDropdown.appendChild(o);
  });
  vehicleDropdown.onchange = (e) => Engine.setVehicleType(e.target.value);
  const diag = el("div", { className: "diag" });
  const chip = (txt, ok) => el("span", { className: "chip " + (ok ? "ok" : "no"), textContent: txt });
  const renderDiag = () => {
    diag.innerHTML = "";
    const car = Engine.car;
    diag.appendChild(chip("THREE (game)", !!Engine.gameThree));
    diag.appendChild(chip("Car", !!car));
    diag.appendChild(chip("Editor", Studio.ready));
    diag.appendChild(chip(Studio.objs.length + " meshes", Studio.objs.length > 0));
    dot.classList.toggle("bad", !car);
  };
  const launchBtn = el("button", { className: "rbtn launch", textContent: "⛶ Open Fullscreen CAD Studio" });
  const page0 = el("div", { className: "pg" }, [
    el("div", { className: "card" }, [el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Vehicle model", el("small", {}, ["Switch the game's car type"])]), vehicleDropdown])]),
    el("div", { className: "card" }, [diag,
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Auto-apply saved design", el("small", {}, ["Re-apply on load / car change"])]), mkSwitch(S.autoApply, (v) => { S.autoApply = v; })]),
      el("div", { className: "row" }, [
        el("button", { className: "rbtn", textContent: "Reload car", onclick: () => Studio.loadCar() }),
        el("button", { className: "rbtn", textContent: "Apply saved", onclick: () => Project.loadSaved(false) }),
        el("button", { className: "rbtn", textContent: "Save design", onclick: () => Project.saveLocal() })
      ])]),
    el("div", { className: "card" }, [launchBtn])
  ]);

  // --- tab 1: Physics ---
  const applyWheels = () => {
    const c = Engine.car;
    if (!c || !c.wheels) return updateStatus("car.wheels not found in this game build");
    const w = c.wheels;
    if ("radius" in w) w.radius = S.wheelRadius;
    if ("length" in w) w.length = S.wheelbase;
  };
  const page1 = el("div", { className: "pg hide" }, [
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Engine power", el("small", {}, ["Scales top speed & acceleration (1.0 = stock)"])]), stepper(S.enginePower, 0.1, 20, 0.1, (v) => { S.enginePower = v; }).wrap]),
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Gravity", el("small", {}, ["m/s² (stock −9.81)"])]), stepper(S.gravityY, -40, 10, 0.5, (v) => { S.gravityY = v; }).wrap])]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Wheel radius", el("small", {}, ["Applied only if your build exposes it"])]), stepper(S.wheelRadius, 0.15, 0.8, 0.02, (v) => { S.wheelRadius = v; applyWheels(); }).wrap]),
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Wheelbase", el("small", {}, ["Axle spacing"])]), stepper(S.wheelbase, 1.5, 4.5, 0.05, (v) => { S.wheelbase = v; applyWheels(); }).wrap])]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["No-clip", el("small", {}, ["Ignore barrier collisions"])]), mkSwitch(S.noClip, (v) => { S.noClip = v; })]),
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Infinite boost", el("small", {}, ["Hold W / ↑ to keep accelerating"])]), mkSwitch(S.infiniteBoost, (v) => { S.infiniteBoost = v; })]),
      el("div", { className: "row" }, [el("div", { className: "lbl" }, ["Anti-drift grip", el("small", {}, ["Zero lateral slip"])]), mkSwitch(S.infiniteGrip, (v) => { S.infiniteGrip = v; })])])
  ]);

  // --- tab 2: Internals ---
  const searchIn = el("input", { type: "text", placeholder: "Search property path…", style: "background:rgba(0,0,0,.2);border:0;border-radius:12px;padding:8px 12px;color:#000;outline:none;" });
  const scroller = el("div", { style: "height:240px;overflow-y:auto;background:rgba(0,0,0,.2);border-radius:18px;padding:4px;" });
  const renderTable = () => {
    scroller.innerHTML = "";
    const car = Engine.scan(true);
    if (!car) { scroller.appendChild(el("div", { style: "padding:16px;text-align:center;opacity:.6;" }, ["Car not spawned yet. Start driving first."])); return; }
    const q = searchIn.value.trim().toLowerCase(), rows = [], seen = new Set();
    const walk = (prefix, obj, depth) => {
      if (!obj || depth > 2 || seen.has(obj)) return;
      seen.add(obj);
      for (const k of Object.keys(obj)) {
        let val; try { val = obj[k]; } catch (e) { continue; }
        const path = prefix + "." + k;
        if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") { if (!q || path.toLowerCase().includes(q)) rows.push({ path, obj, key: k, val }); }
        else if (val && typeof val === "object" && !Array.isArray(val) && !val.isObject3D && !val.isMaterial && !val.isBufferGeometry && !val.isTexture) walk(path, val, depth + 1);
      }
    };
    walk("car", car, 0);
    rows.slice(0, 80).forEach((it) => {
      const inp = el("input", { value: String(it.val), style: "width:110px;background:rgba(255,255,255,.15);border:0;border-radius:8px;padding:4px;color:#000;font:11px monospace;" });
      inp.onchange = () => { const cur = it.obj[it.key]; if (typeof cur === "boolean") it.obj[it.key] = inp.value === "true"; else if (typeof cur === "number") { const n = Number(inp.value); if (!isNaN(n)) it.obj[it.key] = n; } else it.obj[it.key] = inp.value; };
      scroller.appendChild(el("div", { style: "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08);" }, [
        el("div", { style: "font:11px monospace;color:#000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px;", title: it.path }, [it.path]), inp]));
    });
    if (!rows.length) scroller.appendChild(el("div", { style: "padding:16px;text-align:center;opacity:.6;" }, ["No matching properties"]));
  };
  searchIn.oninput = renderTable;
  const page2 = el("div", { className: "pg hide" }, [searchIn, scroller]);

  const tabA = el("div", { className: "tab on", textContent: "Studio" }), tabB = el("div", { className: "tab", textContent: "Physics" }), tabC = el("div", { className: "tab", textContent: "Internals" });
  const tabs = el("div", { className: "tabs" }, [el("div", { className: "ind" }), tabA, tabB, tabC]);
  const body = el("div", { className: "b" }, [tabs, page0, page1, page2, menuStatus]);
  const panel = el("div", { className: "p" }, [head, body]);
  const setTab = (i) => {
    S.tab = i;
    tabs.classList.toggle("t1", i === 1); tabs.classList.toggle("t2", i === 2);
    [tabA, tabB, tabC].forEach((t, j) => t.classList.toggle("on", j === i));
    [page0, page1, page2].forEach((p, j) => p.classList.toggle("hide", j !== i));
    if (i === 0) renderDiag();
    if (i === 2) renderTable();
  };
  tabA.onclick = () => setTab(0); tabB.onclick = () => setTab(1); tabC.onclick = () => setTab(2);

  // =========================================================================
  // 12. FULLSCREEN CAD MODAL
  // =========================================================================
  const cad = el("div", { className: "cad" });
  const view = el("div", { className: "view" });
  const boxEl = el("div", { className: "boxsel" });
  const hintEl = el("div", { className: "hint" });
  const infoEl = el("div", { className: "vinfo" });
  const caStatus = el("div", { className: "status", style: "padding:0 4px;color:#94a3b8;" });
  statusEls.push(caStatus);

  const modeBtns = {}, toolBtns = {};
  const modeSeg = el("div", { className: "seg" }, [["object", "Object", "Tab / 0"], ["v", "Vertex", "1"], ["e", "Edge", "2"], ["f", "Face", "3"]].map(([m, l, t]) => {
    const b = el("button", { textContent: l, title: t, onclick: () => Studio.setMode(m) });
    modeBtns[m] = b; return b;
  }));
  const undoBtn = btn("↶ Undo", () => History.undo(), "", "Ctrl+Z");
  const redoBtn = btn("↷ Redo", () => History.redo(), "", "Ctrl+Shift+Z");
  const viewSeg = el("div", { className: "grp" }, [["persp", "Persp"], ["front", "Front"], ["right", "Side"], ["top", "Top"], ["under", "Under"]].map(([v, l]) => btn(l, () => Studio.setView(v), "sm")));
  viewSeg.appendChild(btn("Frame", () => Studio.frameSel(), "sm", "."));

  const exitStudio = () => {
    if (Studio.xf) Studio.finishXf(true);
    Studio.open = false;
    window.removeEventListener("keydown", Studio.ctrlKeyHandler, true);
    mhost.style.display = "none";
    host.style.display = "block";
    Sync.run();
    renderDiag();
  };
  const openStudio = () => {
    if (!Studio.ready) { updateStatus("Editor is still starting (loading THREE.js)…"); Studio.init(view); return; }
    Studio.open = true;
    host.style.display = "none";
    mhost.style.display = "block";
    window.addEventListener("keydown", Studio.ctrlKeyHandler, true);
    setTimeout(() => { Studio.resize(); UI.refresh(); Studio.canvas.focus(); }, 60);
  };

  cad.appendChild(el("div", { className: "cad-top" }, [
    el("div", { className: "grp" }, [el("span", { className: "brand", textContent: "FAST ROADS CAD" }), modeSeg, undoBtn, redoBtn]),
    el("div", { className: "grp" }, [viewSeg, btn("⟳ Reload car", () => { if (!History.stack.length || confirm("Reload from the live car? Unsaved edits will be lost.")) Studio.loadCar(); }, "", "Re-import meshes from the game"),
      btn("✓ Sync to car", () => { Studio.objs.forEach((o) => { o.dirty.t = o.dirty.m = o.dirty.g = o.isEdited(); }); updateStatus(Sync.run() ? "Synced to live car" : "No live car to sync to"); }, "pri"),
      btn("✕ Exit", exitStudio, "dan", "Esc")])
  ]));

  const shelf = el("div", { className: "shelf" });
  [["select", "⬚ Select", "Click select · drag box (edit) / orbit (object)"], ["move", "✥ Move", "Drag to move (G)"], ["rotate", "⟳ Rotate", "Drag to rotate (R)"], ["scale", "⤢ Scale", "Drag to scale (S)"], ["paint", "🎨 Paint", "Click / drag to paint"]].forEach(([t, l, ti]) => {
    const b = btn(l, () => { S.tool = t; UI.refresh(); }, "", ti); toolBtns[t] = b; shelf.appendChild(b);
  });
  shelf.appendChild(el("hr"));
  shelf.appendChild(btn("⇪ Extrude (E)", () => Studio.extrude()));
  shelf.appendChild(btn("▱ Make face (F)", () => Studio.makeFace()));
  shelf.appendChild(btn("✂ Delete (Del)", () => Studio.deleteSel()));

  const axBtns = {};
  const axisBar = el("div", { className: "grp" }, [
    ...["x", "y", "z"].map((a) => { const b = btn(a.toUpperCase(), () => { S.axis = S.axis === a ? null : a; if (Studio.xf) { Studio.xf.axis = S.axis; Studio.applyXf(); } UI.refreshAxis(); }, "ax sm", "Lock axis"); axBtns[a] = b; return b; }),
    (() => { const b = btn("Snap", () => { S.snap = !S.snap; UI.refreshAxis(); }, "sm", "Ctrl while dragging"); axBtns.snap = b; return b; })()
  ]);
  view.append(shelf, infoEl, boxEl, el("div", { className: "vbar" }, [hintEl, axisBar]));

  const sidebar = el("div", { className: "side" });
  const searchBox = el("input", { type: "text", className: "search", placeholder: "Search objects…" });
  const treeEl = el("div", { className: "tree" });
  searchBox.oninput = () => renderOutliner();
  sidebar.appendChild(el("div", { className: "out" }, [el("div", { className: "grp", style: "justify-content:space-between" }, [el("b", { style: "color:#94a3b8;font-size:10.5px;letter-spacing:.6px", textContent: "OUTLINER" }), caStatus]), searchBox, treeEl]));
  const propsEl = el("div", { className: "scroll" });
  sidebar.appendChild(propsEl);
  cad.appendChild(el("div", { className: "cad-main" }, [view, sidebar]));

  // ---------- outliner ----------
  const folderOpen = new Map();
  const renderOutliner = () => {
    treeEl.innerHTML = "";
    if (!Studio.ready) return;
    const q = searchBox.value.trim().toLowerCase();
    const live = Studio.objs.filter((o) => !o.deleted);
    const item = (o, depth, showPath) => {
      const eye = el("span", { className: "eye" + (o.visible ? "" : " off"), textContent: "👁", title: "Show / hide" });
      eye.onclick = (e) => {
        e.stopPropagation();
        const b = o.snap(); o.visible = !o.visible; o.applyMat(); o.rebuildOverlay();
        Studio.commit(o, (o.visible ? "Show " : "Hide ") + o.name, b, "t");
      };
      const row = el("div", { className: "ti" + (Studio.active === o ? " on" : ""), style: "padding-left:" + (6 + depth * 14) + "px", onclick: () => Studio.setActive(o) }, [
        eye, el("span", { className: "nm", textContent: o.name, title: o.path.join(" / ") }),
        showPath ? el("small", { textContent: o.base.join("/") }) : el("small", { textContent: o.src ? "" : "new" })]);
      return row;
    };
    if (q) {
      live.filter((o) => o.path.join("/").toLowerCase().includes(q)).forEach((o) => treeEl.appendChild(item(o, 0, true)));
      if (!treeEl.children.length) treeEl.appendChild(el("div", { className: "note", style: "padding:8px", textContent: "No matches" }));
      return;
    }
    const rootN = { kids: new Map(), objs: [] };
    live.forEach((o) => { let n = rootN; o.base.forEach((seg) => { if (!n.kids.has(seg)) n.kids.set(seg, { kids: new Map(), objs: [] }); n = n.kids.get(seg); }); n.objs.push(o); });
    const draw = (n, depth, pathKey) => {
      n.kids.forEach((child, name) => {
        const key = pathKey + "/" + name, open = folderOpen.get(key) !== false;
        treeEl.appendChild(el("div", { className: "ti fold", style: "padding-left:" + (6 + depth * 14) + "px", onclick: () => { folderOpen.set(key, !open); renderOutliner(); } }, [el("span", { textContent: open ? "▾" : "▸" }), el("span", { className: "nm", textContent: name })]));
        if (open) draw(child, depth + 1, key);
      });
      n.objs.forEach((o) => treeEl.appendChild(item(o, depth, false)));
    };
    draw(rootN, 0, "");
  };

  // ---------- property widgets ----------
  const numField = (val, onSet, step) => {
    const i = el("input", { type: "number", className: "num", value: String(r5(val)), step: String(step || 0.05) });
    i.onchange = () => { const v = parseFloat(i.value); if (!isNaN(v)) onSet(v); };
    return i;
  };
  const sliderRow = (o, label, get, set, min, max, step, flags) => {
    let pending = null;
    const inp = el("input", { type: "range", min, max, step, value: get() }), val = el("span", { className: "val", textContent: Number(get()).toFixed(2) });
    inp.oninput = () => { if (!pending) pending = o.snap(); set(+inp.value); val.textContent = (+inp.value).toFixed(2); o.applyMat(); Studio.markDirty(o, flags); Studio.scheduleSync(); };
    inp.onchange = () => { if (pending) { const b = pending, a = o.snap(); pending = null; History.record("Edit " + label, () => o.restore(b), () => o.restore(a)); } };
    return el("div", { className: "rowf" }, [el("label", { textContent: label }), inp, val]);
  };
  const colorRow = (o, label, get, set, onLive, flags) => {
    let pending = null;
    const pick = el("input", { type: "color", value: get() }), hex = el("input", { type: "text", className: "num hex", value: get(), maxLength: 7 });
    const live = (v) => { if (!isHex(v)) return false; if (!pending) pending = o.snap(); set(v.toLowerCase()); onLive(); Studio.markDirty(o, flags); Studio.scheduleSync(); return true; };
    const end = () => { if (pending) { const b = pending, a = o.snap(); pending = null; History.record("Edit " + label, () => o.restore(b), () => o.restore(a)); } };
    pick.oninput = () => { hex.value = pick.value; live(pick.value); };
    pick.onchange = end;
    hex.onchange = () => { let v = hex.value.trim(); if (v[0] !== "#") v = "#" + v; if (live(v)) { pick.value = v; end(); } else hex.value = get(); };
    return el("div", { className: "rowf" }, [el("label", { textContent: label }), pick, hex]);
  };
  const vec3Row = (label, vals, onSet, step) => el("div", { className: "rowf" }, [el("label", { textContent: label }), ...vals.map((v, i) => numField(v, (x) => onSet(i, x), step))]);

  const openState = { transform: true, material: true, paint: false, mesh: true, add: true, project: false, view: false };
  const section = (key, title, kids) => {
    const d = el("details", { open: !!openState[key] }, [el("summary", { textContent: title }), el("div", { className: "dbody" }, kids)]);
    d.addEventListener("toggle", () => { openState[key] = d.open; });
    return d;
  };

  const renderProps = () => {
    propsEl.innerHTML = "";
    if (!Studio.ready) { propsEl.appendChild(el("div", { className: "note", style: "padding:10px", textContent: "Waiting for THREE.js…" })); return; }
    const o = Studio.active, T = Studio.T;
    const edit = S.selMode !== "object";

    if (o) {
      const nameIn = el("input", { type: "text", value: o.name });
      nameIn.onchange = () => { const v = nameIn.value.trim(); if (!v || v === o.name) return; const b = o.snap(); o.name = v; Studio.commit(o, "Rename", b, ""); };
      propsEl.appendChild(el("div", { className: "dbody", style: "padding:4px 2px 8px" }, [
        el("div", { className: "rowf" }, [nameIn]),
        el("div", { className: "wrapb" }, [btn("⧉ Duplicate", () => Studio.duplicate(o), "sm", "Shift+D"), btn("🗑 Delete", () => Studio.deleteObj(o), "sm dan"),
          btn("↺ Revert", () => Studio.revert(o), "sm", "Back to the game's original"), btn("⌖ Frame", () => Studio.frameSel(), "sm")])]));

      const e = new T.Euler().setFromQuaternion(o.mesh.quaternion), D = 180 / Math.PI;
      const tfEdit = (fn) => { const b = o.snap(); fn(); o.mesh.updateMatrixWorld(true); o.rebuildOverlay(); Studio.commit(o, "Transform " + o.name, b, "t"); };
      propsEl.appendChild(section("transform", "Transform", [
        vec3Row("Position", o.mesh.position.toArray(), (i, v) => tfEdit(() => { const a = o.mesh.position.toArray(); a[i] = v; o.mesh.position.fromArray(a); }), 0.05),
        vec3Row("Rotation°", [e.x * D, e.y * D, e.z * D], (i, v) => tfEdit(() => { const a = [e.x, e.y, e.z]; a[i] = (v * Math.PI) / 180; o.mesh.quaternion.setFromEuler(new T.Euler(a[0], a[1], a[2], e.order)); }), 5),
        vec3Row("Scale", o.mesh.scale.toArray(), (i, v) => tfEdit(() => { const a = o.mesh.scale.toArray(); a[i] = v || 0.001; o.mesh.scale.fromArray(a); }), 0.05),
        el("div", { className: "note", textContent: "Tip: G / R / S in the viewport, or drag with a transform tool." })]));

      propsEl.appendChild(section("material", "Material (this part only)", [
        colorRow(o, "Color", () => o.color, (v) => { o.color = v; }, () => { o.refreshColors(); }, "m"),
        sliderRow(o, "Metal", () => o.metal, (v) => { o.metal = v; }, 0, 1, 0.01, "m"),
        sliderRow(o, "Rough", () => o.rough, (v) => { o.rough = v; }, 0, 1, 0.01, "m"),
        sliderRow(o, "Opacity", () => o.opacity, (v) => { o.opacity = v; }, 0.05, 1, 0.01, "m"),
        colorRow(o, "Emissive", () => o.emissive, (v) => { o.emissive = v; }, () => o.applyMat(), "m"),
        sliderRow(o, "Glow", () => o.emInt, (v) => { o.emInt = v; }, 0, 4, 0.05, "m"),
        el("div", { className: "note", textContent: "Editor preview is lit by studio lights; the game's own lighting/environment decides how metallic parts look in-game." })]));

      const pc = el("input", { type: "color", value: S.paintColor }), ph = el("input", { type: "text", className: "num hex", value: S.paintColor, maxLength: 7 });
      pc.oninput = () => { S.paintColor = pc.value; ph.value = pc.value; };
      ph.onchange = () => { let v = ph.value.trim(); if (v[0] !== "#") v = "#" + v; if (isHex(v)) { S.paintColor = v.toLowerCase(); pc.value = v; } else ph.value = S.paintColor; };
      propsEl.appendChild(section("paint", "Paint (colour / faces)", [
        el("div", { className: "rowf" }, [el("label", { textContent: "Brush" }), pc, ph]),
        el("div", { className: "wrapb" }, [btn(S.selMode === "object" ? "Fill whole part" : "Paint selected faces", () => Studio.paintSelected(false), "sm pri"), btn("Clear face paint", () => Studio.paintSelected(true), "sm")]),
        el("div", { className: "note", textContent: "Paint tool: click a part in Object mode to recolour just that part; in Vertex/Edge/Face mode click or drag across faces." })]));

      const info = el("div", { className: "note", id: "meshinfo" });
      const shadeSel = el("select", { className: "cs" }, ["flat", "smooth", "auto"].map((m) => { const op = el("option", { value: m, textContent: m }); if (m === S.shading) op.selected = true; return op; }));
      shadeSel.onchange = () => Studio.setShading(shadeSel.value);
      const med = Studio.median();
      const meshKids = [
        el("div", { className: "wrapb" }, [btn("Extrude", () => Studio.extrude(), "sm", "E"), btn("Delete", () => Studio.deleteSel(), "sm dan", "Del"), btn("Make face", () => Studio.makeFace(), "sm", "F"), btn("Subdivide", () => Studio.subdivide(), "sm"),
          btn("Flip normals", () => Studio.flipFaces(), "sm"), btn("Recalc normals", () => Studio.recalc(), "sm")]),
        el("div", { className: "wrapb" }, [btn("All", () => Studio.selectAll(), "sm", "A"), btn("None", () => Studio.selectNone(), "sm", "Alt+A"), btn("Invert", () => Studio.selectInvert(), "sm", "Ctrl+I")]),
        el("div", { className: "rowf" }, [el("label", { textContent: "Shading" }), shadeSel, numField(S.angle, (v) => Studio.setShading(S.shading, clamp(v, 1, 180)), 5), el("span", { className: "val", textContent: "° auto" })]),
        med && edit ? vec3Row("Median", med, (i, v) => Studio.setMedian(i, v), 0.05) : null,
        info,
        el("div", { className: "note", textContent: "Normals are kept per-corner so UV seams survive. 'auto' smooths edges below the angle." })
      ];
      propsEl.appendChild(section("mesh", "Mesh editing", meshKids));
    } else {
      propsEl.appendChild(el("div", { className: "note", style: "padding:6px 4px 10px", textContent: "No part selected. Click a part in the viewport or the outliner." }));
    }

    const partColor = el("input", { type: "color", value: S.partColor });
    partColor.oninput = () => { S.partColor = partColor.value; };
    const parts = [["cube", "Cube"], ["sphere", "Sphere"], ["cylinder", "Cylinder"], ["cone", "Cone"], ["plane", "Plane"], ["torus", "Torus"],
      ["wing", "GT Wing"], ["spoiler", "Spoiler"], ["splitter", "Splitter"], ["bumper", "Bumper"], ["exhaust", "Exhaust"], ["light", "Headlight"]];
    propsEl.appendChild(section("add", "Add parts", [
      el("div", { className: "wrapb" }, parts.map(([t, l]) => btn("+ " + l, () => Studio.addPart(t, l), "sm"))),
      el("div", { className: "rowf" }, [el("label", { textContent: "New colour" }), partColor]),
      el("div", { className: "note", textContent: "New parts spawn at the orbit centre, are attached to the car on sync, and are fully editable." })]));

    const file = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    file.onchange = () => { if (file.files[0]) Project.importFile(file.files[0]); file.value = ""; };
    propsEl.appendChild(section("project", "Project / export", [
      el("div", { className: "wrapb" }, [btn("Export JSON", () => Project.exportJSON(), "sm pri", "Re-importable"), btn("Export OBJ", () => Project.exportOBJ(), "sm"), btn("Import JSON", () => file.click(), "sm"), file]),
      el("div", { className: "wrapb" }, [btn("Save in browser", () => Project.saveLocal(), "sm"), btn("Load saved", () => Project.loadSaved(false), "sm"), btn("Revert all", () => { if (confirm("Revert every part to the original car?")) Studio.revertAll(); }, "sm dan")]),
      el("div", { className: "rowf" }, [el("label", { textContent: "Auto-apply" }), mkSwitch(S.autoApply, (v) => { S.autoApply = v; })]),
      el("div", { className: "note", textContent: "JSON stores only parts you changed (geometry, transforms, materials, per-face paint) and re-applies by part name." })]));

    const chk = (label, key, fn) => el("div", { className: "rowf" }, [el("label", { style: "width:110px", textContent: label }), mkSwitch(S[key], (v) => { S[key] = v; if (fn) fn(); })]);
    const neon = el("input", { type: "color", value: S.neonColor });
    neon.oninput = () => { S.neonColor = neon.value; Studio.updateNeonViz(); Studio.scheduleSync(); };
    propsEl.appendChild(section("view", "View & sync", [
      chk("X-ray (see-through)", "xray", () => Studio.objs.forEach((x) => x.rebuildOverlay())),
      chk("Wireframe all", "wire", () => Studio.objs.forEach((x) => x.rebuildOverlay())),
      chk("Grid & axes", "grid"),
      chk("Live sync to car", "liveSync", () => Studio.scheduleSync()),
      chk("Neon underglow", "neonActive", () => { Studio.updateNeonViz(); Studio.scheduleSync(); }),
      el("div", { className: "rowf" }, [el("label", { textContent: "Neon colour" }), neon])]));
    UI.refreshInfo();
  };

  // =========================================================================
  // 13. UI facade used by the editor core
  // =========================================================================
  const defaultHint = () => {
    if (S.tool === "paint") return "Paint: click / drag to colour · Esc = select tool";
    if (S.tool !== "select") return S.tool[0].toUpperCase() + S.tool.slice(1) + " tool: drag to transform the selection · X/Y/Z lock axis · Ctrl snaps";
    if (S.selMode === "object") return "Click = select · drag = orbit · RMB/MMB = orbit · Shift+RMB/MMB = pan · wheel = zoom · G/R/S transform · Shift+D duplicate";
    return "Click = select · Shift = add · drag = box select · G/R/S · E extrude · F face · Del delete · Tab = object mode";
  };
  const UI = {
    refresh() {
      Object.keys(modeBtns).forEach((m) => modeBtns[m].classList.toggle("on", S.selMode === m));
      Object.keys(toolBtns).forEach((t) => toolBtns[t].classList.toggle("on", S.tool === t));
      undoBtn.disabled = History.index < 0; redoBtn.disabled = History.index >= History.stack.length - 1;
      this.refreshAxis();
      if (!Studio.xf) hintEl.textContent = defaultHint();
      renderOutliner();
      renderProps();
      renderDiag();
    },
    refreshAxis() {
      ["x", "y", "z"].forEach((a) => axBtns[a].classList.toggle("on", S.axis === a));
      axBtns.snap.classList.toggle("on", S.snap);
    },
    refreshInfo() {
      const o = Studio.active;
      if (!o) { infoEl.textContent = Studio.objs.length + " parts"; return; }
      const sel = o.sel;
      const txt = o.poly.nv + " verts · " + o.poly.nt + " tris" + (S.selMode !== "object" ? " · sel " + o.selCount() : "");
      infoEl.innerHTML = "";
      infoEl.appendChild(el("div", {}, [o.name]));
      infoEl.appendChild(el("div", { style: "color:#94a3b8" }, [txt]));
      const mi = propsEl.querySelector("#meshinfo");
      if (mi) mi.textContent = txt + (S.selMode === "v" ? " · " + sel.v.size + " verts selected" : S.selMode === "e" ? " · " + sel.e.size + " edges selected" : S.selMode === "f" ? " · " + sel.f.size + " faces selected" : "");
    },
    hint(t) { hintEl.textContent = t || defaultHint(); },
    drawBox(b) {
      if (!b) { boxEl.style.display = "none"; return; }
      const r = view.getBoundingClientRect();
      boxEl.style.display = "block";
      boxEl.style.left = Math.min(b.x0, b.x1) - r.left + "px"; boxEl.style.top = Math.min(b.y0, b.y1) - r.top + "px";
      boxEl.style.width = Math.abs(b.x1 - b.x0) + "px"; boxEl.style.height = Math.abs(b.y1 - b.y0) + "px";
    },
    exitStudio
  };

  launchBtn.onclick = openStudio;

  // =========================================================================
  // 14. MOUNT + WINDOW BEHAVIOUR
  // =========================================================================
  root.appendChild(el("style", { textContent: css }));
  root.appendChild(mkSvg());
  root.appendChild(panel);
  mroot.appendChild(el("style", { textContent: css }));
  mroot.appendChild(cad);
  document.body.appendChild(mkSvg());
  document.body.appendChild(host);
  document.body.appendChild(mhost);

  Studio.init(view);
  setTab(0);

  let lastW = 0, lastH = 0;
  const updateMap = () => {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w; lastH = h;
    let url; try { url = makeMap(w, h, 34, 28); } catch (e) { return; }
    svgs.forEach((s) => {
      const f = s.querySelector("filter"), im = s.querySelector("feImage");
      f.setAttribute("width", w); f.setAttribute("height", h); im.setAttribute("width", w); im.setAttribute("height", h);
      im.setAttribute("href", url); im.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    });
  };
  setTimeout(updateMap, 100);
  panel.addEventListener("pointermove", (e) => {
    const r = panel.getBoundingClientRect();
    panel.style.setProperty("--mx", e.clientX - r.left + "px"); panel.style.setProperty("--my", e.clientY - r.top + "px");
  });

  // rubber-band drag for the floating menu
  const rubber = (o) => (o === 0 ? 0 : Math.sign(o) * 36 * (1 - Math.exp(-Math.abs(o) / 80)));
  const ZONE = 70;
  let dx = 0, dy = 0, drag = false;
  head.addEventListener("pointerdown", (e) => {
    if (e.target === minBtn || e.target === closeBtn) return;
    drag = true;
    const r = host.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    panel.style.transform = "scale(1.02)";
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = host.offsetWidth, h = host.offsetHeight, maxL = Math.max(0, innerWidth - w), maxT = Math.max(0, innerHeight - h);
    const l = e.clientX - dx, t = e.clientY - dy;
    const ol = l < 0 ? l : l > maxL ? l - maxL : 0, ot = t < 0 ? t : t > maxT ? t - maxT : 0;
    const vl = Math.min(Math.max(l, 0), maxL) + rubber(ol), vt = Math.min(Math.max(t, 0), maxT) + rubber(ot);
    host.style.left = vl + "px"; host.style.top = vt + "px";
    const press = (d) => Math.min(1.6, Math.max(0, (ZONE - d) / ZONE));
    const px = Math.max(press(vl), press(innerWidth - (vl + w))), py = Math.max(press(vt), press(innerHeight - (vt + h)));
    const sx = (1 - 0.14 * px) * (1 + 0.05 * py), sy = (1 - 0.14 * py) * (1 + 0.05 * px);
    const tilt = Math.min(Math.max(-(e.movementX || 0) * 0.6, -8), 8);
    panel.style.transform = "scale(" + 1.02 * sx + "," + 1.02 * sy + ") skewX(" + tilt + "deg)";
  });
  const endDrag = () => { if (!drag) return; drag = false; panel.style.transform = ""; };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  minBtn.onclick = () => { body.classList.toggle("hide"); minBtn.textContent = body.classList.contains("hide") ? "+" : "–"; setTimeout(updateMap, 60); };
  closeBtn.onclick = () => { host.style.display = "none"; };

  // Menu toggle (\ or `) — the studio's own shortcuts live in Studio.onKey
  window.addEventListener("keydown", (e) => {
    if (Studio.open) return;
    const t = e.composedPath ? e.composedPath()[0] : e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (e.code === "Backslash" || e.code === "Backquote") { e.preventDefault(); host.style.display = host.style.display === "none" ? "block" : "none"; }
  });

  setInterval(() => {
    try {
      const copy = Object.assign({}, S);
      delete copy.tab; delete copy.tool; delete copy.selMode; delete copy.axis;
      localStorage.setItem(KEY, JSON.stringify(copy));
    } catch (e) { /* storage unavailable */ }
  }, 2000);
  setInterval(() => { if (!Studio.open && S.tab === 0) renderDiag(); }, 2500);

  console.log("%c[FastRoads Studio v9.1 ready]%c Press '\\' or '`' for the menu.", "color:#00f0ff;font-weight:bold;", "color:inherit;");
})();