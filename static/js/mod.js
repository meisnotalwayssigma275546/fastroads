/**
 * Fast Roads - Ultimate Feature-Packed Mod Menu (Smart Scanner Edition)
 * Toggle visibility anytime with the [ M ] key
 */
(function() {
    'use strict';

    // Safe HSL to Hex converter
    function hslToHex(h, s, l) {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }

    // Intelligent Vehicle Finder: Scans window properties for vehicle-like structures
    function getVehicles() {
        if (window.vehicles) return window.vehicles;
        if (typeof vehicles !== 'undefined') return vehicles;

        // Deep scan global scope for any object containing physics/wheels metrics
        for (let k in window) {
            try {
                const obj = window[k];
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    for (let subKey in obj) {
                        const item = obj[subKey];
                        if (item && typeof item === 'object' && (item.metrics || item.wheels)) {
                            console.log(`[FastRoads] Auto-detected vehicles at window["${k}"]`);
                            return obj;
                        }
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    function getScene() {
        if (window.scene && window.scene.isScene) return window.scene;
        for (let k in window) {
            try { if (window[k] && window[k].isScene) return window[k]; } catch (e) {}
        }
        return null;
    }

    // Wait for game environment to load
    const initInterval = setInterval(() => {
        const vCheck = getVehicles();
        if (vCheck || document.readyState === 'complete') {
            clearInterval(initInterval);
            startModMenu();
        }
    }, 500);

    function startModMenu() {
        if (document.getElementById('fr-ultimate-menu')) return;

        // 1. INJECT STYLES
        const style = document.createElement('style');
        style.textContent = `
            #fr-ultimate-menu {
                position: fixed;
                top: 20px;
                left: 20px;
                width: 320px;
                max-height: 85vh;
                background: rgba(12, 15, 23, 0.95);
                backdrop-filter: blur(14px);
                border: 1px solid #00f0ff;
                border-radius: 12px;
                color: #f0f0f0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
                box-shadow: 0 10px 35px rgba(0, 240, 255, 0.25);
                z-index: 9999999;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                user-select: none;
            }
            .fr-header {
                padding: 12px;
                background: rgba(0, 240, 255, 0.12);
                border-bottom: 1px solid rgba(0, 240, 255, 0.3);
                text-align: center;
                cursor: move;
            }
            .fr-header h3 {
                margin: 0;
                font-size: 14px;
                color: #00f0ff;
                letter-spacing: 1px;
                text-transform: uppercase;
                pointer-events: none;
            }
            .fr-tabs {
                display: flex;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                background: rgba(0,0,0,0.3);
            }
            .fr-tab {
                flex: 1;
                padding: 8px 4px;
                font-size: 10px;
                text-align: center;
                cursor: pointer;
                color: #888;
                border-bottom: 2px solid transparent;
                transition: all 0.2s;
            }
            .fr-tab.active {
                color: #00f0ff;
                border-bottom-color: #00f0ff;
                background: rgba(0, 240, 255, 0.05);
                font-weight: bold;
            }
            .fr-content {
                padding: 12px;
                overflow-y: auto;
                flex-grow: 1;
                max-height: 60vh;
            }
            .fr-panel { display: none; }
            .fr-panel.active { display: block; }

            .fr-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 10px;
                font-size: 11px;
            }
            .fr-row label { color: #bbb; flex: 1; }
            .fr-row input[type="number"], .fr-row select, .fr-row input[type="color"] {
                width: 110px;
                background: #161922;
                border: 1px solid #333;
                color: #00ffcc;
                padding: 4px;
                border-radius: 4px;
                font-size: 11px;
                text-align: right;
            }
            .fr-row input[type="range"] { width: 110px; accent-color: #00f0ff; }
            .fr-row input[type="checkbox"] { accent-color: #00f0ff; transform: scale(1.2); }

            .fr-btn {
                width: 100%;
                padding: 8px;
                margin-top: 6px;
                background: #00f0ff;
                color: #080a0f;
                border: none;
                border-radius: 6px;
                font-weight: bold;
                font-size: 11px;
                cursor: pointer;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .fr-btn:hover { background: #00c8d6; }
            .fr-btn.secondary-btn {
                background: #222634;
                color: #00f0ff;
                border: 1px solid rgba(0, 240, 255, 0.3);
            }
            .fr-btn.cheat-btn {
                background: linear-gradient(135deg, #ff0055, #ff5500);
                color: #fff;
                margin-bottom: 6px;
            }
            .fr-footer {
                padding: 8px;
                font-size: 9px;
                color: #666;
                text-align: center;
                background: rgba(0,0,0,0.4);
                border-top: 1px solid rgba(255,255,255,0.05);
            }
        `;
        document.head.appendChild(style);

        // 2. INJECT UI HTML
        const menu = document.createElement('div');
        menu.id = 'fr-ultimate-menu';
        menu.innerHTML = `
            <div class="fr-header" id="fr-drag-handle">
                <h3>⚡ Fast Roads Mod Menu</h3>
            </div>
            <div class="fr-tabs">
                <div class="fr-tab active" data-tab="tab-physics">🏎️ Physics</div>
                <div class="fr-tab" data-tab="tab-wheels">🛞 Wheels</div>
                <div class="fr-tab" data-tab="tab-world">🌌 World</div>
                <div class="fr-tab" data-tab="tab-visuals">🎨 Visuals</div>
                <div class="fr-tab" data-tab="tab-cheats">🔥 Cheats</div>
            </div>

            <div class="fr-content">
                <div id="tab-physics" class="fr-panel active">
                    <div class="fr-row">
                        <label>Target Vehicle:</label>
                        <select id="fr-veh-select"></select>
                    </div>
                    <div class="fr-row">
                        <label>Vehicle Enabled:</label>
                        <input type="checkbox" id="fr-enabled">
                    </div>
                    <div class="fr-row">
                        <label>Top Speed:</label>
                        <input type="number" id="fr-topSpeed">
                    </div>
                    <div class="fr-row">
                        <label>Acceleration:</label>
                        <input type="number" id="fr-accel">
                    </div>
                    <div class="fr-row">
                        <label>Mass (kg):</label>
                        <input type="number" id="fr-mass">
                    </div>
                    <div class="fr-row">
                        <label>Aerodynamic Drag:</label>
                        <input type="number" id="fr-drag" step="0.0001">
                    </div>
                    <div class="fr-row">
                        <label>Max Steer Angle:</label>
                        <input type="number" id="fr-maxSteer" step="0.05">
                    </div>
                    <div class="fr-row">
                        <label>Steer Speed:</label>
                        <input type="number" id="fr-steerSpeed" step="0.1">
                    </div>
                    <button class="fr-btn" id="fr-apply-physics">Apply Physics</button>
                    <button class="fr-btn secondary-btn" id="fr-reset-physics">Reset to Default</button>
                </div>

                <div id="tab-wheels" class="fr-panel">
                    <div class="fr-row">
                        <label>Wheel Radius:</label>
                        <input type="number" id="fr-radius" step="0.05">
                    </div>
                    <div class="fr-row">
                        <label>Wheel Width:</label>
                        <input type="number" id="fr-width" step="0.1">
                    </div>
                    <div class="fr-row">
                        <label>Tyre Width:</label>
                        <input type="number" id="fr-tyreWidth" step="0.01">
                    </div>
                    <div class="fr-row">
                        <label>Suspension Travel:</label>
                        <input type="number" id="fr-travel" step="0.01">
                    </div>
                    <div class="fr-row">
                        <label>Axle Height:</label>
                        <input type="number" id="fr-axleHeight" step="0.05">
                    </div>
                    <div class="fr-row">
                        <label>Rock / Body Roll:</label>
                        <input type="number" id="fr-rockFactor" step="0.5">
                    </div>
                    <button class="fr-btn" id="fr-apply-wheels">Apply Wheel Specs</button>
                </div>

                <div id="tab-world" class="fr-panel">
                    <div class="fr-row">
                        <label>Light Intensity:</label>
                        <input type="range" id="fr-light" min="0" max="3" step="0.1" value="1">
                    </div>
                    <div class="fr-row">
                        <label>Fog Density:</label>
                        <input type="range" id="fr-fog" min="0" max="0.05" step="0.001" value="0.005">
                    </div>
                    <div class="fr-row">
                        <label>Global Scale 3D:</label>
                        <input type="number" id="fr-carScale" value="1" step="0.1">
                    </div>
                    <button class="fr-btn" id="fr-apply-world">Update Environment</button>
                </div>

                <div id="tab-visuals" class="fr-panel">
                    <div class="fr-row">
                        <label>Vehicle Paint Color:</label>
                        <input type="color" id="fr-paint" value="#ff0000">
                    </div>
                    <div class="fr-row">
                        <label>Camera Range Mult:</label>
                        <input type="number" id="fr-camRange" value="1" step="0.2">
                    </div>
                    <button class="fr-btn" id="fr-apply-visuals">Apply Visuals</button>
                </div>

                <div id="tab-cheats" class="fr-panel">
                    <button class="fr-btn cheat-btn" id="cheat-superboost">🚀 Hyper Speed Mode</button>
                    <button class="fr-btn cheat-btn" id="cheat-ultragrip">🛑 Ultra Grip (Zero Drift)</button>
                    <button class="fr-btn cheat-btn" id="cheat-moongrav">🌙 Moon Gravity Vehicle</button>
                    <button class="fr-btn cheat-btn" id="cheat-giantwheels">🛞 Monster Truck Wheels</button>
                    <button class="fr-btn cheat-btn" id="cheat-rainbow">🌈 Toggle Rainbow Paint</button>
                </div>
            </div>

            <div class="fr-footer">Press [ M ] to Hide / Show Menu</div>
        `;
        document.body.appendChild(menu);

        // 3. DRAGGABLE WINDOW LOGIC
        const dragHandle = document.getElementById('fr-drag-handle');
        let isDragging = false, startX, startY, initialX, initialY;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = menu.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            menu.style.position = 'fixed';
            menu.style.left = initialX + 'px';
            menu.style.top = initialY + 'px';
            menu.style.right = 'auto';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            menu.style.left = (initialX + (e.clientX - startX)) + 'px';
            menu.style.top = (initialY + (e.clientY - startY)) + 'px';
        });
        window.addEventListener('mouseup', () => { isDragging = false; });

        // Populate Vehicles
        const vehSelect = document.getElementById('fr-veh-select');
        function refreshVehicleList() {
            const vData = getVehicles();
            if (!vData) {
                console.warn("[FastRoads] No vehicle container found in window scope.");
                return;
            }
            const currentVal = vehSelect.value;
            vehSelect.innerHTML = '';
            Object.keys(vData).forEach(key => {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = key;
                vehSelect.appendChild(opt);
            });
            if (vData[currentVal]) vehSelect.value = currentVal;
        }

        // Tab Navigation
        const tabs = menu.querySelectorAll('.fr-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                menu.querySelectorAll('.fr-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');
                if (tab.dataset.tab === 'tab-physics') refreshVehicleList();
            });
        });

        function loadVehicleToUI(name) {
            const vData = getVehicles();
            if (!vData || !vData[name]) return;
            const v = vData[name];
            if (!v.metrics || !v.wheels) return;

            document.getElementById('fr-enabled').checked = !!v.enabled;
            document.getElementById('fr-topSpeed').value = v.metrics.topSpeed || 0;
            document.getElementById('fr-accel').value = v.metrics.accel || 0;
            document.getElementById('fr-mass').value = v.metrics.mass || 0;
            document.getElementById('fr-drag').value = v.metrics.drag || 0;
            document.getElementById('fr-maxSteer').value = v.metrics.maxSteer || 0;
            document.getElementById('fr-steerSpeed').value = v.metrics.steerSpeed || 1.5;

            document.getElementById('fr-radius').value = v.wheels.radius || 0;
            document.getElementById('fr-width').value = v.wheels.width || 0;
            document.getElementById('fr-tyreWidth').value = v.wheels.tyreWidth || 0;
            document.getElementById('fr-travel').value = v.wheels.travel || 0;
            document.getElementById('fr-axleHeight').value = v.metrics.axleHeight || v.wheels.radius || 0;
            document.getElementById('fr-rockFactor').value = v.metrics.rockFactor || 4;
        }

        vehSelect.addEventListener('change', (e) => loadVehicleToUI(e.target.value));
        refreshVehicleList();
        const firstKey = vehSelect.options[0]?.value;
        if (firstKey) loadVehicleToUI(firstKey);

        // Apply Buttons & Cheats handlers...
        document.getElementById('fr-apply-physics').addEventListener('click', () => {
            const vData = getVehicles();
            const key = vehSelect.value;
            if (!vData || !vData[key]) return;
            const v = vData[key];

            v.enabled = document.getElementById('fr-enabled').checked;
            v.metrics.topSpeed = parseFloat(document.getElementById('fr-topSpeed').value) || v.metrics.topSpeed;
            v.metrics.accel = parseFloat(document.getElementById('fr-accel').value) || v.metrics.accel;
            v.metrics.mass = parseFloat(document.getElementById('fr-mass').value) || v.metrics.mass;
            v.metrics.drag = parseFloat(document.getElementById('fr-drag').value) || v.metrics.drag;
            v.metrics.maxSteer = parseFloat(document.getElementById('fr-maxSteer').value) || v.metrics.maxSteer;
            v.metrics.steerSpeed = parseFloat(document.getElementById('fr-steerSpeed').value) || v.metrics.steerSpeed;
            console.log(`[FastRoads] Applied physics to ${key}`);
        });

        document.getElementById('fr-reset-physics').addEventListener('click', () => location.reload());

        document.getElementById('fr-apply-wheels').addEventListener('click', () => {
            const vData = getVehicles();
            const key = vehSelect.value;
            if (!vData || !vData[key]) return;
            const v = vData[key];

            v.wheels.radius = parseFloat(document.getElementById('fr-radius').value) || v.wheels.radius;
            v.wheels.width = parseFloat(document.getElementById('fr-width').value) || v.wheels.width;
            v.wheels.tyreWidth = parseFloat(document.getElementById('fr-tyreWidth').value) || v.wheels.tyreWidth;
            v.wheels.travel = parseFloat(document.getElementById('fr-travel').value) || v.wheels.travel;
            v.metrics.axleHeight = parseFloat(document.getElementById('fr-axleHeight').value) || v.metrics.axleHeight;
            v.metrics.rockFactor = parseFloat(document.getElementById('fr-rockFactor').value) || v.metrics.rockFactor;
            console.log(`[FastRoads] Applied wheels to ${key}`);
        });

        // Cheats buttons
        document.getElementById('cheat-superboost').addEventListener('click', () => {
            const vData = getVehicles();
            if (!vData) return;
            Object.keys(vData).forEach(k => {
                vData[k].metrics.accel = 99999999;
                vData[k].metrics.topSpeed = 999999;
                vData[k].metrics.drag = 0.00001;
            });
            alert("🚀 Hyper Speed Mode Activated!");
        });

        document.getElementById('cheat-ultragrip').addEventListener('click', () => {
            const vData = getVehicles();
            if (!vData) return;
            Object.keys(vData).forEach(k => {
                vData[k].metrics.slipBase = 0;
                vData[k].metrics.slipMod = 0;
            });
            alert("🛑 Ultra Grip Enabled!");
        });

        document.getElementById('cheat-moongrav').addEventListener('click', () => {
            const vData = getVehicles();
            if (!vData) return;
            Object.keys(vData).forEach(k => {
                vData[k].metrics.mass = 30;
                vData[k].wheels.travel = 0.6;
            });
            alert("🌙 Moon Gravity Active!");
        });

        // Toggle via [ M ]
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'm' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) {
                menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
            }
        });
    }
})();