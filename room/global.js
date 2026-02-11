// global.js (module) — integra Helia + PubSub para chat y sincronización de mundo
// Nota: usa import dinámico para Helia desde CDN; el resto del motor 3D se integra aquí.
// Guarda este archivo como module (ya llamado con type=module en HTML).

(async () => {
  // -------------------- Three.js escena (mantengo lo anterior) --------------------
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

  // luces básicas
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
  hemi.position.set(0, 200, 0);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(100, 200, 100);
  dir.castShadow = true;
  scene.add(dir);

  // parámetros de isla y bloques (como antes)
  const SIZE = 256, CELL = 1, ISLAND_RADIUS = SIZE * 0.5 - 2;
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

  // grid visual
  const grid = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
  grid.material.opacity = 0.06; grid.material.transparent = true;
  grid.position.set(SIZE / 2 - 0.5, 0.03, SIZE / 2 - 0.5);
  scene.add(grid);

  // bloques
  const woodColor = 0x8B5A2B;
  const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const woodMat = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.8 });
  const blocks = new Map(); // key "x,y,z" => mesh
  const seenEventIds = new Set(); // para idempotencia de eventos remotos

  function snapCoord(v){ return Math.floor(v + 0.5); }

  // funciones de colocar/borrar (no cambian mucho)
  function placeBlockAt(ix, iy, iz, opts = {}) {
    if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
    const cx = ix - (SIZE/2 - 0.5), cz = iz - (SIZE/2 - 0.5);
    if (Math.sqrt(cx*cx + cz*cz) > ISLAND_RADIUS) return false;
    const key = `${ix},${iy},${iz}`;
    if (blocks.has(key)) return false;
    const mesh = new THREE.Mesh(blockGeo, woodMat.clone());
    mesh.position.set(ix + 0.5, iy + 0.5, iz + 0.5);
    mesh.castShadow = true; mesh.receiveShadow = true;
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

  // ------------ Chat DOM helpers ------------
  const chatHistoryEl = document.getElementById('chat-history');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const networkStatusEl = document.getElementById('network-status');

  function appendChatLine(userLabel, text, ts = Date.now()){
    const el = document.createElement('div');
    el.className = 'chat-msg';
    const time = new Date(ts).toLocaleTimeString();
    el.innerHTML = `<span class="user">${userLabel}</span><span class="text">${escapeHtml(text)}</span><span class="time">${time}</span>`;
    chatHistoryEl.appendChild(el);
    chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // ------------ Networking: Helia + pubsub ------------
  // topics
  const CHAT_TOPIC = '/isla/flotante/chat/1';
  const WORLD_TOPIC = '/isla/flotante/world/1';
  const PRESENCE_TOPIC = '/isla/flotante/presence/1';

  // We'll import Helia from jsdelivr. Version pinned to a recent release.
  let helia = null;
  let libp2p = null;
  let peerIdShort = null;
  let myPeerId = null;

  // join ordering: map peerId -> firstSeenTs
  const joinTimes = new Map();

  // helper: get display label "U<number>" based on ordering
  function getUserLabel(peerId){
    // sort joinTimes entries by ts then peerId, derive index
    const entries = Array.from(joinTimes.entries()).sort((a,b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[0] < b[0] ? -1 : 1;
    });
    const index = entries.findIndex(e => e[0] === peerId);
    if (index === -1) return peerId.slice(0,6);
    return `U${index+1}`;
  }

  // publish helper (string JSON) to topic
  function publishRaw(topic, obj){
    if (!libp2p || !libp2p.pubsub) {
      console.warn('pubsub not ready yet');
      return;
    }
    try {
      const data = new TextEncoder().encode(JSON.stringify(obj));
      libp2p.pubsub.publish(topic, data).catch(err => {
        console.warn('publish err', err);
      });
    } catch (e){
      console.error('publishRaw err', e);
    }
  }

  // initialize Helia (best-effort)
  async function initHelia(){
    networkStatusEl.innerText = 'Creando nodo Helia...';
    try {
      // import helia from CDN (esm build)
      // note: versión puede actualizarse si lo deseas
      const { createHelia } = await import('https://cdn.jsdelivr.net/npm/helia@6.0.20/dist/index.min.mjs');
      helia = await createHelia();
      libp2p = helia.libp2p;
      myPeerId = libp2p.peerId ? String(libp2p.peerId.toString()) : null;
      peerIdShort = myPeerId ? myPeerId.slice(0,6) : 'anon';
      networkStatusEl.innerText = `Nodo Helia listo — peer ${peerIdShort}. Conectando PubSub...`;
      console.log('helia ready', helia);
      // subscribe topics
      await libp2p.pubsub.subscribe(CHAT_TOPIC, onChatMsg);
      await libp2p.pubsub.subscribe(WORLD_TOPIC, onWorldMsg);
      await libp2p.pubsub.subscribe(PRESENCE_TOPIC, onPresenceMsg);
      // announce presence (join)
      publishRaw(PRESENCE_TOPIC, { type: 'join', peerId: myPeerId, ts: Date.now() });
      // also periodically re-announce presence
      setInterval(() => publishRaw(PRESENCE_TOPIC, { type: 'heartbeat', peerId: myPeerId, ts: Date.now() }), 30_000);
      networkStatusEl.innerText = `P2P: subscrito. Esperando peers... (${peerIdShort})`;
    } catch (err) {
      console.error('initHelia err', err);
      networkStatusEl.innerText = 'Error inicializando Helia/pubsub — revisa consola. (puede necesitar relay/bootstrap)';
    }
  }

  // ------------ Handlers para mensajes PubSub ------------
  async function onPresenceMsg({ from, data }) {
    // data is Uint8Array
    try {
      const json = JSON.parse(new TextDecoder().decode(data));
      if (!json || !json.type) return;
      const pid = json.peerId || from || ('p:'+ (from?from.slice(0,6):Math.random().toString(36).slice(2,8)));
      if (!joinTimes.has(pid)) {
        // set first-seen time (use ts if provided)
        const ts = json.ts || Date.now();
        joinTimes.set(pid, ts);
        // append system message
        appendChatLine('system', `${getUserLabel(pid)} se unió (peer ${pid.slice(0,6)})`, ts);
      } else {
        // update heartbeat timestamp if later
        if (json.ts && json.ts > joinTimes.get(pid)) joinTimes.set(pid, json.ts);
      }
      // update chat labels if needed (we can re-render chat if you want)
    } catch (e) {
      console.warn('presence parse err', e);
    }
  }

  async function onChatMsg({ from, data }) {
    try {
      const json = JSON.parse(new TextDecoder().decode(data));
      if (!json || json.type !== 'chat') return;
      const pid = json.from || from;
      // ensure joinTimes has it (if not, set with ts)
      if (!joinTimes.has(pid)) joinTimes.set(pid, json.ts || Date.now());
      const label = getUserLabel(pid);
      appendChatLine(label + ':', json.text, json.ts);
    } catch (e) {
      console.warn('chat parse err', e);
    }
  }

  async function onWorldMsg({ from, data }) {
    try {
      const json = JSON.parse(new TextDecoder().decode(data));
      if (!json || !json.type) return;
      // make event idempotent
      if (json.eventId) {
        if (seenEventIds.has(json.eventId)) return;
        seenEventIds.add(json.eventId);
      }
      // apply world events: add/remove
      if (json.type === 'add') {
        placeBlockAt(json.x, json.y, json.z);
      } else if (json.type === 'remove') {
        removeBlockAt(json.x, json.y, json.z);
      } else if (json.type === 'presenceAnnounce') {
        // optional handling
      }
    } catch (e) {
      console.warn('world parse err', e);
    }
  }

  // ------------ Outbound helpers ------------
  function sendChat(text){
    const msg = {
      type: 'chat',
      from: myPeerId,
      text: text,
      ts: Date.now(),
      id: Math.random().toString(36).slice(2,9)
    };
    appendChatLine(getUserLabel(myPeerId) + ':', text, msg.ts); // local echo
    publishRaw(CHAT_TOPIC, msg);
  }

  function broadcastAddBlock(ix, iy, iz){
    const evt = {
      type: 'add',
      x: ix, y: iy, z: iz,
      from: myPeerId,
      ts: Date.now(),
      eventId: `${myPeerId.slice(0,6)}:${Date.now()}:${Math.random().toString(36).slice(2,6)}`
    };
    // remember locally so we don't re-apply twice
    seenEventIds.add(evt.eventId);
    publishRaw(WORLD_TOPIC, evt);
  }
  function broadcastRemoveBlock(ix, iy, iz){
    const evt = { type:'remove', x:ix,y:iy,z:iz, from:myPeerId, ts:Date.now(), eventId:`${myPeerId.slice(0,6)}:rm:${Date.now()}:${Math.random().toString(36).slice(2,6)}` };
    seenEventIds.add(evt.eventId);
    publishRaw(WORLD_TOPIC, evt);
  }

  // ------------ Wire chat DOM -> send ------------
  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendChat(text);
    chatInput.value = '';
  });

  // ------------ Integrar con los clicks de colocación/borrado existentes ------------
  // Reemplazamos las llamadas locales de placeBlockAt/removeBlockAt para que
  // además hagan broadcast a la red P2P. (Esto permite que otros peers reciban el evento.)
  // Para separar se usa wrapper localPlace/removeLocal, y mantiene la validación previa.

  function localPlaceBlock(ix, iy, iz){
    const ok = placeBlockAt(ix, iy, iz);
    if (ok) broadcastAddBlock(ix, iy, iz);
    return ok;
  }
  function localRemoveBlock(ix, iy, iz){
    const ok = removeBlockAt(ix, iy, iz);
    if (ok) broadcastRemoveBlock(ix, iy, iz);
    return ok;
  }

  // ------------- Raycasting e interacción (mantengo la lógica de colocar por cara) -------------
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  function meshListForRaycast(){
    return Array.from(blocks.values()).concat([ground, mask]);
  }
  function getFirstIntersect(clientX, clientY){
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const targets = meshListForRaycast();
    return raycaster.intersectObjects(targets, false);
  }
  // helper to compute mesh cell coords
  function meshToCell(mesh){
    return { ix: Math.floor(mesh.position.x), iy: Math.floor(mesh.position.y), iz: Math.floor(mesh.position.z) };
  }
  function placeAdjacentByFace(intersect){
    if (!intersect || !intersect.object) return false;
    const obj = intersect.object;
    const maybe = meshToCell(obj);
    const key = `${maybe.ix},${maybe.iy},${maybe.iz}`;
    if (!blocks.has(key)) return false;
    const localNormal = intersect.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
    const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();
    const dx = Math.round(worldNormal.x), dy = Math.round(worldNormal.y), dz = Math.round(worldNormal.z);
    const tx = maybe.ix + dx, ty = maybe.iy + dy, tz = maybe.iz + dz;
    // use localPlaceBlock so it broadcasts
    return localPlaceBlock(tx, ty, tz);
  }
  function removeMeshIntersect(intersect){
    if (!intersect || !intersect.object) return false;
    const obj = intersect.object;
    const coords = meshToCell(obj);
    return localRemoveBlock(coords.ix, coords.iy, coords.iz);
  }

  // pointer interactions: left place right remove
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const intersects = getFirstIntersect(ev.clientX, ev.clientY);
    if (ev.button === 0) {
      if (intersects.length > 0) {
        const firstBlockHit = intersects.find(i => blocks.has(`${Math.floor(i.object.position.x)},${Math.floor(i.object.position.y)},${Math.floor(i.object.position.z)}`));
        if (firstBlockHit) {
          if (placeAdjacentByFace(firstBlockHit)) return;
        }
        const groundHit = intersects.find(i => i.object === ground || i.object === mask);
        if (groundHit) {
          const pt = groundHit.point;
          const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
          let y = 0;
          while (y < 64) { if (!blocks.has(`${gx},${y},${gz}`)) break; y++; }
          if (y < 64) { localPlaceBlock(gx, y, gz); }
        }
      }
    } else if (ev.button === 2) {
      if (intersects.length > 0) {
        const firstBlockHit = intersects.find(i => blocks.has(`${Math.floor(i.object.position.x)},${Math.floor(i.object.position.y)},${Math.floor(i.object.position.z)}`));
        if (firstBlockHit) { removeMeshIntersect(firstBlockHit); return; }
        const groundHit = intersects.find(i => i.object === ground || i.object === mask);
        if (groundHit) {
          const pt = groundHit.point;
          const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
          for (let y=63;y>=0;y--){ if (blocks.has(`${gx},${y},${gz}`)){ localRemoveBlock(gx,y,gz); break; } }
        }
      }
    }
  });
  renderer.domElement.addEventListener('contextmenu', (e)=> e.preventDefault());

  // ------------- Init Helia and start -------------
  await initHelia();

  // ------------- Rest of app: (player, movement, camera, animate) -------------
  // For concision aquí reimplemento la versión primera persona con salto y colisiones
  // (puedes pegar la última versión completa que tenías). Por simplicidad, añado spawn y animate básico:

  // simple player (reutiliza lógicas previas: feet y cámara)
  const player = new THREE.Object3D();
  player.position.set(Math.floor(SIZE/2), 0.0, Math.floor(SIZE/2));
  scene.add(player);

  const playerRadius = 0.35, playerHeight = 1.8, headHeight = 1.6;
  let velY = 0, GRAVITY = -30, JUMP_VELOCITY = 9.2, canJump = false;
  const input = { forward:0, right:0 }, keys = { w:false,a:false,s:false,d:false }, walkSpeed = 6;
  let yaw = 0, pitch = 0, pitchLimit = Math.PI/2 - 0.05;
  const sensitivityMouse = 0.0022;
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  // keyboard + mouse look
  window.addEventListener('keydown', (e) => { if (e.code==='Space'){ e.preventDefault(); if (canJump){ velY = JUMP_VELOCITY; canJump=false; } } if (e.key==='w'||e.key==='W') keys.w=true; if (e.key==='s'||e.key==='S') keys.s=true; if (e.key==='a'||e.key==='A') keys.a=true; if (e.key==='d'||e.key==='D') keys.d=true; });
  window.addEventListener('keyup', (e)=>{ if (e.key==='w'||e.key==='W') keys.w=false; if (e.key==='s'||e.key==='S') keys.s=false; if (e.key==='a'||e.key==='A') keys.a=false; if (e.key==='d'||e.key==='D') keys.d=false; });
  // pointer lock for desktop
  canvas.addEventListener('click', ()=> { if (!isTouchDevice) canvas.requestPointerLock?.(); });
  document.addEventListener('mousemove', (e)=> { if (document.pointerLockElement === canvas) { yaw -= e.movementX * sensitivityMouse; pitch -= e.movementY * sensitivityMouse; pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch)); } });

  // simple highestBlockTopAt reused
  function highestBlockTopAt(ix, iz){
    if (ix<0||ix>=SIZE||iz<0||iz>=SIZE) return 0;
    for (let y=63; y>=0; y--){ if (blocks.has(`${ix},${y},${iz}`)) return y+1; }
    return 0;
  }

  // movement + gravity loop (simplificado)
  let last = performance.now();
  function animate(now){
    const dt = Math.min(0.05, (now - last)/1000); last = now;
    if (!isTouchDevice) {
      input.forward = (keys.w ? -1:0) + (keys.s ? 1:0);
      input.right = (keys.d ? 1:0) + (keys.a ? -1:0);
    }
    const forwardVec = new THREE.Vector3(Math.sin(yaw),0,Math.cos(yaw)).normalize();
    const rightVec = new THREE.Vector3(Math.sin(yaw+Math.PI/2),0,Math.cos(yaw+Math.PI/2)).normalize();
    let move = new THREE.Vector3();
    move.addScaledVector(forwardVec, input.forward); move.addScaledVector(rightVec, input.right);
    if (move.lengthSq()>0) move.normalize();
    // attempt move without robust collision here for brevity (collision handled in earlier version)
    player.position.addScaledVector(move, walkSpeed * dt);

    // gravity
    velY += GRAVITY * dt;
    player.position.y += velY * dt;
    // ground detection
    const cellX = Math.floor(player.position.x), cellZ = Math.floor(player.position.z);
    let groundTop = 0;
    if (cellX>=0 && cellX<SIZE && cellZ>=0 && cellZ<SIZE) groundTop = highestBlockTopAt(cellX, cellZ);
    if (player.position.y <= groundTop + 0.001) { player.position.y = groundTop; velY = 0; canJump = true; } else { canJump = false; }

    // camera
    const headPos = new THREE.Vector3(player.position.x, player.position.y + headHeight, player.position.z);
    camera.position.copy(headPos);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.quaternion.copy(quat);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate(last);

  // ----------------- startup messages -----------------
  appendChatLine('system', 'Interfaz chat lista. Si la red P2P no ve peers en unos segundos, revisa consola para errores (posible necesidad de relay/bootstrap).');

  // expose some helpers to console for debugging
  window.__helia = { helia, libp2p, publishRaw, CHATS_TOPIC: CHAT_TOPIC, WORLD_TOPIC, PRESENCE_TOPIC };
})();
