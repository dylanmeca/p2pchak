// global.js (module)
// Full implementation: Three ESM, FP + mobile, collision Minecraft-like, face placement,
// chat UI and Helia+PubSub resilient loader with pending queue.
// Requires: global.html (type=module), global.css, chat UI elements present as specified.

import * as THREE from 'https://unpkg.com/three@0.152.0/build/three.module.js';

//////////////////////////////////////////
// Basic scene + renderer
//////////////////////////////////////////
const canvas = document.getElementById('c');
const scene = new THREE.Scene();
const SKY_COLOR = 0x87CEEB;
scene.background = new THREE.Color(SKY_COLOR);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(SKY_COLOR);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

//////////////////////////////////////////
// World parameters and ground
//////////////////////////////////////////
const SIZE = 256;
const CELL = 1;
const ISLAND_RADIUS = SIZE * 0.5 - 2;

const groundGeo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
const grassMat = new THREE.MeshStandardMaterial({ color: 0x3da84a, roughness: 1 });
const ground = new THREE.Mesh(groundGeo, grassMat);
ground.rotation.x = -Math.PI / 2;
ground.position.set(SIZE / 2 - 0.5, 0, SIZE / 2 - 0.5);
ground.receiveShadow = true;
scene.add(ground);

const islandMask = new THREE.CircleGeometry(ISLAND_RADIUS, 128);
const maskMat = new THREE.MeshStandardMaterial({ color: 0x32803b, roughness: 1 });
const mask = new THREE.Mesh(islandMask, maskMat);
mask.rotation.x = -Math.PI / 2;
mask.position.set(SIZE / 2 - 0.5, 0.02, SIZE / 2 - 0.5);
scene.add(mask);

scene.fog = new THREE.FogExp2(SKY_COLOR, 0.0009);

const grid = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
grid.material.opacity = 0.06;
grid.material.transparent = true;
grid.position.set(SIZE / 2 - 0.5, 0.03, SIZE / 2 - 0.5);
scene.add(grid);

//////////////////////////////////////////
// Block data + helpers
//////////////////////////////////////////
const woodColor = 0x8B5A2B;
const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
const woodMat = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.8 });
const blocks = new Map(); // key "ix,iy,iz" => mesh
const seenEventIds = new Set();

function snapCoord(value) { return Math.floor(value + 0.5); }
function meshToCell(mesh) {
  // mesh.position is center at ix+0.5 ; floor returns ix
  return { ix: Math.floor(mesh.position.x), iy: Math.floor(mesh.position.y), iz: Math.floor(mesh.position.z) };
}

function placeBlockAt(ix, iy, iz) {
  if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
  const cx = ix - (SIZE / 2 - 0.5);
  const cz = iz - (SIZE / 2 - 0.5);
  if (Math.sqrt(cx * cx + cz * cz) > ISLAND_RADIUS) return false;
  const key = `${ix},${iy},${iz}`;
  if (blocks.has(key)) return false;
  const mesh = new THREE.Mesh(blockGeo, woodMat.clone());
  mesh.position.set(ix + 0.5, iy + 0.5, iz + 0.5);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  blocks.set(key, mesh);
  return true;
}

function removeBlockAt(ix, iy, iz) {
  const key = `${ix},${iy},${iz}`;
  const m = blocks.get(key);
  if (!m) return false;
  scene.remove(m);
  blocks.delete(key);
  return true;
}

//////////////////////////////////////////
// Chat UI helpers
//////////////////////////////////////////
const chatHistoryEl = document.getElementById('chat-history');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const networkStatusEl = document.getElementById('network-status');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function appendChatLine(userLabel, text, ts = Date.now()) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  const time = new Date(ts).toLocaleTimeString();
  // note: userLabel may already include colon
  el.innerHTML = `<span class="user">${escapeHtml(userLabel)}</span> <span class="text">${escapeHtml(text)}</span><span class="time">${time}</span>`;
  chatHistoryEl.appendChild(el);
  chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
}

chatForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const txt = chatInput.value.trim();
  if (!txt) return;
  sendChat(txt);
  chatInput.value = '';
});

//////////////////////////////////////////
// Networking: Helia + PubSub (resilient)
//////////////////////////////////////////
const CHAT_TOPIC = '/isla/flotante/chat/1';
const WORLD_TOPIC = '/isla/flotante/world/1';
const PRESENCE_TOPIC = '/isla/flotante/presence/1';

let helia = null;
let libp2p = null;
let myPeerId = null;
let peerIdShort = 'anon';
const joinTimes = new Map(); // peerId => firstSeenTs
const pendingPubsub = []; // queue of {topic,obj}

const heliaCandidateUrls = [
  'https://cdn.jsdelivr.net/npm/helia@6/dist/index.browser.mjs',
  'https://cdn.jsdelivr.net/npm/helia@6/dist/index.min.mjs',
  'https://unpkg.com/helia@6/dist/index.browser.mjs',
  'https://unpkg.com/helia@6/dist/index.min.mjs'
];

function publishRaw(topic, obj) {
  if (!libp2p || !libp2p.pubsub) {
    pendingPubsub.push({ topic, obj });
    console.warn('pubsub not ready, queued', obj);
    return;
  }
  try {
    const data = new TextEncoder().encode(JSON.stringify(obj));
    libp2p.pubsub.publish(topic, data).catch(err => console.warn('publish error', err));
  } catch (e) {
    console.error('publishRaw err', e);
  }
}
function flushPendingPubsub() {
  if (!libp2p || !libp2p.pubsub) return;
  while (pendingPubsub.length) {
    const { topic, obj } = pendingPubsub.shift();
    try {
      const data = new TextEncoder().encode(JSON.stringify(obj));
      libp2p.pubsub.publish(topic, data).catch(err => console.warn('flush publish err', err));
    } catch (e) {
      console.warn('flush err', e);
    }
  }
}

function getUserLabel(peerId) {
  const entries = Array.from(joinTimes.entries()).sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0] < b[0] ? -1 : 1;
  });
  const index = entries.findIndex(e => e[0] === peerId);
  if (index === -1) return (peerId && peerId.slice) ? peerId.slice(0, 6) : String(peerId).slice(0, 6);
  return `U${index + 1}`;
}

async function initHelia() {
  networkStatusEl.innerText = 'Iniciando Helia (intentos CDN)...';
  let lastErr = null;
  for (const u of heliaCandidateUrls) {
    try {
      networkStatusEl.innerText = `Importando Helia desde: ${u}`;
      const mod = await import(u);
      // try multiple possible export shapes
      const createHelia = mod.createHelia || mod.default?.createHelia || mod;
      if (!createHelia || typeof createHelia !== 'function') {
        throw new Error('createHelia no encontrado en el módulo Helia importado');
      }
      helia = await createHelia();
      libp2p = helia.libp2p;
      myPeerId = libp2p && libp2p.peerId ? String(libp2p.peerId.toString()) : null;
      peerIdShort = myPeerId ? myPeerId.slice(0, 6) : 'anon';
      networkStatusEl.innerText = `Helia listo — peer ${peerIdShort}. Suscribiendo topics...`;

      if (libp2p && libp2p.pubsub) {
        await libp2p.pubsub.subscribe(CHAT_TOPIC, onChatMsg);
        await libp2p.pubsub.subscribe(WORLD_TOPIC, onWorldMsg);
        await libp2p.pubsub.subscribe(PRESENCE_TOPIC, onPresenceMsg);
        publishRaw(PRESENCE_TOPIC, { type: 'join', peerId: myPeerId, ts: Date.now() });
        setInterval(() => publishRaw(PRESENCE_TOPIC, { type: 'heartbeat', peerId: myPeerId, ts: Date.now() }), 30_000);
        flushPendingPubsub();
        networkStatusEl.innerText = `P2P listo — peer ${peerIdShort}`;
      } else {
        networkStatusEl.innerText = 'Nodo Helia creado, pero pubsub no disponible en libp2p';
      }
      return;
    } catch (err) {
      console.warn('Error intentando Helia desde', u, err);
      lastErr = err;
      continue;
    }
  }
  console.error('No fue posible inicializar Helia desde CDN', lastErr);
  networkStatusEl.innerText = 'No se pudo iniciar Helia/pubsub (modo local).';
  if (!myPeerId) {
    myPeerId = `local-${Math.random().toString(36).slice(2, 8)}`;
    peerIdShort = myPeerId.slice(0, 6);
  }
}

