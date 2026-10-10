(function () {
  "use strict";

  // If already mounted, toggle visibility instead of duplicating
  if (window.__fastRoadsHost) {
    window.__fastRoadsHost.style.display = window.__fastRoadsHost.style.display === "none" ? "block" : "none";
    return;
  }

  // =========================================================================
  // 1. ENGINE & CAR SCANNER (BACKGROUND BINDER)
  // =========================================================================
  const Engine = {
    car: window.car || window.z || null,
    scene: window.qr || window.gameScene || null,
    three: window.THREE || null,

    scan() {
      // 1. Find THREE
      if (!this.three && window.THREE) this.three = window.THREE;
      if (!this.three && window.webpackJsonpapp && Array.isArray(window.webpackJsonpapp)) {
        try {
          let req = null;
          window.webpackJsonpapp.push([[999991], { 999991: function (m, e, r) { req = r; } }, [[999991]]]);
          if (req && req(1)) {
            this.three = req(1);
            window.THREE = req(1);
          }
        } catch (e) {}
      }

      // 2. Find Scene from React Fiber or canvas
      if (!this.scene) {
        const canvas = document.querySelector("canvas");
        if (canvas) {
          const k = Object.keys(canvas).find(x => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
          if (k) {
            let fiber = canvas[k];
            while (fiber) {
              let hook = fiber.memoizedState;
              while (hook) {
                const val = hook.memoizedState?.current || hook.memoizedState;
                if (val && val.scene && val.renderer) {
                  this.scene = val.scene;
                  window.qr = val.scene;
                  if (!this.three && val.scene.constructor) this.three = window.THREE;
                  break;
                }
                hook = hook.next;
              }
              if (this.scene) break;
              fiber = fiber.return;
            }
          }
        }
      }

      // 3. Find Player Car
      if (window.car) {
        this.car = window.car;
      } else if (this.scene) {
        this.scene.traverse((obj) => {
          if (!this.car && obj && obj.metrics && obj.wheels && obj.geo) {
            this.car = obj;
            window.car = obj;
          }
        });
      }
      return this.car;
    }
  };
  Engine.scan();

  // Load Three.js fallback if not present so Viewport is 100% guaranteed to work
  if (!Engine.three && !window.THREE) {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    s.onload = () => { Engine.three = window.THREE; };
    document.head.appendChild(s);
  }

  // =========================================================================
  // 2. SAVED SETTINGS & STATE
  // =========================================================================
  const KEY = "fastroads_liquid_v6";
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const saved = loadSaved();

  const S = (window.__FR_S = {
    tab: 0,
    bodyColor: "#00f0ff",
    wheelColor: "#ffffff",
    neonActive: true,
    neonColor: "#ff007f",
    wheelRadius: 0.34,
    wheelWidth: 0.1,
    trackWidth: 1.36,
    wheelbase: 2.75,
    suspensionTravel: 0.07,
    enginePower: 1.0,
    gravityY: -9.81,
    infiniteBoost: false,
    noClip: false,
    infiniteGrip: false,
    vertexEditMode: false
  });
  Object.assign(S, saved);

  // =========================================================================
  // 3. COMMAND HISTORY (UNDO / REDO)
  // =========================================================================
  const History = {
    stack: [], index: -1, max: 40,
    execute(name, undoFn, redoFn) {
      redoFn();
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push({ name, undo: undoFn, redo: redoFn });
      if (this.stack.length > this.max) this.stack.shift();
      else this.index++;
    },
    undo() {
      if (this.index >= 0) {
        this.stack[this.index].undo();
        this.index--;
        status.textContent = "Undo: " + (this.stack[this.index + 1]?.name || "");
      }
    },
    redo() {
      if (this.index < this.stack.length - 1) {
        this.index++;
        this.stack[this.index].redo();
        status.textContent = "Redo: " + this.stack[this.index].name;
      }
    }
  };

  // =========================================================================
  // 4. CORE ENGINE INTERCEPTOR
  // =========================================================================
  const Rewire = {
    install() {
      const origRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = function (cb) {
        return origRAF.call(window, function (t) {
          Rewire.watchdog();
          return cb(t);
        });
      };
    },

    watchdog() {
      const c = Engine.scan();
      if (!c) return;

      if (c.metrics) {
        c.metrics.topSpeed = 45 * S.enginePower;
        c.metrics.accel = 9 * S.enginePower;
      }
      if (S.infiniteGrip) {
        c.slip = 0;
        if (c.metrics) { c.metrics.slipBase = 0; c.metrics.slipMod = 0; }
      }
      if (S.infiniteBoost && (window.keys && (window.keys.KeyW || window.keys.ArrowUp))) {
        if (c.vel && typeof c.vel.multiplyScalar === "function") {
          c.vel.multiplyScalar(1.025);
        }
      }
      if (window.So) {
        if (typeof window.So.set === "function") window.So.set(S.gravityY);
        else window.So.value = S.gravityY;
      }
      if (S.noClip) {
        c.didCollide = false;
        c.wrongWay = false;
      }
    }
  };
  Rewire.install();

  // =========================================================================
  // 5. 3D GARAGE & CAD STUDIO
  // =========================================================================
  const Studio = {
    canvas: null, renderer: null, scene: null, camera: null,
    clonedCar: null, clonedBody: null, clonedWheels: [],
    neonGroup: null, neonLight: null, vertexHelpers: null,
    selectedNode: null, customParts: [],
    isDragging: false, dragBtn: 0,
    prev: { x: 0, y: 0 },
    sp: { radius: 5.5, theta: 0.75, phi: 1.1 },
    target: null,
    raycaster: null,
    mouseVec: null,

    init(containerEl) {
      const THREE = Engine.three || window.THREE;
      if (!THREE) {
        setTimeout(() => this.init(containerEl), 300);
        return;
      }

      this.target = new THREE.Vector3(0, 0.4, 0);
      this.raycaster = new THREE.Raycaster();
      this.mouseVec = new THREE.Vector2();

      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = "width: 100%; height: 100%; display: block; border-radius: 18px; cursor: grab;";
      containerEl.appendChild(this.canvas);

      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setSize(containerEl.clientWidth, containerEl.clientHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, containerEl.clientWidth / containerEl.clientHeight, 0.1, 100);
      this.updateCamera();

      const amb = new THREE.AmbientLight(0xffffff, 0.85);
      const dir1 = new THREE.DirectionalLight(0xffffff, 1.2);
      dir1.position.set(6, 12, 8);
      const dir2 = new THREE.DirectionalLight(0x00e5ff, 0.4);
      dir2.position.set(-6, -4, -6);
      this.scene.add(amb, dir1, dir2);

      const grid = new THREE.GridHelper(16, 32, 0x00e5ff, 0x1f2b3e);
      grid.position.y = -0.01;
      this.scene.add(grid);

      this.vertexHelpers = new THREE.Group();
      this.scene.add(this.vertexHelpers);

      this.bindControls();

      const loop = () => {
        requestAnimationFrame(loop);
        if (S.tab === 0 && !body.classList.contains("hide") && this.renderer) {
          this.renderer.render(this.scene, this.camera);
        }
      };
      loop();

      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          if (containerEl.clientWidth > 0 && containerEl.clientHeight > 0) {
            this.camera.aspect = containerEl.clientWidth / containerEl.clientHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(containerEl.clientWidth, containerEl.clientHeight);
          }
        }).observe(containerEl);
      }

      this.rebuildClone();
    },

    updateCamera() {
      const x = this.sp.radius * Math.sin(this.sp.phi) * Math.sin(this.sp.theta);
      const y = this.sp.radius * Math.cos(this.sp.phi);
      const z = this.sp.radius * Math.sin(this.sp.phi) * Math.cos(this.sp.theta);
      this.camera.position.set(x + this.target.x, y + this.target.y, z + this.target.z);
      this.camera.lookAt(this.target);
    },

    setPreset(view) {
      if (view === "persp") { this.sp.theta = 0.75; this.sp.phi = 1.1; this.sp.radius = 5.5; }
      else if (view === "front") { this.sp.theta = Math.PI; this.sp.phi = Math.PI / 2; }
      else if (view === "side") { this.sp.theta = Math.PI / 2; this.sp.phi = Math.PI / 2; }
      else if (view === "top") { this.sp.theta = 0; this.sp.phi = 0.05; }
      else if (view === "under") { this.sp.theta = 0; this.sp.phi = Math.PI - 0.15; }
      this.updateCamera();
    },

    bindControls() {
      const cv = this.canvas;
      cv.addEventListener("pointerdown", (e) => {
        this.isDragging = true;
        this.dragBtn = e.button;
        this.prev.x = e.clientX; this.prev.y = e.clientY;
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = "grabbing";

        if (e.button === 0 && !e.shiftKey) {
          const rect = cv.getBoundingClientRect();
          this.mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          this.mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          this.raycaster.setFromCamera(this.mouseVec, this.camera);
          if (this.clonedCar) {
            const hits = this.raycaster.intersectObjects(this.clonedCar.children, true);
            if (hits.length > 0) this.select(hits[0].object);
          }
        }
      });

      cv.addEventListener("pointermove", (e) => {
        if (!this.isDragging) return;
        const dx = e.clientX - this.prev.x, dy = e.clientY - this.prev.y;
        this.prev.x = e.clientX; this.prev.y = e.clientY;

        if (this.dragBtn === 0 && !e.shiftKey) {
          this.sp.theta -= dx * 0.012;
          this.sp.phi = Math.max(0.04, Math.min(Math.PI - 0.04, this.sp.phi - dy * 0.012));
        } else {
          const THREE = Engine.three || window.THREE;
          const right = new THREE.Vector3().crossVectors(this.camera.up, this.camera.position).normalize();
          this.target.addScaledVector(right, -dx * 0.005);
          this.target.y += dy * 0.005;
        }
        this.updateCamera();
      });

      const stop = () => { this.isDragging = false; cv.style.cursor = "grab"; };
      cv.addEventListener("pointerup", stop);
      cv.addEventListener("pointercancel", stop);

      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.sp.radius = Math.max(1.5, Math.min(22.0, this.sp.radius + e.deltaY * 0.005));
        this.updateCamera();
      }, { passive: false });
    },

    select(node) {
      this.selectedNode = node;
      this.buildVertexHelpers();
      status.textContent = "Selected: " + (node.name || "Mesh");
    },

    rebuildClone() {
      const THREE = Engine.three || window.THREE;
      if (!this.scene || !THREE) return;
      if (this.clonedCar) this.scene.remove(this.clonedCar);

      this.clonedCar = new THREE.Group();
      this.scene.add(this.clonedCar);
      this.clonedWheels = [];

      Engine.scan();
      const c = Engine.car;
      if (c && c.geo && c.geo.children.length > 0) {
        c.geo.children.forEach((child) => {
          if (child.name === "fl" || (child.children && child.children.some(x => x.name === "fl"))) {
            // Wheels handled distinctly
          } else {
            const clone = child.clone(true);
            clone.traverse((m) => {
              if (m.isMesh && m.material) {
                m.material = m.material.clone();
                if (m.material.color) m.material.color.set(S.bodyColor);
              }
            });
            this.clonedBody = clone;
            this.clonedCar.add(clone);
          }
        });
        this.buildWheels();
      } else {
        this.buildProceduralRig();
      }

      this.buildUnderglow();
      this.customParts.forEach((p) => this.clonedCar.add(p));
      this.select(this.clonedBody || this.clonedCar);
    },

    buildProceduralRig() {
      const THREE = Engine.three || window.THREE;
      const mat = new THREE.MeshStandardMaterial({ color: S.bodyColor, roughness: 0.2 });
      const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 3.2), mat);
      bodyMesh.name = "Chassis_Body";
      bodyMesh.position.y = 0.35;
      this.clonedCar.add(bodyMesh);
      this.clonedBody = bodyMesh;

      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.4, 1.6), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 }));
      cabin.name = "Cabin_Roof";
      cabin.position.set(0, 0.75, -0.2);
      this.clonedCar.add(cabin);

      this.buildWheels();
    },

    buildWheels() {
      const THREE = Engine.three || window.THREE;
      const mat = new THREE.MeshStandardMaterial({ color: S.wheelColor, metalness: 0.9, roughness: 0.15 });
      const r = S.wheelRadius, w = S.wheelWidth;
      const geo = new THREE.CylinderGeometry(r, r, w * 2, 24);
      geo.rotateZ(Math.PI / 2);

      const pos = [
        { name: "Wheel_FL", x: S.trackWidth / 2, y: r, z: S.wheelbase / 2 },
        { name: "Wheel_FR", x: -S.trackWidth / 2, y: r, z: S.wheelbase / 2 },
        { name: "Wheel_RL", x: S.trackWidth / 2, y: r, z: -S.wheelbase / 2 },
        { name: "Wheel_RR", x: -S.trackWidth / 2, y: r, z: -S.wheelbase / 2 }
      ];

      pos.forEach((p) => {
        const m = new THREE.Mesh(geo.clone(), mat.clone());
        m.name = p.name;
        m.position.set(p.x, p.y, p.z);
        this.clonedCar.add(m);
        this.clonedWheels.push(m);
      });
    },

    buildUnderglow() {
      const THREE = Engine.three || window.THREE;
      if (this.neonGroup && this.clonedCar) this.clonedCar.remove(this.neonGroup);
      this.neonGroup = new THREE.Group();
      this.neonGroup.name = "Underglow_Neon";

      const neonMat = new THREE.MeshBasicMaterial({ color: S.neonColor });
      const geo = new THREE.CylinderGeometry(0.02, 0.02, 2.2);
      geo.rotateX(Math.PI / 2);

      const left = new THREE.Mesh(geo, neonMat); left.position.set(-0.7, 0.08, 0);
      const right = new THREE.Mesh(geo, neonMat); right.position.set(0.7, 0.08, 0);
      this.neonLight = new THREE.PointLight(S.neonColor, 2.0, 3.5);
      this.neonLight.position.set(0, 0.05, 0);

      this.neonGroup.add(left, right, this.neonLight);
      this.neonGroup.visible = S.neonActive;
      if (this.clonedCar) this.clonedCar.add(this.neonGroup);
    },

    buildVertexHelpers() {
      const THREE = Engine.three || window.THREE;
      while (this.vertexHelpers.children.length > 0) this.vertexHelpers.remove(this.vertexHelpers.children[0]);
      if (!S.vertexEditMode || !this.selectedNode || !this.selectedNode.geometry) return;

      const pos = this.selectedNode.geometry.attributes?.position;
      if (!pos) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
      const geo = new THREE.BoxGeometry(0.035, 0.035, 0.035);

      for (let i = 0; i < Math.min(pos.count, 350); i++) {
        const h = new THREE.Mesh(geo, mat);
        h.position.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        h.position.applyMatrix4(this.selectedNode.matrixWorld);
        this.vertexHelpers.add(h);
      }
    },

    displace(axis, amount, region = "all") {
      const node = this.selectedNode;
      if (!node || !node.geometry || !node.geometry.attributes.position) return;
      const pos = node.geometry.attributes.position;

      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        let pass = true;
        if (region === "front" && z < 0) pass = false;
        if (region === "rear" && z > 0) pass = false;
        if (region === "top" && y < 0.2) pass = false;

        if (pass) {
          if (axis === "x") pos.setX(i, x + amount);
          if (axis === "y") pos.setY(i, y + amount);
          if (axis === "z") pos.setZ(i, z + amount);
        }
      }
      pos.needsUpdate = true;
      node.geometry.computeVertexNormals();
      node.geometry.computeBoundingBox();
      this.buildVertexHelpers();
      this.pushToGame();
    },

    addPrimitive(type) {
      const THREE = Engine.three || window.THREE;
      let geo, name;
      if (type === "box") {
        geo = new THREE.BoxGeometry(0.8, 0.1, 0.35);
        name = "Part_SpoilerWing_" + (this.customParts.length + 1);
      } else if (type === "cylinder") {
        geo = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 16);
        name = "Part_Exhaust_" + (this.customParts.length + 1);
      } else {
        geo = new THREE.SphereGeometry(0.18, 16, 16);
        name = "Part_Sphere_" + (this.customParts.length + 1);
      }

      const mat = new THREE.MeshStandardMaterial({ color: S.bodyColor, roughness: 0.2 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.position.set(0, 0.85, -1.2);

      History.execute("Add " + name, () => {
        this.clonedCar.remove(mesh);
        const i = this.customParts.indexOf(mesh);
        if (i >= 0) this.customParts.splice(i, 1);
        this.select(this.clonedBody);
      }, () => {
        this.clonedCar.add(mesh);
        this.customParts.push(mesh);
        this.select(mesh);
      });
      this.pushToGame();
    },

    pushToGame() {
      const THREE = Engine.three || window.THREE;
      const c = Engine.scan();
      if (!c || !c.geo) return;
      const g = c.geo;

      g.traverse((node) => {
        if (node.isMesh && node.material) {
          const n = (node.name || "").toLowerCase();
          if (n.includes("body") || n.includes("map") || node === c) {
            if (node.material.color) node.material.color.set(S.bodyColor);
          }
          if (n.includes("wheel") && node.material.color) {
            node.material.color.set(S.wheelColor);
          }
        }
      });

      let holder = g.getObjectByName("__mod_parts_holder__");
      if (!holder) {
        holder = new THREE.Group();
        holder.name = "__mod_parts_holder__";
        g.add(holder);
      }
      while (holder.children.length > 0) holder.remove(holder.children[0]);
      this.customParts.forEach((p) => holder.add(p.clone(true)));

      let neon = g.getObjectByName("__mod_neon_light__");
      if (S.neonActive) {
        if (!neon) {
          neon = new THREE.PointLight(S.neonColor, 2.5, 4.0);
          neon.name = "__mod_neon_light__";
          neon.position.set(0, 0.1, 0);
          g.add(neon);
        }
        neon.color.set(S.neonColor);
      } else if (neon) {
        g.remove(neon);
      }

      if (c.wheels) {
        c.wheels.radius = S.wheelRadius;
        c.wheels.width = S.trackWidth;
        c.wheels.length = S.wheelbase;
        c.wheels.travel = S.suspensionTravel;
      }
    }
  };

  // =========================================================================
  // 6. UI CONSTRUCTION (EXACT LIQUID GLASS TEMPLATE FROM TINY FISHING)
  // =========================================================================
  const host = document.createElement("div");
  host.id = "fastroads-mod-liquid-host";
  host.style.cssText = "position:fixed;top:50px;left:20px;z-index:2147483647;";
  window.__fastRoadsHost = host;

  [
    "mousedown","mouseup","mousemove","click","dblclick","touchstart","touchmove","touchend","touchcancel",
    "pointerdown","pointermove","pointerup","pointercancel","wheel","contextmenu","keydown","keyup","keypress","input","change"
  ].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));

  const root = host.attachShadow({ mode: "open" });
  const spring = "cubic-bezier(.34,1.56,.64,1)";
  const MONO = "ui-monospace,Menlo,Consolas,monospace";

  const css = [
    ".p{position:relative;width:440px;color:#000;font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;border-radius:34px;",
    "background:linear-gradient(135deg,rgba(255,255,255,.24),rgba(255,255,255,.08));",
    "-webkit-backdrop-filter:blur(14px) saturate(190%) brightness(1.08);",
    "backdrop-filter:blur(14px) saturate(190%) brightness(1.08);",
    "backdrop-filter:url(#lgfilter) blur(6px) saturate(190%) brightness(1.08);",
    "box-shadow:0 18px 50px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.18),inset 0 1px 1px rgba(255,255,255,.6);",
    "transition:transform .6s " + spring + ",width .5s " + spring + ";user-select:none;overflow:hidden;will-change:transform}",
    ".p.wide{width:680px}",
    ".p::before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1.5px;pointer-events:none;z-index:3;",
    "background:linear-gradient(140deg,rgba(255,255,255,.95),rgba(255,255,255,.08) 28%,rgba(255,255,255,.04) 62%,rgba(255,255,255,.7));",
    "-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}",
    ".p::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:0;",
    "background:radial-gradient(230px circle at var(--mx,30%) var(--my,0%),rgba(255,255,255,.26),rgba(255,255,255,0) 62%)}",
    ".h,.b{position:relative;z-index:1}",
    ".h{padding:15px 18px 9px;display:flex;justify-content:space-between;align-items:center;cursor:grab;touch-action:none;font-weight:700;font-size:15px;letter-spacing:.2px;text-shadow:0 1px 6px rgba(0,0,0,.1)}",
    ".dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#34c759;margin-left:8px;opacity:0;transition:opacity .6s;vertical-align:middle;box-shadow:0 0 8px #34c759}",
    ".dot.on{opacity:1;transition:none}",
    ".min{width:28px;height:28px;border-radius:50%;border:1px solid rgba(255,255,255,.4);background:linear-gradient(160deg,rgba(255,255,255,.35),rgba(255,255,255,.1));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font-size:15px;line-height:24px;text-align:center;cursor:pointer;padding:0;transition:transform .4s " + spring + "}",
    ".b{padding:2px 14px 16px;display:flex;flex-direction:column;gap:10px}",
    ".b.hide{display:none !important}",
    ".tabs{position:relative;display:flex;padding:3px;border-radius:18px;background:rgba(0,0,0,.22);box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2)}",
    ".tab{flex:1;text-align:center;padding:8px 0;font-weight:600;font-size:12px;cursor:pointer;position:relative;z-index:1;opacity:.7;transition:opacity .25s,transform .4s " + spring + "}",
    ".tab.on{opacity:1}",
    ".ind{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / 3);border-radius:15px;background:linear-gradient(160deg,rgba(255,255,255,.42),rgba(255,255,255,.14));box-shadow:inset 0 1px 1px rgba(255,255,255,.7),0 2px 8px rgba(0,0,0,.2);transition:transform .55s " + spring + "}",
    ".tabs.t1 .ind{transform:translateX(100%)}",
    ".tabs.t2 .ind{transform:translateX(200%)}",
    ".pg{display:flex;flex-direction:column;gap:10px;animation:pgin .45s " + spring + "}",
    ".pg.hide{display:none}",
    "@keyframes pgin{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}",
    ".card{background:linear-gradient(160deg,rgba(255,255,255,.2),rgba(255,255,255,.06));border-radius:24px;padding:11px 13px;box-shadow:inset 0 1px 1px rgba(255,255,255,.5),inset 0 0 0 1px rgba(255,255,255,.12),0 4px 14px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:8px;}",
    ".row{display:flex;align-items:center;justify-content:space-between;gap:10px}",
    ".lbl{font-weight:600}",
    ".lbl small{display:block;opacity:.7;font-size:11px;font-weight:400;margin-top:1px}",
    ".step{display:flex;align-items:center;gap:2px;background:rgba(0,0,0,.22);border-radius:16px;padding:3px;box-shadow:inset 0 1px 3px rgba(0,0,0,.25),0 1px 0 rgba(255,255,255,.2)}",
    ".step button{width:28px;height:28px;border:0;border-radius:13px;background:linear-gradient(160deg,rgba(255,255,255,.34),rgba(255,255,255,.12));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font-size:17px;line-height:26px;cursor:pointer;padding:0;transition:transform .4s " + spring + "}",
    ".step input{width:44px;text-align:center;background:transparent;border:0;color:#000;font:700 13px -apple-system,system-ui,sans-serif;outline:none;padding:0}",
    ".sw{width:50px;height:30px;border-radius:15px;background:rgba(255,255,255,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.25);position:relative;cursor:pointer;transition:background .3s;flex:none}",
    ".sw i{position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:transform .45s " + spring + "}",
    ".sw.on{background:rgba(52,199,89,.9)}",
    ".sw.on i{transform:translateX(20px)}",
    ".viewport-frame{position:relative;width:100%;height:220px;border-radius:18px;background:radial-gradient(circle at center,#1e293b 0%,#090d16 100%);overflow:hidden;box-shadow:inset 0 0 10px rgba(0,0,0,.8);}",
    ".vp-btns{position:absolute;bottom:8px;left:8px;display:flex;gap:4px;z-index:2;}",
    ".vp-btn{background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.3);color:#fff;font-size:10px;padding:3px 7px;border-radius:6px;cursor:pointer;}",
    ".rbtn{border:0;border-radius:14px;padding:5px 11px;background:linear-gradient(160deg,rgba(255,255,255,.34),rgba(255,255,255,.12));box-shadow:inset 0 1px 1px rgba(255,255,255,.6);color:#000;font:600 11.5px -apple-system,system-ui,sans-serif;cursor:pointer;}",
    ".btn-grp{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;}",
    ".srch input{width:100%;height:32px;background:rgba(0,0,0,.22);border:0;border-radius:16px;padding:0 13px;color:#000;font:12.5px -apple-system,system-ui,sans-serif;outline:none;box-sizing:border-box;}",
    ".tbl{position:relative;height:240px;overflow-y:auto;border-radius:18px;background:rgba(0,0,0,.2);box-shadow:inset 0 1px 3px rgba(0,0,0,.28);}",
    ".tr{height:30px;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.07);}",
    ".nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px " + MONO + ";}",
    ".tr input{width:110px;background:rgba(255,255,255,.15);border:0;border-radius:8px;padding:4px 6px;color:#000;font:600 11px " + MONO + ";text-align:right;outline:none;}",
    "input[type='color']{-webkit-appearance:none;border:none;width:32px;height:24px;border-radius:8px;cursor:pointer;background:transparent;}",
    "input[type='color']::-webkit-color-swatch{border-radius:8px;border:1px solid rgba(0,0,0,.2);}",
    ".status{font:11px " + MONO + ";opacity:.85;min-height:13px;padding:0 6px}"
  ].join("");

  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    (kids || []).forEach((k) => n.appendChild(typeof k === "string" ? document.createTextNode(k) : k));
    return n;
  };

  const svgs = [];
  const mkSvg = () => {
    const d = document.createElement("div");
    d.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;pointer-events:none">' +
      '<defs><filter id="lgfilter" filterUnits="userSpaceOnUse" x="0" y="0" width="680" height="700" color-interpolation-filters="sRGB">' +
      '<feImage x="0" y="0" width="680" height="700" preserveAspectRatio="none" result="map"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" scale="36" xChannelSelector="R" yChannelSelector="G"/>' +
      '</filter></defs></svg>';
    const s = d.firstChild; svgs.push(s); return s;
  };

  const makeMap = (w, h, r, bezel) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"), img = ctx.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - w / 2, py = y + 0.5 - h / 2;
        const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r);
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const inside = Math.min(Math.max(qx, qy), 0);
        const dist = -(outside + inside - r);
        let dx = 0, dy = 0;
        if (dist >= 0 && dist < bezel) {
          const t = 1 - dist / bezel, mag = t * t;
          let nx, ny;
          if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy); nx = Math.sign(px) * qx / l; ny = Math.sign(py) * qy / l; }
          else if (qx > qy) { nx = Math.sign(px); ny = 0; }
          else { nx = 0; ny = Math.sign(py); }
          dx = -nx * mag; dy = -ny * mag;
        }
        const i = (y * w + x) * 4;
        d[i] = 128 + dx * 127; d[i + 1] = 128 + dy * 127; d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  };

  const minBtn = el("button", { className: "min", textContent: "–" });
  const dot = el("span", { className: "dot on" });
  const head = el("div", { className: "h" }, [
    el("span", {}, ["Fast Roads Studio", dot]),
    minBtn
  ]);
  const status = el("div", { className: "status", textContent: "Studio Initialized" });

  const stepper = (init, min, max, onSet) => {
    const input = el("input", { type: "number", min, max, step: "any", value: init });
    const minus = el("button", { textContent: "−" });
    const plus = el("button", { textContent: "+" });
    const wrap = el("div", { className: "step" }, [minus, input, plus]);
    const set = (v) => {
      v = parseFloat(v);
      if (isNaN(v)) v = min;
      input.value = v;
      onSet(v);
    };
    input.onchange = () => set(input.value);
    minus.onclick = () => set(parseFloat(input.value) - 0.05);
    plus.onclick = () => set(parseFloat(input.value) + 0.05);
    return { wrap, input, set };
  };

  const mkSwitch = (val, onToggle) => {
    const sw = el("div", { className: "sw" + (val ? " on" : "") }, [el("i")]);
    sw.onclick = () => {
      const v = !sw.classList.contains("on");
      sw.classList.toggle("on", v);
      onToggle(v);
    };
    return sw;
  };

  // TAB 0: GARAGE
  const viewportFrame = el("div", { className: "viewport-frame" });
  const vpBtns = el("div", { className: "vp-btns" }, [
    el("button", { className: "vp-btn", textContent: "Persp", onclick: () => Studio.setPreset("persp") }),
    el("button", { className: "vp-btn", textContent: "Front", onclick: () => Studio.setPreset("front") }),
    el("button", { className: "vp-btn", textContent: "Side", onclick: () => Studio.setPreset("side") }),
    el("button", { className: "vp-btn", textContent: "Top", onclick: () => Studio.setPreset("top") }),
    el("button", { className: "vp-btn", textContent: "Under", onclick: () => Studio.setPreset("under") })
  ]);
  viewportFrame.appendChild(vpBtns);

  const bodyColInput = el("input", { type: "color", value: S.bodyColor });
  bodyColInput.oninput = (e) => {
    S.bodyColor = e.target.value;
    Studio.rebuildClone();
    Studio.pushToGame();
  };

  const neonColInput = el("input", { type: "color", value: S.neonColor });
  neonColInput.oninput = (e) => {
    S.neonColor = e.target.value;
    Studio.buildUnderglow();
    Studio.pushToGame();
  };

  const neonToggle = mkSwitch(S.neonActive, (v) => {
    S.neonActive = v;
    Studio.buildUnderglow();
    Studio.pushToGame();
  });

  const vmodeBtn = el("button", { className: "rbtn", textContent: "Vertex Mode: OFF" });
  vmodeBtn.onclick = () => {
    S.vertexEditMode = !S.vertexEditMode;
    vmodeBtn.textContent = S.vertexEditMode ? "Vertex Mode: ON" : "Vertex Mode: OFF";
    Studio.buildVertexHelpers();
  };

  const page0 = el("div", { className: "pg" }, [
    viewportFrame,
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Chassis Paint", el("small", {}, ["Primary coat"])]),
        bodyColInput
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Underglow Neon Tubes", el("small", {}, ["Ground glow effect"])]),
        el("div", { style: "display:flex;gap:6px;align-items:center;" }, [neonColInput, neonToggle])
      ])
    ]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Add 3D Primitives", el("small", {}, ["Aero spoilers & pipes"])]),
        el("div", { className: "btn-grp" }, [
          el("button", { className: "rbtn", textContent: "+ Wing", onclick: () => Studio.addPrimitive("box") }),
          el("button", { className: "rbtn", textContent: "+ Exhaust", onclick: () => Studio.addPrimitive("cylinder") }),
          el("button", { className: "rbtn", textContent: "+ Sphere", onclick: () => Studio.addPrimitive("sphere") })
        ])
      ])
    ]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Mini-Blender Vertex Studio", el("small", {}, ["Edit buffer vertices"])]),
        vmodeBtn
      ]),
      el("div", { className: "btn-grp" }, [
        el("button", { className: "rbtn", textContent: "Extend Bumper (+Z)", onclick: () => Studio.displace("z", 0.08, "front") }),
        el("button", { className: "rbtn", textContent: "Pull Rear (-Z)", onclick: () => Studio.displace("z", -0.08, "rear") }),
        el("button", { className: "rbtn", textContent: "Chop Roof (-Y)", onclick: () => Studio.displace("y", -0.06, "top") })
      ])
    ])
  ]);

  // TAB 1: PHYSICS
  const pwrStep = stepper(S.enginePower, 1.0, 20.0, (v) => { S.enginePower = v; });
  const gravStep = stepper(S.gravityY, -40.0, 10.0, (v) => { S.gravityY = v; });
  const radStep = stepper(S.wheelRadius, 0.2, 0.6, (v) => { S.wheelRadius = v; Studio.rebuildClone(); Studio.pushToGame(); });
  const baseStep = stepper(S.wheelbase, 1.5, 4.5, (v) => { S.wheelbase = v; Studio.rebuildClone(); Studio.pushToGame(); });

  const page1 = el("div", { className: "pg hide" }, [
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Engine Power Mult", el("small", {}, ["Scales acceleration & top speed"])]),
        pwrStep.wrap
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Gravity Vector", el("small", {}, ["World gravity (m/s²)"])]),
        gravStep.wrap
      ])
    ]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Wheel Radius", el("small", {}, ["Tire collision size"])]),
        radStep.wrap
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Wheelbase Track", el("small", {}, ["Axle length spacing"])]),
        baseStep.wrap
      ])
    ]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Barrier No-Clip Bypass", el("small", {}, ["Ignore wall collision blocks"])]),
        mkSwitch(S.noClip, (v) => { S.noClip = v; })
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Infinite Nitrous Boost", el("small", {}, ["Forward velocity boost tick"])]),
        mkSwitch(S.infiniteBoost, (v) => { S.infiniteBoost = v; })
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Anti-Drift Tire Grip", el("small", {}, ["Lock lateral slip to zero"])]),
        mkSwitch(S.infiniteGrip, (v) => { S.infiniteGrip = v; })
      ])
    ])
  ]);

  // TAB 2: INTERNALS INSPECTOR
  const searchIn = el("input", { type: "text", placeholder: "Search engine property path..." });
  const scroller = el("div", { className: "tbl" });

  const renderTable = () => {
    scroller.innerHTML = "";
    Engine.scan();
    const car = Engine.car;
    if (!car) {
      scroller.appendChild(el("div", { style: "padding:16px;text-align:center;opacity:.6;" }, ["Car not spawned yet. Click BEGIN to drive!"]));
      return;
    }

    const q = searchIn.value.trim().toLowerCase();
    const rows = [];

    const walk = (prefix, obj, depth = 0) => {
      if (!obj || depth > 2) return;
      for (const k of Object.keys(obj)) {
        const val = obj[k];
        const path = prefix + "." + k;
        if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
          if (!q || path.toLowerCase().includes(q)) rows.push({ path, obj, key: k, val });
        } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          walk(path, val, depth + 1);
        }
      }
    };

    walk("Car", car);
    if (car.metrics) walk("Metrics", car.metrics);
    if (car.wheels) walk("Wheels", car.wheels);

    rows.slice(0, 60).forEach((item) => {
      const inp = el("input", { value: String(item.val) });
      inp.onchange = () => {
        const n = Number(inp.value);
        item.obj[item.key] = isNaN(n) ? inp.value : n;
      };
      const row = el("div", { className: "tr" }, [
        el("div", { className: "nm", title: item.path }, [item.path]),
        inp
      ]);
      scroller.appendChild(row);
    });
  };

  searchIn.oninput = renderTable;

  const page2 = el("div", { className: "pg hide" }, [
    el("div", { className: "srch" }, [searchIn]),
    scroller
  ]);

  // TAB BAR & WORKSPACE
  const tabA = el("div", { className: "tab on", textContent: "3D Garage" });
  const tabB = el("div", { className: "tab", textContent: "Physics" });
  const tabC = el("div", { className: "tab", textContent: "Internals" });
  const tabs = el("div", { className: "tabs" }, [el("div", { className: "ind" }), tabA, tabB, tabC]);

  const setTab = (i) => {
    S.tab = i;
    tabs.classList.toggle("t1", i === 1);
    tabs.classList.toggle("t2", i === 2);
    [tabA, tabB, tabC].forEach((t, j) => t.classList.toggle("on", j === i));
    [page0, page1, page2].forEach((p, j) => p.classList.toggle("hide", j !== i));
    panel.classList.toggle("wide", i === 0);
    setTimeout(updateMap, 60);

    if (i === 0) {
      setTimeout(() => Studio.setPreset("persp"), 100);
    } else if (i === 2) {
      renderTable();
    }
  };

  tabA.onclick = () => setTab(0);
  tabB.onclick = () => setTab(1);
  tabC.onclick = () => setTab(2);

  const body = el("div", { className: "b" }, [tabs, page0, page1, page2, status]);
  const panel = el("div", { className: "p wide" }, [head, body]);

  root.appendChild(el("style", { textContent: css }));
  root.appendChild(mkSvg());
  root.appendChild(panel);
  document.body.appendChild(mkSvg());
  document.body.appendChild(host);

  // Initialize Viewport Canvas
  Studio.init(viewportFrame);

  // Background Watcher: Polls until the car spawns, then updates studio & UI status
  const carPoller = setInterval(() => {
    if (Engine.scan()) {
      status.textContent = "Vehicle Connected";
      dot.style.background = "#34c759";
      Studio.rebuildClone();
    }
  }, 1000);

  // Dynamic SVG Glass Map Resizer
  let lastW = 0, lastH = 0;
  const updateMap = () => {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    if (!w || !h || (w === lastW && h === lastH)) return;
    lastW = w; lastH = h;
    let url; try { url = makeMap(w, h, 34, 28); } catch (e) { return; }
    svgs.forEach((s) => {
      const f = s.querySelector("filter"), im = s.querySelector("feImage");
      f.setAttribute("width", w); f.setAttribute("height", h);
      im.setAttribute("width", w); im.setAttribute("height", h);
      im.setAttribute("href", url);
      im.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    });
  };
  setTimeout(updateMap, 100);

  panel.addEventListener("pointermove", (e) => {
    const r = panel.getBoundingClientRect();
    panel.style.setProperty("--mx", (e.clientX - r.left) + "px");
    panel.style.setProperty("--my", (e.clientY - r.top) + "px");
  });

  // Rubber-Band Drag Physics
  const rubber = (o) => o === 0 ? 0 : Math.sign(o) * 36 * (1 - Math.exp(-Math.abs(o) / 80));
  const ZONE = 70;
  let dx = 0, dy = 0, drag = false;

  head.addEventListener("pointerdown", (e) => {
    if (e.target === minBtn) return;
    drag = true;
    dx = e.clientX - host.offsetLeft;
    dy = e.clientY - host.offsetTop;
    head.setPointerCapture(e.pointerId);
    panel.style.transform = "scale(1.02)";
  });

  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = host.offsetWidth, h = host.offsetHeight;
    const maxL = Math.max(0, innerWidth - w), maxT = Math.max(0, innerHeight - h);
    const l = e.clientX - dx, t = e.clientY - dy;
    const ol = l < 0 ? l : l > maxL ? l - maxL : 0;
    const ot = t < 0 ? t : t > maxT ? t - maxT : 0;
    const vl = Math.min(Math.max(l, 0), maxL) + rubber(ol);
    const vt = Math.min(Math.max(t, 0), maxT) + rubber(ot);
    host.style.left = vl + "px"; host.style.top = vt + "px";

    const press = (dist) => Math.min(1.6, Math.max(0, (ZONE - dist) / ZONE));
    const px = Math.max(press(vl), press(innerWidth - (vl + w)));
    const py = Math.max(press(vt), press(innerHeight - (vt + h)));
    const sx = (1 - 0.14 * px) * (1 + 0.05 * py);
    const sy = (1 - 0.14 * py) * (1 + 0.05 * px);
    const tilt = Math.min(Math.max(-(e.movementX || 0) * 0.6, -8), 8);
    panel.style.transform = "scale(" + (1.02 * sx) + "," + (1.02 * sy) + ") skewX(" + tilt + "deg)";
  });

  const endDrag = () => {
    if (!drag) return;
    drag = false;
    panel.style.transform = "";
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  // Minimize Button: Smoothly collapses the entire body into the glass header
  minBtn.onclick = () => {
    body.classList.toggle("hide");
    minBtn.textContent = body.classList.contains("hide") ? "+" : "–";
    setTimeout(updateMap, 60);
  };

  // Keyboard Shortcuts
  window.addEventListener("keydown", (e) => {
    const active = document.activeElement || root.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

    if (e.code === "Backslash" || e.code === "Backquote") {
      e.preventDefault();
      host.style.display = host.style.display === "none" ? "block" : "none";
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) History.redo(); else History.undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") {
      e.preventDefault();
      History.redo();
    }
  });

  setInterval(() => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  }, 2000);

  console.log("%c[FastRoads Studio Mounted]%c Press '\\' or '`' to toggle menu.", "color:#00f0ff;font-weight:bold;", "color:#fff;");
})();