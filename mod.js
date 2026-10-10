/**
 * Fast Roads (Slow Roads) — Fullscreen 3D CAD Blender Studio & Mod Menu
 * Complete Standalone Script (mod.js)
 */

(function () {
  "use strict";

  if (window.__fastRoadsStudioHost) {
    window.__fastRoadsStudioHost.style.display = window.__fastRoadsStudioHost.style.display === "none" ? "block" : "none";
    return;
  }

  // =========================================================================
  // 1. ENGINE & THREE.JS RESOLVER
  // =========================================================================
  const Engine = {
    car: window.car || window.z || null,
    scene: window.qr || window.gameScene || null,
    three: window.THREE || null,
    currentType: "Roadster",

    scan() {
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

      if (window.jr && window.jr.value) {
        this.currentType = window.jr.value.type || "Roadster";
      }
      return this.car;
    },

    setVehicleType(type) {
      this.currentType = type;
      if (window.jr && typeof window.jr.set === "function") {
        window.jr.set("type", type);
      }
      setTimeout(() => {
        this.scan();
        CadStudio.rebuildVehicle();
      }, 300);
    }
  };
  Engine.scan();

  // Three.js CDN fallback
  if (!Engine.three && !window.THREE) {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    s.onload = () => { Engine.three = window.THREE; };
    document.head.appendChild(s);
  }

  // =========================================================================
  // 2. MOD STATE & SETTINGS
  // =========================================================================
  const KEY = "fastroads_cad_studio_v8";
  const loadSaved = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const saved = loadSaved();

  const S = (window.__FR_S = {
    tab: 0,
    cadTool: "select", // "select" | "move" | "scale" | "rotate" | "vertex" | "extrude" | "insert" | "paint"
    vRegion: "all",
    bodyColor: "#00f0ff",
    wheelColor: "#ffffff",
    neonActive: true,
    neonColor: "#ff007f",
    metalness: 0.85,
    roughness: 0.18,

    wheelRadius: 0.34,
    wheelWidth: 0.1,
    trackWidth: 1.36,
    wheelbase: 2.75,
    suspensionTravel: 0.07,

    enginePower: 1.0,
    gravityY: -9.81,
    infiniteBoost: false,
    noClip: false,
    infiniteGrip: false
  });
  Object.assign(S, saved);

  // =========================================================================
  // 3. COMMAND PATTERN (UNDO / REDO)
  // =========================================================================
  const History = {
    stack: [], index: -1, max: 50,
    execute(name, undoFn, redoFn) {
      redoFn();
      this.stack = this.stack.slice(0, this.index + 1);
      this.stack.push({ name, undo: undoFn, redo: redoFn });
      if (this.stack.length > this.max) this.stack.shift();
      else this.index++;
      updateStatus("Action: " + name);
    },
    undo() {
      if (this.index >= 0) {
        this.stack[this.index].undo();
        this.index--;
        updateStatus("Undo: " + (this.stack[this.index + 1]?.name || ""));
      }
    },
    redo() {
      if (this.index < this.stack.length - 1) {
        this.index++;
        this.stack[this.index].redo();
        updateStatus("Redo: " + this.stack[this.index].name);
      }
    }
  };

  // =========================================================================
  // 4. CORE ENGINE REWIRING
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
  // 5. FULLSCREEN BLENDER 3D CAD STUDIO
  // =========================================================================
  const CadStudio = {
    container: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    vehicleRoot: null,
    chassisMesh: null,
    wheelMeshes: [],
    customMeshes: [],
    neonGroup: null,
    neonLight: null,
    vertexPoints: null,
    selectedNode: null,

    // Orbit & Pan state
    isOrbiting: false,
    dragButton: 0,
    prevPointer: { x: 0, y: 0 },
    spherical: { radius: 5.5, theta: 0.8, phi: 1.15 },
    target: null,
    raycaster: null,
    mouseVec: null,
    isFullscreen: false,

    init(holderEl) {
      const THREE = Engine.three || window.THREE;
      if (!THREE) {
        setTimeout(() => this.init(holderEl), 250);
        return;
      }

      this.container = holderEl;
      this.target = new THREE.Vector3(0, 0.4, 0);
      this.raycaster = new THREE.Raycaster();
      this.mouseVec = new THREE.Vector2();

      this.canvas = document.createElement("canvas");
      this.canvas.style.cssText = "width: 100%; height: 100%; display: block; cursor: grab;";
      this.container.appendChild(this.canvas);

      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setSize(this.container.clientWidth || 800, this.container.clientHeight || 500);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, (this.container.clientWidth || 800) / (this.container.clientHeight || 500), 0.1, 100);
      this.updateCamera();

      // Studio 3-Point Lighting
      const amb = new THREE.AmbientLight(0xffffff, 0.95);
      const key = new THREE.DirectionalLight(0xffffff, 1.3);
      key.position.set(7, 14, 9);
      const fill = new THREE.DirectionalLight(0x00f0ff, 0.6);
      fill.position.set(-7, -4, -7);
      this.scene.add(amb, key, fill);

      const grid = new THREE.GridHelper(20, 40, 0x00f0ff, 0x1e293b);
      grid.position.y = -0.01;
      this.scene.add(grid);

      this.vertexPoints = new THREE.Group();
      this.scene.add(this.vertexPoints);

      this.bindControls();

      // Animation render loop
      const render = () => {
        requestAnimationFrame(render);
        if (this.renderer && (this.isFullscreen || (S.tab === 0 && !body.classList.contains("hide")))) {
          if (isNaN(this.camera.position.x)) {
            this.camera.position.set(3, 2, 4);
            this.camera.lookAt(0, 0.4, 0);
          }
          this.renderer.render(this.scene, this.camera);
        }
      };
      render();

      if (window.ResizeObserver) {
        new ResizeObserver(() => this.resize()).observe(this.container);
      }

      this.rebuildVehicle();
    },

    resize() {
      if (!this.renderer || !this.camera || !this.container) return;
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w > 0 && h > 0) {
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
      }
    },

    updateCamera() {
      if (!this.target) return;
      const x = this.spherical.radius * Math.sin(this.spherical.phi) * Math.sin(this.spherical.theta);
      const y = this.spherical.radius * Math.cos(this.spherical.phi);
      const z = this.spherical.radius * Math.sin(this.spherical.phi) * Math.cos(this.spherical.theta);
      this.camera.position.set(x + this.target.x, y + this.target.y, z + this.target.z);
      this.camera.lookAt(this.target);
    },

    setPreset(view) {
      if (view === "persp") { this.spherical.theta = 0.8; this.spherical.phi = 1.15; this.spherical.radius = 5.5; }
      else if (view === "front") { this.spherical.theta = Math.PI; this.spherical.phi = Math.PI / 2; }
      else if (view === "side") { this.spherical.theta = Math.PI / 2; this.spherical.phi = Math.PI / 2; }
      else if (view === "top") { this.spherical.theta = 0; this.spherical.phi = 0.05; }
      else if (view === "under") { this.spherical.theta = 0; this.spherical.phi = Math.PI - 0.15; }
      this.updateCamera();
    },

    bindControls() {
      const cv = this.canvas;
      cv.addEventListener("pointerdown", (e) => {
        this.isOrbiting = true;
        this.dragButton = e.button;
        this.prevPointer.x = e.clientX;
        this.prevPointer.y = e.clientY;
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = "grabbing";

        if (e.button === 0 && !e.shiftKey) {
          const rect = cv.getBoundingClientRect();
          this.mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          this.mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          this.raycaster.setFromCamera(this.mouseVec, this.camera);
          if (this.vehicleRoot) {
            const hits = this.raycaster.intersectObjects(this.vehicleRoot.children, true);
            if (hits.length > 0) this.selectMesh(hits[0].object);
          }
        }
      });

      cv.addEventListener("pointermove", (e) => {
        if (!this.isOrbiting) return;
        const dx = e.clientX - this.prevPointer.x;
        const dy = e.clientY - this.prevPointer.y;
        this.prevPointer.x = e.clientX;
        this.prevPointer.y = e.clientY;

        if (this.dragButton === 0 && !e.shiftKey) {
          // Orbit Rotation
          this.spherical.theta -= dx * 0.012;
          this.spherical.phi = Math.max(0.04, Math.min(Math.PI - 0.04, this.spherical.phi - dy * 0.012));
        } else {
          // Pan
          const THREE = Engine.three || window.THREE;
          const right = new THREE.Vector3().crossVectors(this.camera.up, this.camera.position).normalize();
          this.target.addScaledVector(right, -dx * 0.005);
          this.target.y += dy * 0.005;
        }
        this.updateCamera();
      });

      const stop = () => { this.isOrbiting = false; cv.style.cursor = "grab"; };
      cv.addEventListener("pointerup", stop);
      cv.addEventListener("pointercancel", stop);

      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.spherical.radius = Math.max(1.5, Math.min(26.0, this.spherical.radius + e.deltaY * 0.005));
        this.updateCamera();
      }, { passive: false });
    },

    selectMesh(node) {
      this.selectedNode = node;
      this.renderVertexHandles();
      updateStatus("Selected: " + (node.name || "Chassis Mesh"));
      renderCadToolOverlay();
      renderOutliner();
    },

    rebuildVehicle() {
      const THREE = Engine.three || window.THREE;
      if (!this.scene || !THREE) return;
      if (this.vehicleRoot) this.scene.remove(this.vehicleRoot);

      this.vehicleRoot = new THREE.Group();
      this.vehicleRoot.name = "CAD_Vehicle";
      this.scene.add(this.vehicleRoot);
      this.wheelMeshes = [];

      Engine.scan();
      const car = Engine.car;

      // Deep Clone from the Live Game Engine Mesh Hierarchy
      if (car && car.geo && car.geo.children.length > 0) {
        car.geo.children.forEach((child) => {
          if (child.name === "fl" || (child.children && child.children.some(c => c.name === "fl"))) {
            // Wheels
          } else {
            const clone = child.clone(true);
            clone.traverse((m) => {
              if (m.isMesh && m.material) {
                m.material = m.material.clone();
                if (m.material.color) m.material.color.set(S.bodyColor);
                m.material.metalness = S.metalness;
                m.material.roughness = S.roughness;
              }
            });
            this.chassisMesh = clone;
            this.vehicleRoot.add(clone);
          }
        });
        this.assembleWheels();
      } else {
        // High-Precision Procedural Mesh Representation
        this.buildProceduralRig();
      }

      this.assembleNeon();
      this.customMeshes.forEach(m => this.vehicleRoot.add(m));
      this.selectMesh(this.chassisMesh || this.vehicleRoot);
      renderOutliner();
    },

    buildProceduralRig() {
      const THREE = Engine.three || window.THREE;
      const type = Engine.currentType;
      const mat = new THREE.MeshStandardMaterial({ color: S.bodyColor, roughness: S.roughness, metalness: S.metalness });

      let chassisGeo, cabinGeo;
      if (type === "Coach") {
        chassisGeo = new THREE.BoxGeometry(2.2, 1.4, 5.5);
        cabinGeo = new THREE.BoxGeometry(2.1, 0.4, 5.3);
      } else if (type === "Bike") {
        chassisGeo = new THREE.BoxGeometry(0.35, 0.5, 1.9);
        cabinGeo = new THREE.BoxGeometry(0.25, 0.3, 0.8);
      } else {
        // Roadster, Lambo, Supercar
        chassisGeo = new THREE.BoxGeometry(1.65, 0.42, 3.2);
        cabinGeo = new THREE.BoxGeometry(1.2, 0.38, 1.6);
      }

      const chassis = new THREE.Mesh(chassisGeo, mat);
      chassis.name = type + "_Chassis";
      chassis.position.y = 0.38;
      this.vehicleRoot.add(chassis);
      this.chassisMesh = chassis;

      const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 }));
      cabin.name = type + "_Cabin";
      cabin.position.set(0, 0.76, -0.2);
      this.vehicleRoot.add(cabin);

      this.assembleWheels();
    },

    assembleWheels() {
      const THREE = Engine.three || window.THREE;
      const mat = new THREE.MeshStandardMaterial({ color: S.wheelColor, metalness: 0.9, roughness: 0.15 });
      const r = S.wheelRadius, w = S.wheelWidth;
      const geo = new THREE.CylinderGeometry(r, r, w * 2, 28);
      geo.rotateZ(Math.PI / 2);

      const positions = [
        { name: "Wheel_FL", x: S.trackWidth / 2, y: r, z: S.wheelbase / 2 },
        { name: "Wheel_FR", x: -S.trackWidth / 2, y: r, z: S.wheelbase / 2 },
        { name: "Wheel_RL", x: S.trackWidth / 2, y: r, z: -S.wheelbase / 2 },
        { name: "Wheel_RR", x: -S.trackWidth / 2, y: r, z: -S.wheelbase / 2 }
      ];

      positions.forEach((p) => {
        const m = new THREE.Mesh(geo.clone(), mat.clone());
        m.name = p.name;
        m.position.set(p.x, p.y, p.z);
        this.vehicleRoot.add(m);
        this.wheelMeshes.push(m);
      });
    },

    assembleNeon() {
      const THREE = Engine.three || window.THREE;
      if (this.neonGroup && this.vehicleRoot) this.vehicleRoot.remove(this.neonGroup);
      this.neonGroup = new THREE.Group();
      this.neonGroup.name = "Underglow_Neon";

      const neonMat = new THREE.MeshBasicMaterial({ color: S.neonColor });
      const geo = new THREE.CylinderGeometry(0.02, 0.02, 2.2);
      geo.rotateX(Math.PI / 2);

      const left = new THREE.Mesh(geo, neonMat); left.position.set(-0.75, 0.08, 0);
      const right = new THREE.Mesh(geo, neonMat); right.position.set(0.75, 0.08, 0);
      this.neonLight = new THREE.PointLight(S.neonColor, 2.5, 4.0);
      this.neonLight.position.set(0, 0.05, 0);

      this.neonGroup.add(left, right, this.neonLight);
      this.neonGroup.visible = S.neonActive;
      if (this.vehicleRoot) this.vehicleRoot.add(this.neonGroup);
    },

    renderVertexHandles() {
      const THREE = Engine.three || window.THREE;
      while (this.vertexPoints.children.length > 0) this.vertexPoints.remove(this.vertexPoints.children[0]);
      if (S.cadTool !== "vertex" || !this.selectedNode || !this.selectedNode.geometry) return;

      const pos = this.selectedNode.geometry.attributes?.position;
      if (!pos) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
      const geo = new THREE.BoxGeometry(0.038, 0.038, 0.038);

      for (let i = 0; i < Math.min(pos.count, 450); i++) {
        const h = new THREE.Mesh(geo, mat);
        h.position.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        h.position.applyMatrix4(this.selectedNode.matrixWorld);
        this.vertexPoints.add(h);
      }
    },

    displaceVertices(axis, amount) {
      const node = this.selectedNode;
      if (!node || !node.geometry || !node.geometry.attributes.position) return;
      const pos = node.geometry.attributes.position;
      const reg = S.vRegion;

      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        let pass = true;
        if (reg === "front" && z < 0.2) pass = false;
        if (reg === "rear" && z > -0.2) pass = false;
        if (reg === "top" && y < 0.2) pass = false;
        if (reg === "left" && x < 0) pass = false;
        if (reg === "right" && x > 0) pass = false;

        if (pass) {
          if (axis === "x") pos.setX(i, x + amount);
          if (axis === "y") pos.setY(i, y + amount);
          if (axis === "z") pos.setZ(i, z + amount);
        }
      }
      pos.needsUpdate = true;
      node.geometry.computeVertexNormals();
      node.geometry.computeBoundingBox();
      this.renderVertexHandles();
      this.pushToGame();
    },

    extrudeFaces() {
      const node = this.selectedNode;
      if (!node || !node.geometry || !node.geometry.attributes.position) return;
      const pos = node.geometry.attributes.position;

      History.execute("Extrude Faces (" + node.name + ")", () => {
        // Undo displacement
        for (let i = 0; i < pos.count; i++) {
          pos.setX(i, pos.getX(i) - 0.1);
          pos.setY(i, pos.getY(i) - 0.1);
        }
        pos.needsUpdate = true;
        node.geometry.computeVertexNormals();
        CadStudio.pushToGame();
      }, () => {
        // Redo displacement along surface
        for (let i = 0; i < pos.count; i++) {
          pos.setX(i, pos.getX(i) + 0.1);
          pos.setY(i, pos.getY(i) + 0.1);
        }
        pos.needsUpdate = true;
        node.geometry.computeVertexNormals();
        CadStudio.pushToGame();
      });
      updateStatus("Extruded: " + node.name);
    },

    addCADPart(type) {
      const THREE = Engine.three || window.THREE;
      let geo, name;
      if (type === "wing") {
        geo = new THREE.BoxGeometry(0.9, 0.07, 0.38);
        name = "GT_Wing_" + (this.customMeshes.length + 1);
      } else if (type === "splitter") {
        geo = new THREE.BoxGeometry(1.3, 0.05, 0.6);
        name = "Aero_Splitter_" + (this.customMeshes.length + 1);
      } else if (type === "exhaust") {
        geo = new THREE.CylinderGeometry(0.045, 0.045, 0.8, 16);
        name = "Exhaust_Tip_" + (this.customMeshes.length + 1);
      } else if (type === "box") {
        geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
        name = "CAD_Box_" + (this.customMeshes.length + 1);
      } else {
        geo = new THREE.SphereGeometry(0.22, 16, 16);
        name = "CAD_Sphere_" + (this.customMeshes.length + 1);
      }

      const mat = new THREE.MeshStandardMaterial({ color: S.bodyColor, roughness: S.roughness, metalness: S.metalness });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.position.set(0, 0.85, -1.2);

      History.execute("Insert " + name, () => {
        this.vehicleRoot.remove(mesh);
        const i = this.customMeshes.indexOf(mesh);
        if (i >= 0) this.customMeshes.splice(i, 1);
        this.selectMesh(this.chassisMesh);
      }, () => {
        this.vehicleRoot.add(mesh);
        this.customMeshes.push(mesh);
        this.selectMesh(mesh);
      });
      this.pushToGame();
    },

    pushToGame() {
      const c = Engine.scan();
      if (!c || !c.geo) return;
      const g = c.geo;

      // Synchronize paint to game vehicle
      g.traverse((node) => {
        if (node.isMesh && node.material) {
          const n = (node.name || "").toLowerCase();
          if (n.includes("body") || n.includes("map") || node === c) {
            if (node.material.color) node.material.color.set(S.bodyColor);
            node.material.metalness = S.metalness;
            node.material.roughness = S.roughness;
          }
          if (n.includes("wheel") && node.material.color) {
            node.material.color.set(S.wheelColor);
          }
        }
      });

      // Synchronize custom CAD models
      let holder = g.getObjectByName("__mod_cad_parts__");
      if (!holder) {
        const THREE = Engine.three || window.THREE;
        holder = new THREE.Group();
        holder.name = "__mod_cad_parts__";
        g.add(holder);
      }
      while (holder.children.length > 0) holder.remove(holder.children[0]);
      this.customMeshes.forEach(m => holder.add(m.clone(true)));

      // Synchronize underglow neon
      let neon = g.getObjectByName("__mod_neon_light__");
      if (S.neonActive) {
        if (!neon) {
          const THREE = Engine.three || window.THREE;
          neon = new THREE.PointLight(S.neonColor, 2.5, 4.0);
          neon.name = "__mod_neon_light__";
          neon.position.set(0, 0.1, 0);
          g.add(neon);
        }
        neon.color.set(S.neonColor);
      } else if (neon) {
        g.remove(neon);
      }

      // Synchronize vehicle dimensions
      if (c.wheels) {
        c.wheels.radius = S.wheelRadius;
        c.wheels.width = S.trackWidth;
        c.wheels.length = S.wheelbase;
        c.wheels.travel = S.suspensionTravel;
      }
    }
  };

  // =========================================================================
  // 6. UI CONSTRUCTION & STYLING (LIQUID GLASS + FULLSCREEN CAD)
  // =========================================================================
  const host = document.createElement("div");
  host.id = "fastroads-cad-host";
  host.style.cssText = "position:fixed;top:40px;left:20px;z-index:2147483647;";
  window.__fastRoadsStudioHost = host;

  [
    "mousedown","mouseup","mousemove","click","dblclick","touchstart","touchmove","touchend","touchcancel",
    "pointerdown","pointermove","pointerup","pointercancel","wheel","contextmenu","keydown","keyup","keypress","input","change"
  ].forEach((ev) => host.addEventListener(ev, (e) => e.stopPropagation()));

  const root = host.attachShadow({ mode: "open" });
  const spring = "cubic-bezier(.34,1.56,.64,1)";
  const MONO = "ui-monospace,Menlo,Consolas,monospace";

  const css = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .p {
      position: relative; width: 440px; color: #000; font: 13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
      border-radius: 34px; background: linear-gradient(135deg, rgba(255,255,255,.24), rgba(255,255,255,.08));
      -webkit-backdrop-filter: blur(14px) saturate(190%) brightness(1.08);
      backdrop-filter: blur(14px) saturate(190%) brightness(1.08);
      backdrop-filter: url(#lgfilter) blur(6px) saturate(190%) brightness(1.08);
      box-shadow: 0 18px 50px rgba(0,0,0,.35), 0 2px 8px rgba(0,0,0,.2), inset 0 0 0 1px rgba(255,255,255,.18), inset 0 1px 1px rgba(255,255,255,.6);
      transition: transform .6s ${spring}, width .5s ${spring}; user-select: none; overflow: hidden;
    }
    .p::before {
      content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1.5px; pointer-events: none; z-index: 3;
      background: linear-gradient(140deg, rgba(255,255,255,.95), rgba(255,255,255,.08) 28%, rgba(255,255,255,.04) 62%, rgba(255,255,255,.7));
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
    }
    .p::after {
      content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 0;
      background: radial-gradient(230px circle at var(--mx,30%) var(--my,0%), rgba(255,255,255,.26), rgba(255,255,255,0) 62%);
    }
    .h, .b { position: relative; z-index: 1; }
    .h {
      padding: 15px 18px 9px; display: flex; justify-content: space-between; align-items: center;
      cursor: grab; touch-action: none; font-weight: 700; font-size: 14.5px; letter-spacing: .2px; text-shadow: 0 1px 6px rgba(0,0,0,.1);
    }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34c759; margin-left: 8px; vertical-align: middle; box-shadow: 0 0 8px #34c759; }
    .win-btns { display: flex; align-items: center; gap: 6px; }
    .min {
      width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,.4);
      background: linear-gradient(160deg, rgba(255,255,255,.35), rgba(255,255,255,.1));
      box-shadow: inset 0 1px 1px rgba(255,255,255,.6); color: #000; font-size: 15px; line-height: 24px;
      text-align: center; cursor: pointer; padding: 0; transition: transform .3s ${spring};
    }
    .min:hover { transform: scale(1.1); }
    .min:active { transform: scale(.9); }
    .b { padding: 2px 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .b.hide { display: none !important; }

    /* Tabs */
    .tabs { position: relative; display: flex; padding: 3px; border-radius: 18px; background: rgba(0,0,0,.22); box-shadow: inset 0 1px 3px rgba(0,0,0,.25), 0 1px 0 rgba(255,255,255,.2); }
    .tab { flex: 1; text-align: center; padding: 8px 0; font-weight: 600; font-size: 12px; cursor: pointer; position: relative; z-index: 1; opacity: .7; transition: opacity .25s, transform .4s ${spring}; }
    .tab.on { opacity: 1; }
    .ind {
      position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3); border-radius: 15px;
      background: linear-gradient(160deg, rgba(255,255,255,.42), rgba(255,255,255,.14));
      box-shadow: inset 0 1px 1px rgba(255,255,255,.7), 0 2px 8px rgba(0,0,0,.2); transition: transform .55s ${spring};
    }
    .tabs.t1 .ind { transform: translateX(100%); }
    .tabs.t2 .ind { transform: translateX(200%); }
    .pg { display: flex; flex-direction: column; gap: 10px; animation: pgin .45s ${spring}; }
    .pg.hide { display: none; }
    @keyframes pgin { from { opacity: 0; transform: translateY(8px) scale(.97); } to { opacity: 1; transform: none; } }

    /* Cards & Components */
    .card {
      background: linear-gradient(160deg, rgba(255,255,255,.2), rgba(255,255,255,.06)); border-radius: 24px;
      padding: 11px 13px; box-shadow: inset 0 1px 1px rgba(255,255,255,.5), inset 0 0 0 1px rgba(255,255,255,.12), 0 4px 14px rgba(0,0,0,.12);
      display: flex; flex-direction: column; gap: 8px;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .lbl { font-weight: 600; font-size: 12.5px; }
    .lbl small { display: block; opacity: .75; font-size: 10.5px; font-weight: 400; margin-top: 1px; }

    .step { display: flex; align-items: center; gap: 2px; background: rgba(0,0,0,.22); border-radius: 16px; padding: 3px; box-shadow: inset 0 1px 3px rgba(0,0,0,.25), 0 1px 0 rgba(255,255,255,.2); }
    .step button {
      width: 28px; height: 28px; border: 0; border-radius: 13px; background: linear-gradient(160deg, rgba(255,255,255,.34), rgba(255,255,255,.12));
      box-shadow: inset 0 1px 1px rgba(255,255,255,.6); color: #000; font-size: 17px; line-height: 26px; cursor: pointer; padding: 0;
      transition: transform .4s ${spring};
    }
    .step input { width: 46px; text-align: center; background: transparent; border: 0; color: #000; font: 700 13px -apple-system, system-ui, sans-serif; outline: none; padding: 0; }

    .sw { width: 50px; height: 30px; border-radius: 15px; background: rgba(255,255,255,.2); box-shadow: inset 0 1px 3px rgba(0,0,0,.28), 0 1px 0 rgba(255,255,255,.25); position: relative; cursor: pointer; transition: background .3s; flex: none; }
    .sw i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 12px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.4); transition: transform .45s ${spring}; }
    .sw.on { background: rgba(52,199,89,.9); }
    .sw.on i { transform: translateX(20px); }

    .rbtn {
      border: 0; border-radius: 14px; padding: 6px 14px; background: linear-gradient(160deg, rgba(255,255,255,.38), rgba(255,255,255,.14));
      box-shadow: inset 0 1px 1px rgba(255,255,255,.6), 0 2px 6px rgba(0,0,0,.15); color: #000; font: 600 12px -apple-system, system-ui, sans-serif;
      cursor: pointer; transition: transform .2s ${spring};
    }
    .rbtn:hover { transform: scale(1.04); }
    .rbtn.launch {
      width: 100%; padding: 12px; font-size: 13.5px; font-weight: 700; color: #fff;
      background: linear-gradient(135deg, #0ea5e9, #0284c7); box-shadow: 0 4px 16px rgba(2,132,199,.4);
    }

    select.glass-select {
      background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.3); border-radius: 14px; padding: 5px 12px;
      color: #000; font-weight: 600; font-size: 12px; outline: none; cursor: pointer;
    }

    /* FULLSCREEN BLENDER WORKSPACE MODAL */
    .cad-modal {
      position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 1000000;
      background: #0f172a; color: #f1f5f9; display: flex; flex-direction: column; user-select: none;
    }
    .cad-modal.hidden { display: none; }
    .cad-topbar {
      height: 48px; background: #1e293b; border-bottom: 1px solid rgba(255,255,255,.1);
      display: flex; align-items: center; justify-content: space-between; padding: 0 16px; flex: none;
    }
    .cad-body { flex: 1; display: flex; overflow: hidden; position: relative; }
    .cad-viewport { flex: 1; height: 100%; position: relative; background: radial-gradient(circle at center, #1e293b 0%, #090d16 100%); }

    /* Floating Viewport Overlays */
    .cad-tool-shelf {
      position: absolute; top: 12px; left: 12px; display: flex; gap: 4px; z-index: 20;
      background: rgba(15, 23, 42, 0.75); padding: 5px; border-radius: 12px; backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,.15);
    }
    .tool-btn {
      background: transparent; border: 0; color: #94a3b8; font-size: 12px; font-weight: 600;
      padding: 6px 10px; border-radius: 8px; cursor: pointer; transition: all .2s;
    }
    .tool-btn:hover { background: rgba(255,255,255,.12); color: #fff; }
    .tool-btn.active { background: #00f0ff; color: #000; font-weight: 700; box-shadow: 0 0 12px #00f0ff; }

    .cad-tool-options {
      position: absolute; bottom: 12px; left: 12px; right: 12px; display: flex; align-items: center;
      justify-content: space-between; gap: 8px; z-index: 20; background: rgba(15, 23, 42, 0.85);
      padding: 8px 16px; border-radius: 14px; backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.15);
      font-size: 12px;
    }

    .cad-outliner-panel {
      width: 280px; height: 100%; background: #1e293b; border-left: 1px solid rgba(255,255,255,.1);
      display: flex; flex-direction: column; padding: 12px; gap: 10px; overflow-y: auto; flex: none;
    }
    .outliner-title { font-size: 11px; text-transform: uppercase; font-weight: 700; color: #64748b; letter-spacing: .6px; }
    .mesh-tree { background: rgba(0,0,0,.3); border-radius: 10px; padding: 4px; max-height: 220px; overflow-y: auto; }
    .mesh-item { padding: 5px 8px; border-radius: 6px; font-size: 11.5px; cursor: pointer; display: flex; justify-content: space-between; }
    .mesh-item:hover { background: rgba(255,255,255,.08); }
    .mesh-item.active { background: rgba(0,240,255,.2); border: 1px solid rgba(0,240,255,.5); color: #00f0ff; font-weight: 700; }

    .cad-btn {
      background: #334155; border: 1px solid rgba(255,255,255,.15); color: #fff; font-size: 11.5px;
      font-weight: 600; padding: 5px 10px; border-radius: 8px; cursor: pointer; transition: background .2s;
    }
    .cad-btn:hover { background: #475569; }
    .cad-btn.danger { background: #dc2626; border-color: #ef4444; }

    .status { font: 11px ${MONO}; opacity: .85; min-height: 13px; padding: 0 6px; }
  `;

  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) Object.assign(n, props);
    (kids || []).forEach((k) => n.appendChild(typeof k === "string" ? document.createTextNode(k) : k));
    return n;
  };

  const svgs = [];
  const mkSvg = () => {
    const d = document.createElement("div");
    d.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;pointer-events:none">
        <defs><filter id="lgfilter" filterUnits="userSpaceOnUse" x="0" y="0" width="700" height="700" color-interpolation-filters="sRGB">
          <feImage x="0" y="0" width="700" height="700" preserveAspectRatio="none" result="map"/>
          <feDisplacementMap in="SourceGraphic" in2="map" scale="36" xChannelSelector="R" yChannelSelector="G"/>
        </filter></defs>
      </svg>`;
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
  const closeBtn = el("button", { className: "min", textContent: "×", style: "font-size:16px;line-height:22px;" });
  const dot = el("span", { className: "dot on" });
  const titleText = el("span", {}, ["Fast Roads Studio ", dot]);
  const head = el("div", { className: "h" }, [
    titleText,
    el("div", { className: "win-btns" }, [minBtn, closeBtn])
  ]);
  const status = el("div", { className: "status", textContent: "Engine Ready" });
  const updateStatus = (t) => { status.textContent = t; };

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

  // =========================================================================
  // TAB 0: MINI MENU CONTROLS & CAD LAUNCHER
  // =========================================================================
  const vehicleDropdown = el("select", { className: "glass-select" });
  ["Roadster", "Coach", "Bike", "Lambo", "Supercar"].forEach(type => {
    const opt = el("option", { value: type, textContent: type });
    if (type === Engine.currentType) opt.selected = true;
    vehicleDropdown.appendChild(opt);
  });
  vehicleDropdown.onchange = (e) => {
    Engine.setVehicleType(e.target.value);
  };

  const launchCadBtn = el("button", { className: "rbtn launch", textContent: "⛶ Open Fullscreen CAD Studio" });

  const page0 = el("div", { className: "pg" }, [
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Vehicle Model Selector", el("small", {}, ["Switch model & load geometry directly"])]),
        vehicleDropdown
      ])
    ]),
    el("div", { className: "card" }, [
      launchCadBtn,
      el("small", { style: "text-align:center;color:#64748b;font-weight:600;margin-top:4px;" }, ["Launches full-screen Blender 3D CAD modeling studio"])
    ])
  ]);

  // =========================================================================
  // TAB 1: PHYSICS & TUNING
  // =========================================================================
  const pwrStep = stepper(S.enginePower, 1.0, 20.0, (v) => { S.enginePower = v; });
  const gravStep = stepper(S.gravityY, -40.0, 10.0, (v) => { S.gravityY = v; });
  const radStep = stepper(S.wheelRadius, 0.2, 0.6, (v) => { S.wheelRadius = v; CadStudio.rebuildVehicle(); CadStudio.pushToGame(); });
  const baseStep = stepper(S.wheelbase, 1.5, 4.5, (v) => { S.wheelbase = v; CadStudio.rebuildVehicle(); CadStudio.pushToGame(); });

  const page1 = el("div", { className: "pg hide" }, [
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Engine Power Multiplier", el("small", {}, ["Scales acceleration & maximum velocity"])]),
        pwrStep.wrap
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Gravity Vector", el("small", {}, ["World gravity (m/s²)"])]),
        gravStep.wrap
      ])
    ]),
    el("div", { className: "card" }, [
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Wheel Tire Radius", el("small", {}, ["Physical wheel collision circle"])]),
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
        el("div", { className: "lbl" }, ["Infinite Boost / Nitrous", el("small", {}, ["Continuous forward velocity acceleration"])]),
        mkSwitch(S.infiniteBoost, (v) => { S.infiniteBoost = v; })
      ]),
      el("div", { className: "row" }, [
        el("div", { className: "lbl" }, ["Anti-Drift Tire Grip", el("small", {}, ["Locks lateral slip to 100%"])]),
        mkSwitch(S.infiniteGrip, (v) => { S.infiniteGrip = v; })
      ])
    ])
  ]);

  // =========================================================================
  // TAB 2: INTERNALS INSPECTOR
  // =========================================================================
  const searchIn = el("input", { type: "text", placeholder: "Search engine property path..." });
  const scroller = el("div", { style: "height:240px;overflow-y:auto;background:rgba(0,0,0,.2);border-radius:18px;padding:4px;" });

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
      const inp = el("input", { value: String(item.val), style: "width:110px;background:rgba(255,255,255,.15);border:0;border-radius:8px;padding:4px;color:#000;font:11px monospace;" });
      inp.onchange = () => {
        const n = Number(inp.value);
        item.obj[item.key] = isNaN(n) ? inp.value : n;
      };
      const row = el("div", { style: "display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08);" }, [
        el("div", { style: "font:11px monospace;color:#000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", title: item.path }, [item.path]),
        inp
      ]);
      scroller.appendChild(row);
    });
  };

  searchIn.oninput = renderTable;
  const page2 = el("div", { className: "pg hide" }, [searchIn, scroller]);

  // Tab Manager
  const tabA = el("div", { className: "tab on", textContent: "Studio" });
  const tabB = el("div", { className: "tab", textContent: "Physics" });
  const tabC = el("div", { className: "tab", textContent: "Internals" });
  const tabs = el("div", { className: "tabs" }, [el("div", { className: "ind" }), tabA, tabB, tabC]);

  const setTab = (i) => {
    S.tab = i;
    tabs.classList.toggle("t1", i === 1);
    tabs.classList.toggle("t2", i === 2);
    [tabA, tabB, tabC].forEach((t, j) => t.classList.toggle("on", j === i));
    [page0, page1, page2].forEach((p, j) => p.classList.toggle("hide", j !== i));
    if (i === 2) renderTable();
  };

  tabA.onclick = () => setTab(0);
  tabB.onclick = () => setTab(1);
  tabC.onclick = () => setTab(2);

  const body = el("div", { className: "b" }, [tabs, page0, page1, page2, status]);
  const panel = el("div", { className: "p" }, [head, body]);

  // =========================================================================
  // 7. FULLSCREEN BLENDER WORKSPACE MODAL
  // =========================================================================
  const cadModal = el("div", { className: "cad-modal hidden" });
  const cadViewport = el("div", { className: "cad-viewport" });
  const cadOutliner = el("div", { className: "cad-outliner-panel" });

  const exitCadBtn = el("button", { className: "cad-btn danger", textContent: "✕ Exit Studio", style: "font-weight:700;" });
  exitCadBtn.onclick = () => {
    CadStudio.isFullscreen = false;
    cadModal.classList.add("hidden");
    host.style.display = "block";
  };

  const syncCadBtn = el("button", { className: "cad-btn", textContent: "✓ Sync to Live Car" });
  syncCadBtn.onclick = () => {
    CadStudio.pushToGame();
    updateStatus("Synced to game vehicle!");
  };

  const topbar = el("div", { className: "cad-topbar" }, [
    el("div", { style: "display:flex;align-items:center;gap:12px;" }, [
      el("span", { style: "font-weight:700;color:#00f0ff;" }, ["FAST ROADS 3D CAD STUDIO"]),
      el("span", { style: "color:#64748b;" }, ["|"]),
      el("span", { id: "cad-active-veh", style: "font-weight:600;" }, ["Model: " + Engine.currentType])
    ]),
    el("div", { style: "display:flex;align-items:center;gap:8px;" }, [
      el("button", { className: "cad-btn", textContent: "↶ Undo", onclick: () => History.undo() }),
      el("button", { className: "cad-btn", textContent: "↷ Redo", onclick: () => History.redo() }),
      syncCadBtn,
      exitCadBtn
    ])
  ]);

  // Blender-style tool overlays
  const toolBtns = {};
  const setCadTool = (t) => {
    S.cadTool = t;
    Object.keys(toolBtns).forEach(k => toolBtns[k].classList.toggle("active", k === t));
    renderCadToolOverlay();
    CadStudio.renderVertexHandles();
  };

  const mkToolBtn = (id, label) => {
    const b = el("button", { className: "tool-btn" + (S.cadTool === id ? " active" : ""), textContent: label });
    b.onclick = () => setCadTool(id);
    toolBtns[id] = b;
    return b;
  };

  const toolShelf = el("div", { className: "cad-tool-shelf" }, [
    mkToolBtn("select", "🖐 Select"),
    mkToolBtn("move", "✥ Move"),
    mkToolBtn("scale", "⤢ Scale"),
    mkToolBtn("rotate", "⟳ Rotate"),
    mkToolBtn("vertex", "⚬ Vertices"),
    mkToolBtn("extrude", "⇪ Extrude"),
    mkToolBtn("insert", "➕ Insert"),
    mkToolBtn("paint", "🎨 Paint")
  ]);

  const toolOptionsBar = el("div", { className: "cad-tool-options" });

  cadViewport.appendChild(toolShelf);
  cadViewport.appendChild(toolOptionsBar);

  const renderCadToolOverlay = () => {
    toolOptionsBar.innerHTML = "";
    const node = CadStudio.selectedNode;

    if (S.cadTool === "select") {
      toolOptionsBar.appendChild(el("span", {}, ["Click any part in 3D to inspect. Selected: " + (node?.name || "None")]));
    } else if (S.cadTool === "move") {
      toolOptionsBar.appendChild(el("span", {}, ["Nudge Coordinates (X, Y, Z):"]));
      [-0.1, 0.1].forEach(amt => {
        const bx = el("button", { className: "cad-btn", textContent: amt > 0 ? "+X" : "-X", onclick: () => { if (node) { node.position.x += amt; CadStudio.pushToGame(); } } });
        const by = el("button", { className: "cad-btn", textContent: amt > 0 ? "+Y" : "-Y", onclick: () => { if (node) { node.position.y += amt; CadStudio.pushToGame(); } } });
        const bz = el("button", { className: "cad-btn", textContent: amt > 0 ? "+Z" : "-Z", onclick: () => { if (node) { node.position.z += amt; CadStudio.pushToGame(); } } });
        toolOptionsBar.appendChild(bx); toolOptionsBar.appendChild(by); toolOptionsBar.appendChild(bz);
      });
    } else if (S.cadTool === "scale") {
      toolOptionsBar.appendChild(el("span", {}, ["Scale Size:"]));
      [-0.1, 0.1].forEach(amt => {
        const bs = el("button", { className: "cad-btn", textContent: amt > 0 ? "+ Scale" : "- Scale", onclick: () => { if (node) { node.scale.multiplyScalar(1 + amt); CadStudio.pushToGame(); } } });
        toolOptionsBar.appendChild(bs);
      });
    } else if (S.cadTool === "rotate") {
      toolOptionsBar.appendChild(el("span", {}, ["Rotate Pitch/Yaw:"]));
      const rx = el("button", { className: "cad-btn", textContent: "Pitch +15°", onclick: () => { if (node) { node.rotation.x += 0.26; CadStudio.pushToGame(); } } });
      const ry = el("button", { className: "cad-btn", textContent: "Yaw +15°", onclick: () => { if (node) { node.rotation.y += 0.26; CadStudio.pushToGame(); } } });
      toolOptionsBar.appendChild(rx); toolOptionsBar.appendChild(ry);
    } else if (S.cadTool === "vertex") {
      toolOptionsBar.appendChild(el("span", {}, ["Vertex Region:"]));
      const regSelect = el("select", { className: "cad-btn" });
      ["all", "front", "rear", "top", "left", "right"].forEach(r => {
        const o = el("option", { value: r, textContent: r.toUpperCase() });
        if (r === S.vRegion) o.selected = true;
        regSelect.appendChild(o);
      });
      regSelect.onchange = (e) => { S.vRegion = e.target.value; };
      toolOptionsBar.appendChild(regSelect);

      const bzP = el("button", { className: "cad-btn", textContent: "+Z Nudge", onclick: () => CadStudio.displaceVertices("z", 0.08) });
      const bzM = el("button", { className: "cad-btn", textContent: "-Z Nudge", onclick: () => CadStudio.displaceVertices("z", -0.08) });
      const byM = el("button", { className: "cad-btn", textContent: "-Y Chop", onclick: () => CadStudio.displaceVertices("y", -0.08) });
      toolOptionsBar.appendChild(bzP); toolOptionsBar.appendChild(bzM); toolOptionsBar.appendChild(byM);
    } else if (S.cadTool === "extrude") {
      toolOptionsBar.appendChild(el("span", {}, ["Extrude Surface Geometry Outward:"]));
      const be = el("button", { className: "cad-btn", textContent: "⇪ Extrude Selection", style: "background:#00f0ff;color:#000;font-weight:700;", onclick: () => CadStudio.extrudeFaces() });
      toolOptionsBar.appendChild(be);
    } else if (S.cadTool === "insert") {
      toolOptionsBar.appendChild(el("span", {}, ["Insert Custom Part:"]));
      const bw = el("button", { className: "cad-btn", textContent: "+ GT Wing", onclick: () => CadStudio.addCADPart("wing") });
      const bs = el("button", { className: "cad-btn", textContent: "+ Splitter", onclick: () => CadStudio.addCADPart("splitter") });
      const bx = el("button", { className: "cad-btn", textContent: "+ Exhaust", onclick: () => CadStudio.addCADPart("exhaust") });
      const bb = el("button", { className: "cad-btn", textContent: "+ Cube", onclick: () => CadStudio.addCADPart("box") });
      toolOptionsBar.appendChild(bw); toolOptionsBar.appendChild(bs); toolOptionsBar.appendChild(bx); toolOptionsBar.appendChild(bb);
    } else if (S.cadTool === "paint") {
      toolOptionsBar.appendChild(el("span", {}, ["Chassis Paint:"]));
      const cInp = el("input", { type: "color", value: S.bodyColor });
      cInp.oninput = (e) => { S.bodyColor = e.target.value; CadStudio.rebuildVehicle(); CadStudio.pushToGame(); };
      toolOptionsBar.appendChild(cInp);

      toolOptionsBar.appendChild(el("span", {}, ["Neon Underglow:"]));
      const nInp = el("input", { type: "color", value: S.neonColor });
      nInp.oninput = (e) => { S.neonColor = e.target.value; CadStudio.assembleNeon(); CadStudio.pushToGame(); };
      toolOptionsBar.appendChild(nInp);
    }
  };

  // Right Outliner Panel in CAD Studio
  const outlinerMeshTree = el("div", { className: "mesh-tree" });
  cadOutliner.appendChild(el("div", { className: "outliner-title", textContent: "Scene Outliner" }));
  cadOutliner.appendChild(outlinerMeshTree);

  const renderOutliner = () => {
    outlinerMeshTree.innerHTML = "";
    if (!CadStudio.vehicleRoot) return;

    const makeItem = (node) => {
      const it = el("div", {
        className: "mesh-item" + (CadStudio.selectedNode === node ? " active" : ""),
        textContent: node.name || "Mesh"
      });
      it.onclick = () => CadStudio.selectMesh(node);
      return it;
    };

    if (CadStudio.chassisMesh) outlinerMeshTree.appendChild(makeItem(CadStudio.chassisMesh));
    CadStudio.wheelMeshes.forEach(w => outlinerMeshTree.appendChild(makeItem(w)));
    CadStudio.customMeshes.forEach(m => outlinerMeshTree.appendChild(makeItem(m)));
  };

  const cadBody = el("div", { className: "cad-body" }, [cadViewport, cadOutliner]);
  cadModal.appendChild(topbar);
  cadModal.appendChild(cadBody);

  launchCadBtn.onclick = () => {
    CadStudio.isFullscreen = true;
    cadModal.classList.remove("hidden");
    host.style.display = "none";
    setTimeout(() => {
      CadStudio.resize();
      renderCadToolOverlay();
      renderOutliner();
    }, 100);
  };

  root.appendChild(el("style", { textContent: css }));
  root.appendChild(mkSvg());
  root.appendChild(panel);
  root.appendChild(cadModal);
  document.body.appendChild(mkSvg());
  document.body.appendChild(host);

  // Initialize Viewport inside Fullscreen Modal Viewport
  CadStudio.init(cadViewport);

  // SVG Glass Map Resizer
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

  // Rubber-Band Drag Physics for Main Panel
  const rubber = (o) => o === 0 ? 0 : Math.sign(o) * 36 * (1 - Math.exp(-Math.abs(o) / 80));
  const ZONE = 70;
  let dx = 0, dy = 0, drag = false;

  head.addEventListener("pointerdown", (e) => {
    if (e.target === minBtn || e.target === closeBtn) return;
    drag = true;
    const r = host.getBoundingClientRect();
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
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

  // Minimize Button (collapses panel into just the glass header pill)
  minBtn.onclick = () => {
    body.classList.toggle("hide");
    minBtn.textContent = body.classList.contains("hide") ? "+" : "–";
    setTimeout(updateMap, 60);
  };

  // Close Button
  closeBtn.onclick = () => {
    host.style.display = "none";
  };

  // Keyboard Shortcuts: Toggle menu with Backslash `\` or Backquote `` ` ``
  window.addEventListener("keydown", (e) => {
    const active = document.activeElement || root.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

    if (e.code === "Escape" && CadStudio.isFullscreen) {
      exitCadBtn.click();
      return;
    }

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

  console.log("%c[FastRoads Studio Ready]%c Press '\\' or '`' to open menu.", "color:#00f0ff;font-weight:bold;", "color:#fff;");
})();