async function onPresenceMsg({ from, data }) {
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    const pid = json.peerId || from || ('p:' + (from ? from.slice(0, 6) : Math.random().toString(36).slice(2, 8)));
    if (!joinTimes.has(pid)) {
      const ts = json.ts || Date.now();
      joinTimes.set(pid, ts);
      appendChatLine('system', `${getUserLabel(pid)} se ha unido (peer ${String(pid).slice(0, 6)})`, ts);
    } else {
      if (json.ts && json.ts > joinTimes.get(pid)) joinTimes.set(pid, json.ts);
    }
  } catch (e) {
    console.warn('presence parse err', e);
  }
}

async function onChatMsg({ from, data }) {
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    if (!json || json.type !== 'chat') return;
    const pid = json.from || from;
    if (!joinTimes.has(pid)) joinTimes.set(pid, json.ts || Date.now());
    appendChatLine(`${getUserLabel(pid)}:`, json.text, json.ts);
  } catch (e) {
    console.warn('chat parse err', e);
  }
}

async function onWorldMsg({ from, data }) {
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    if (!json || !json.type) return;
    if (json.eventId) {
      if (seenEventIds.has(json.eventId)) return;
      seenEventIds.add(json.eventId);
    }
    if (json.type === 'add') {
      placeBlockAt(json.x, json.y, json.z);
    } else if (json.type === 'remove') {
      removeBlockAt(json.x, json.y, json.z);
    }
  } catch (e) {
    console.warn('world parse err', e);
  }
}

function sendChat(text) {
  const pid = myPeerId || (`local-${Math.random().toString(36).slice(2, 8)}`);
  if (!joinTimes.has(pid)) joinTimes.set(pid, Date.now());
  const msg = { type: 'chat', from: pid, text, ts: Date.now(), id: Math.random().toString(36).slice(2, 9) };
  appendChatLine(`${getUserLabel(pid)}:`, text, msg.ts);
  publishRaw(CHAT_TOPIC, msg);
}

function broadcastAddBlock(ix, iy, iz) {
  const pid = myPeerId || (`local-${Math.random().toString(36).slice(2, 8)}`);
  const prefix = (pid && pid.slice) ? pid.slice(0, 6) : String(pid).slice(0, 6);
  const evt = { type: 'add', x: ix, y: iy, z: iz, from: pid, ts: Date.now(), eventId: `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}` };
  seenEventIds.add(evt.eventId);
  publishRaw(WORLD_TOPIC, evt);
}

function broadcastRemoveBlock(ix, iy, iz) {
  const pid = myPeerId || (`local-${Math.random().toString(36).slice(2, 8)}`);
  const prefix = (pid && pid.slice) ? pid.slice(0, 6) : String(pid).slice(0, 6);
  const evt = { type: 'remove', x: ix, y: iy, z: iz, from: pid, ts: Date.now(), eventId: `${prefix}:rm:${Date.now()}:${Math.random().toString(36).slice(2, 6)}` };
  seenEventIds.add(evt.eventId);
  publishRaw(WORLD_TOPIC, evt);
}

function localPlaceBlock(ix, iy, iz) {
  const ok = placeBlockAt(ix, iy, iz);
  if (ok) broadcastAddBlock(ix, iy, iz);
  return ok;
}
function localRemoveBlock(ix, iy, iz) {
  const ok = removeBlockAt(ix, iy, iz);
  if (ok) broadcastRemoveBlock(ix, iy, iz);
  return ok;
}

//////////////////////////////////////////
// Raycasting + placement by face
//////////////////////////////////////////
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function meshListForRaycast() {
  return Array.from(blocks.values()).concat([ground, mask]);
}
function getFirstIntersect(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  return raycaster.intersectObjects(meshListForRaycast(), false);
}
function placeAdjacentByFace(intersect) {
  if (!intersect || !intersect.object) return false;
  const obj = intersect.object;
  const maybe = meshToCell(obj);
  const keyCandidate = `${maybe.ix},${maybe.iy},${maybe.iz}`;
  if (!blocks.has(keyCandidate)) return false;
  const localNormal = intersect.face.normal.clone();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
  const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();
  const dx = Math.round(worldNormal.x), dy = Math.round(worldNormal.y), dz = Math.round(worldNormal.z);
  const tx = maybe.ix + dx, ty = maybe.iy + dy, tz = maybe.iz + dz;
  return localPlaceBlock(tx, ty, tz);
}
function removeMeshIntersect(intersect) {
  if (!intersect || !intersect.object) return false;
  const obj = intersect.object;
  const coords = meshToCell(obj);
  return localRemoveBlock(coords.ix, coords.iy, coords.iz);
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const intersects = getFirstIntersect(ev.clientX, ev.clientY);
  if (ev.button === 0) {
    if (intersects.length > 0) {
      const firstBlockHit = intersects.find(i => {
        const o = i.object;
        const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
        return blocks.has(idx);
      });
      if (firstBlockHit) {
        if (placeAdjacentByFace(firstBlockHit)) return;
      }
      const groundHit = intersects.find(i => i.object === ground || i.object === mask);
      if (groundHit) {
        const pt = groundHit.point;
        const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
        let y = 0;
        while (y < 64) {
          if (!blocks.has(`${gx},${y},${gz}`)) break;
          y++;
        }
        if (y < 64) { localPlaceBlock(gx, y, gz); }
      }
    }
  } else if (ev.button === 2) {
    if (intersects.length > 0) {
      const firstBlockHit = intersects.find(i => {
        const o = i.object;
        const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
        return blocks.has(idx);
      });
      if (firstBlockHit) { removeMeshIntersect(firstBlockHit); return; }
      const groundHit = intersects.find(i => i.object === ground || i.object === mask);
      if (groundHit) {
        const pt = groundHit.point;
        const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
        for (let y = 63; y >= 0; y--) {
          if (blocks.has(`${gx},${y},${gz}`)) { localRemoveBlock(gx, y, gz); break; }
        }
      }
    }
  }
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

//////////////////////////////////////////
// Player physics & collision (Minecraft-like)
//////////////////////////////////////////
const player = new THREE.Object3D();
player.position.set(Math.floor(SIZE / 2), 0.0, Math.floor(SIZE / 2));
scene.add(player);

const playerRadius = 0.35;
const playerHeight = 1.8;
const stepHeight = 0.9; // allow ~1 block
const headHeight = 1.6;
let velY = 0;
const GRAVITY = -30;
const JUMP_VELOCITY = 9.2;
let canJump = false;

const input = { forward: 0, right: 0 };
const keys = { w: false, a: false, s: false, d: false };
const walkSpeed = 6;

let yaw = 0, pitch = 0;
const pitchLimit = Math.PI / 2 - 0.05;
const sensitivityMouse = 0.0022;
const sensitivityTouch = 0.006;
const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

function highestBlockTopAt(ix, iz) {
  if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return 0;
  for (let y = 63; y >= 0; y--) {
    if (blocks.has(`${ix},${y},${iz}`)) return y + 1;
  }
  return 0;
}

function canMoveTo(targetX, targetZ, feetY) {
  const r = playerRadius + 0.05;
  const minX = Math.floor(targetX - r);
  const maxX = Math.floor(targetX + r);
  const minZ = Math.floor(targetZ - r);
  const maxZ = Math.floor(targetZ + r);
  let candidateFeetY = feetY;

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iz = minZ; iz <= maxZ; iz++) {
      if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) continue;
      const cx = ix - (SIZE / 2 - 0.5);
      const cz = iz - (SIZE / 2 - 0.5);
      if (Math.sqrt(cx * cx + cz * cz) > ISLAND_RADIUS) continue;

      const top = highestBlockTopAt(ix, iz);
      if (top === 0) continue;
      const closestX = Math.max(ix, Math.min(targetX, ix + 1));
      const closestZ = Math.max(iz, Math.min(targetZ, iz + 1));
      const ddx = targetX - closestX;
      const ddz = targetZ - closestZ;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < (r * r)) {
        if (top > feetY + stepHeight) {
          return { allowed: false, newFeetY: feetY };
        } else {
          if (top > candidateFeetY) candidateFeetY = top;
        }
      }
    }
  }
  return { allowed: true, newFeetY: candidateFeetY };
}

function updateCameraToPlayer() {
  const headPos = new THREE.Vector3(player.position.x, player.position.y + headHeight, player.position.z);
  camera.position.copy(headPos);
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  camera.quaternion.copy(quat);
}

//////////////////////////////////////////
// Input handling: keyboard, mouse, pointer lock, mobile joystick & look
//////////////////////////////////////////
// keyboard
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); if (canJump) { velY = JUMP_VELOCITY; canJump = false; } return; }
  if (e.key === 'w' || e.key === 'W') keys.w = true;
  if (e.key === 'a' || e.key === 'A') keys.a = true;
  if (e.key === 's' || e.key === 'S') keys.s = true;
  if (e.key === 'd' || e.key === 'D') keys.d = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') keys.w = false;
  if (e.key === 'a' || e.key === 'A') keys.a = false;
  if (e.key === 's' || e.key === 'S') keys.s = false;
  if (e.key === 'd' || e.key === 'D') keys.d = false;
});

// pointer lock + mouse look
canvas.addEventListener('click', () => {
  if (!isTouchDevice) canvas.requestPointerLock?.();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    yaw -= e.movementX * sensitivityMouse;
    pitch -= e.movementY * sensitivityMouse;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
  }
});

// mobile joystick (left) + touch look (right)
const touchControls = document.getElementById('touch-controls');
const joyBase = document.getElementById('joy-base');
const joyKnob = document.getElementById('joy-knob');
const btnJump = document.getElementById('btn-jump');
const btnPlace = document.getElementById('btn-place');
const btnRemove = document.getElementById('btn-remove');
const hintEl = document.getElementById('hint');

if (isTouchDevice && touchControls) {
  touchControls.classList.remove('hidden');
  const cross = document.getElementById('crosshair');
  if (cross) cross.style.display = 'none';
  if (hintEl) hintEl.innerText = 'Touch: joystick izquierdo mover; arrastra derecha para mirar; botones: salto, colocar, borrar.';
} else if (touchControls) {
  touchControls.classList.add('hidden');
}

let joyActive = false, joyId = null, joyStart = { x: 0, y: 0 };
const JOY_RADIUS = 56;
function joySetKnob(px, py) { if (joyKnob) joyKnob.style.transform = `translate(${px}px, ${py}px)`; }
function joyReset() { joyActive = false; joyId = null; input.forward = 0; input.right = 0; joySetKnob(0, 0); }

if (joyBase) {
  joyBase.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyActive = true; joyId = t.identifier;
    const rect = joyBase.getBoundingClientRect();
    joyStart.x = rect.left + rect.width / 2;
    joyStart.y = rect.top + rect.height / 2;
    joySetKnob(0, 0);
  }, { passive: false });

  joyBase.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier !== joyId) continue;
      const dx = t.clientX - joyStart.x;
      const dy = t.clientY - joyStart.y;
      const dist = Math.hypot(dx, dy);
      const clamped = dist > JOY_RADIUS ? JOY_RADIUS / dist : 1;
      const nx = dx * clamped;
      const ny = dy * clamped;
      joySetKnob(nx, ny);
      input.forward = -ny / JOY_RADIUS;
      input.right = nx / JOY_RADIUS;
    }
    e.preventDefault();
  }, { passive: false });

  joyBase.addEventListener('touchend', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === joyId) joyReset();
    }
    e.preventDefault();
  }, { passive: false });
}

// touch look area
let lookId = null, lastTouch = null;
function onTouchStartLook(t) { lookId = t.identifier; lastTouch = { x: t.clientX, y: t.clientY }; }
function onTouchMoveLook(t) {
  if (lookId !== t.identifier || !lastTouch) return;
  const dx = t.clientX - lastTouch.x;
  const dy = t.clientY - lastTouch.y;
  yaw -= dx * sensitivityTouch;
  pitch -= dy * sensitivityTouch;
  pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
  lastTouch = { x: t.clientX, y: t.clientY };
}
function onTouchEndLook(t) { if (lookId === t.identifier) { lookId = null; lastTouch = null; } }

window.addEventListener('touchstart', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.clientX > window.innerWidth * 0.4) onTouchStartLook(t);
  }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.clientX > window.innerWidth * 0.4) onTouchMoveLook(t);
  }
}, { passive: false });

window.addEventListener('touchend', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.clientX > window.innerWidth * 0.4) onTouchEndLook(t);
  }
}, { passive: false });

// mobile buttons
if (btnJump) btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); if (canJump) { velY = JUMP_VELOCITY; canJump = false; } }, { passive: false });
if (btnPlace) btnPlace.addEventListener('touchstart', (e) => { e.preventDefault(); mobilePlace(); }, { passive: false });
if (btnRemove) btnRemove.addEventListener('touchstart', (e) => { e.preventDefault(); mobileRemove(); }, { passive: false });

function mobilePlace() {
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  raycaster.set(origin, dir);
  const targets = meshListForRaycast();
  const intersects = raycaster.intersectObjects(targets, false);
  if (intersects.length === 0) return;
  const firstBlockHit = intersects.find(i => {
    const o = i.object; const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
    return blocks.has(idx);
  });
  if (firstBlockHit) {
    if (placeAdjacentByFace(firstBlockHit)) return;
  }
  const groundHit = intersects.find(i => i.object === ground || i.object === mask);
  if (groundHit) {
    const pt = groundHit.point; const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
    let y = 0; while (y < 64) { if (!blocks.has(`${gx},${y},${gz}`)) break; y++; }
    if (y < 64) { localPlaceBlock(gx, y, gz); }
  }
}
function mobileRemove() {
  const origin = camera.position.clone();
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
  raycaster.set(origin, dir);
  const targets = meshListForRaycast();
  const intersects = raycaster.intersectObjects(targets, false);
  if (intersects.length === 0) return;
  const firstBlockHit = intersects.find(i => {
    const o = i.object; const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
    return blocks.has(idx);
  });
  if (firstBlockHit) { removeMeshIntersect(firstBlockHit); return; }
  const groundHit = intersects.find(i => i.object === ground || i.object === mask);
  if (groundHit) {
    const pt = groundHit.point; const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
    for (let y = 63; y >= 0; y--) { if (blocks.has(`${gx},${y},${gz}`)) { localRemoveBlock(gx, y, gz); break; } }
  }
}

//////////////////////////////////////////
// Animate loop (movement, collisions, camera)
//////////////////////////////////////////
let last = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // input mapping
  if (!isTouchDevice) {
    input.forward = (keys.w ? -1 : 0) + (keys.s ? 1 : 0);
    input.right = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
  }

  const forwardVec = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
  const rightVec = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).normalize();

  let move = new THREE.Vector3();
  move.addScaledVector(forwardVec, input.forward);
  move.addScaledVector(rightVec, input.right);
  if (move.lengthSq() > 0) move.normalize();

  const desiredX = player.position.x + move.x * walkSpeed * dt;
  const desiredZ = player.position.z + move.z * walkSpeed * dt;
  const feetYBefore = player.position.y;
  const moveTest = canMoveTo(desiredX, desiredZ, feetYBefore);
  if (moveTest.allowed) {
    player.position.x = desiredX;
    player.position.z = desiredZ;
    if (moveTest.newFeetY > player.position.y) {
      player.position.y = moveTest.newFeetY;
      velY = 0;
      canJump = true;
    }
  } else {
    const tryX = canMoveTo(player.position.x + move.x * walkSpeed * dt, player.position.z, player.position.y);
    const tryZ = canMoveTo(player.position.x, player.position.z + move.z * walkSpeed * dt, player.position.y);
    if (tryX.allowed) {
      player.position.x += move.x * walkSpeed * dt;
      if (tryX.newFeetY > player.position.y) { player.position.y = tryX.newFeetY; velY = 0; canJump = true; }
    } else if (tryZ.allowed) {
      player.position.z += move.z * walkSpeed * dt;
      if (tryZ.newFeetY > player.position.y) { player.position.y = tryZ.newFeetY; velY = 0; canJump = true; }
    }
  }

  // gravity
  velY += GRAVITY * dt;
  player.position.y += velY * dt;

  // ground detection
  const cellX = Math.floor(player.position.x);
  const cellZ = Math.floor(player.position.z);
  let groundTop = 0;
  if (cellX >= 0 && cellX < SIZE && cellZ >= 0 && cellZ < SIZE) groundTop = highestBlockTopAt(cellX, cellZ);
  groundTop = Math.max(groundTop, 0);

  if (player.position.y <= groundTop + 0.001) {
    player.position.y = groundTop;
    velY = 0;
    canJump = true;
  } else {
    canJump = false;
  }

  // island boundary
  const cx = player.position.x - (SIZE / 2 - 0.5);
  const cz = player.position.z - (SIZE / 2 - 0.5);
  const dist = Math.sqrt(cx * cx + cz * cz);
  if (dist > ISLAND_RADIUS - 0.5) {
    const nx = cx / dist, nz = cz / dist;
    player.position.x = (SIZE / 2 - 0.5) + nx * (ISLAND_RADIUS - 0.5);
    player.position.z = (SIZE / 2 - 0.5) + nz * (ISLAND_RADIUS - 0.5);
  }

  // camera update
  updateCameraToPlayer();

  // render
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

//////////////////////////////////////////
// initial spawn + decorative blocks
//////////////////////////////////////////
player.position.x = Math.floor(SIZE / 2);
player.position.z = Math.floor(SIZE / 2);
player.position.y = Math.max(0, highestBlockTopAt(player.position.x, player.position.z));
placeBlockAt(player.position.x, 1, player.position.z);
placeBlockAt(player.position.x + 1, 1, player.position.z);
placeBlockAt(player.position.x + 2, 1, player.position.z);

updateCameraToPlayer();
appendChatLine('system', 'Escena lista. Intentando iniciar P2P...');

//////////////////////////////////////////
// Start Helia
//////////////////////////////////////////
initHelia().catch(err => {
  console.warn('initHelia final error', err);
  appendChatLine('system', 'No fue posible iniciar Helia desde CDN. P2P no disponible.');
});

// expose for debugging
window._isla = { blocks, publishRaw, placeBlockAt, removeBlockAt, localPlaceBlock, localRemoveBlock, joinTimes, seenEventIds, helia: () => helia };
