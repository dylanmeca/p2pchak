// global.js — FP + salto + colisión tipo Minecraft + colocación por cara + móvil
(() => {
  /* -------------------- Setup basic scene & renderer -------------------- */
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

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.7);
  hemi.position.set(0, 200, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(100, 200, 100);
  dir.castShadow = true;
  dir.shadow.camera.left = -200;
  dir.shadow.camera.right = 200;
  dir.shadow.camera.top = 200;
  dir.shadow.camera.bottom = -200;
  dir.shadow.mapSize.set(2048, 2048);
  scene.add(dir);

  /* -------------------- World parameters -------------------- */
  const SIZE = 256;
  const CELL = 1;
  const ISLAND_RADIUS = SIZE * 0.5 - 2;

  // ground + circular mask
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

  // visual grid
  const grid = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
  grid.material.opacity = 0.06; grid.material.transparent = true;
  grid.position.set(SIZE / 2 - 0.5, 0.03, SIZE / 2 - 0.5);
  scene.add(grid);

  // blocks (wood)
  const woodColor = 0x8B5A2B;
  const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const woodMat = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.8 });
  const blocks = new Map();

  function snapCoord(value) { return Math.floor(value + 0.5); }

  /* -------------------- Player + physics (jump + collisions) -------------------- */
  // Representation: player.position.x/z are world coords, player.position.y = feetY
  const player = new THREE.Object3D();
  player.position.set(Math.floor(SIZE / 2), 0.0, Math.floor(SIZE / 2)); // feet y will be set by ground test
  scene.add(player);

  // visible body (hidden in FP)
  const playerRadius = 0.35;      // radius of player's capsule
  const playerHeight = 1.8;       // total standing height
  const stepHeight = 0.9;         // maximum step-up allowed (≈1 block)
  const headHeight = 1.6;         // camera offset from feet
  const bodyGeo = new THREE.CapsuleGeometry(playerRadius, playerHeight - 2*playerRadius, 8, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.9, roughness: 0.2 });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.visible = false; // keep hidden for FP
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
  bodyMesh.position.set(0, playerHeight/2, 0); // relative to player
  player.add(bodyMesh);

  // vertical physics
  let velY = 0;
  const GRAVITY = -30;
  const JUMP_VELOCITY = 9.2;
  let canJump = false;

  // movement
  const input = { forward: 0, right: 0 };
  const keys = { w: false, a: false, s: false, d: false };
  const walkSpeed = 6;

  // orientation
  let yaw = 0, pitch = 0;
  const pitchLimit = Math.PI / 2 - 0.05;
  const sensitivityMouse = 0.0022;
  const sensitivityTouch = 0.006;

  /* -------------------- Raycaster for interactions -------------------- */
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  /* -------------------- Block queries / utility -------------------- */
  function highestBlockTopAt(ix, iz) {
    if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return 0;
    for (let y = 63; y >= 0; y--) {
      if (blocks.has(`${ix},${y},${iz}`)) {
        return y + 1; // encima del bloque
      }
    }
    return 0; // suelo base
  }

  function isCellOccupied(ix, iy, iz) {
    return blocks.has(`${ix},${iy},${iz}`);
  }

  // dada una malla de bloque, devuelve sus coords enteras ix,iy,iz
  function meshToCell(mesh) {
    return {
      ix: Math.floor(mesh.position.x),
      iy: Math.floor(mesh.position.y),
      iz: Math.floor(mesh.position.z)
    };
  }

  /* -------------------- Movement collision (step-up) -------------------- */
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
        if (Math.sqrt(cx*cx + cz*cz) > ISLAND_RADIUS) continue;

        const top = highestBlockTopAt(ix, iz); // top surface y
        if (top === 0) continue;
        const closestX = Math.max(ix, Math.min(targetX, ix+1));
        const closestZ = Math.max(iz, Math.min(targetZ, iz+1));
        const ddx = targetX - closestX;
        const ddz = targetZ - closestZ;
        const d2 = ddx*ddx + ddz*ddz;
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

  /* -------------------- Camera setup -------------------- */
  function updateCameraToPlayer() {
    const headPos = new THREE.Vector3(player.position.x, player.position.y + headHeight, player.position.z);
    camera.position.copy(headPos);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.quaternion.copy(quat);
  }

  /* -------------------- Interaction helpers: place on face -------------------- */
  function getFirstIntersect(clientX, clientY) {
    // raycast against blocks first, then ground/mask
    const targets = Array.from(blocks.values());
    targets.push(ground, mask);
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    return raycaster.intersectObjects(targets, false);
  }

  function placeAdjacentByFace(intersect) {
    if (!intersect || !intersect.object) return false;
    const obj = intersect.object;
    // if intersect object is not one of block meshes, fallback
    const maybe = meshToCell(obj);
    const keyCandidate = `${maybe.ix},${maybe.iy},${maybe.iz}`;
    if (!blocks.has(keyCandidate)) return false;
    // compute world normal of the face clicked
    const localNormal = intersect.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
    const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();
    // round to integer direction
    const dx = Math.round(worldNormal.x);
    const dy = Math.round(worldNormal.y);
    const dz = Math.round(worldNormal.z);
    const tx = maybe.ix + dx;
    const ty = maybe.iy + dy;
    const tz = maybe.iz + dz;
    // try to place at tx,ty,tz (placeBlockAt will validate bounds & collisions)
    return placeBlockAt(tx, ty, tz);
  }

  function removeMeshIntersect(intersect) {
    if (!intersect || !intersect.object) return false;
    const obj = intersect.object;
    const maybe = meshToCell(obj);
    const keyCandidate = `${maybe.ix},${maybe.iy},${maybe.iz}`;
    if (blocks.has(keyCandidate)) {
      removeBlockAt(maybe.ix, maybe.iy, maybe.iz);
      return true;
    }
    return false;
  }

  /* -------------------- Place / remove functions (same as antes) -------------------- */
  function placeBlockAt(ix, iy, iz) {
    if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
    const cx = ix - (SIZE / 2 - 0.5);
    const cz = iz - (SIZE / 2 - 0.5);
    if (Math.sqrt(cx * cx + cz * cz) > ISLAND_RADIUS) return false;
    // don't allow placing inside player's body
    const px = player.position.x, pz = player.position.z, feetY = player.position.y;
    const playerTop = feetY + playerHeight;
    const blockMinY = iy;
    const blockMaxY = iy + 1;
    if (!(blockMaxY <= feetY || blockMinY >= playerTop)) {
      const closestX = Math.max(ix, Math.min(px, ix + 1));
      const closestZ = Math.max(iz, Math.min(pz, iz + 1));
      const dx = px - closestX;
      const dz = pz - closestZ;
      const d2 = dx*dx + dz*dz;
      if (d2 < (playerRadius * playerRadius)) return false;
    }

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

  /* -------------------- UI updates -------------------- */
  const statsEl = document.getElementById('stats');
  function updateStats() {
    statsEl.innerText = `Bloques: ${blocks.size}\nPosición: ${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)}\nYaw: ${yaw.toFixed(2)} Pitch: ${pitch.toFixed(2)}`;
  }

  /* -------------------- Desktop input (pointer lock + keyboard) -------------------- */
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  canvas.addEventListener('click', () => {
    if (isTouchDevice) return;
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  });
  document.addEventListener('pointerlockchange', () => { /* no-op */ });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); tryJump(); return; }
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

  function onMouseMove(e) {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * sensitivityMouse;
    pitch -= e.movementY * sensitivityMouse;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
  }
  document.addEventListener('mousemove', onMouseMove);

  // pointerdown: place on face if clicked a block; remove block clicked on right-click
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    if (ev.button === 0) {
      // left click: try place adjacent to block face, fallback to lowest free on column
      const rect = renderer.domElement.getBoundingClientRect();
      const intersects = getFirstIntersect(ev.clientX, ev.clientY);
      if (intersects.length > 0) {
        // prefer the first intersect that is a block
        const firstBlockHit = intersects.find(i => {
          const o = i.object;
          const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
          return blocks.has(idx);
        });
        if (firstBlockHit) {
          const placed = placeAdjacentByFace(firstBlockHit);
          if (placed) { updateStats(); return; }
        }
        // else, fallback to ground intersection (first intersect that is ground/mask)
        const groundHit = intersects.find(i => i.object === ground || i.object === mask);
        if (groundHit) {
          const pt = groundHit.point;
          const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
          let y = 0;
          while (y < 64) {
            if (!blocks.has(`${gx},${y},${gz}`)) break;
            y++;
          }
          if (y < 64) { placeBlockAt(gx, y, gz); updateStats(); }
        }
      }
    } else if (ev.button === 2) {
      // right click: if clicked a block, remove that block; else remove top of column
      const intersects = getFirstIntersect(ev.clientX, ev.clientY);
      if (intersects.length > 0) {
        const firstBlockHit = intersects.find(i => {
          const o = i.object;
          const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
          return blocks.has(idx);
        });
        if (firstBlockHit) {
          removeMeshIntersect(firstBlockHit);
          updateStats();
          return;
        }
        const groundHit = intersects.find(i => i.object === ground || i.object === mask);
        if (groundHit) {
          const pt = groundHit.point;
          const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
          for (let y = 63; y >= 0; y--) {
            const key = `${gx},${y},${gz}`;
            if (blocks.has(key)) { removeBlockAt(gx, y, gz); updateStats(); break; }
          }
        }
      }
    }
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  /* -------------------- Mobile controls + look (as before) -------------------- */
  const touchControls = document.getElementById('touch-controls');
  const joyBase = document.getElementById('joy-base');
  const joyKnob = document.getElementById('joy-knob');
  const btnJump = document.getElementById('btn-jump');
  const btnPlace = document.getElementById('btn-place');
  const btnRemove = document.getElementById('btn-remove');
  const hintEl = document.getElementById('hint');

  if (isTouchDevice) {
    touchControls.classList.remove('hidden');
    document.getElementById('crosshair').style.display = 'none';
    hintEl.innerText = 'Touch: joystick izquierdo para mover; arrastra mitad derecha para mirar; botones a la derecha: salto (⤒), colocar (✚), borrar (−).';
  } else {
    touchControls.classList.add('hidden');
  }

  /* Joystick (same as before) */
  let joyActive = false, joyId = null, joyStart = {x:0,y:0};
  const JOY_RADIUS = 56;
  function joySetKnob(px,py){ joyKnob.style.transform = `translate(${px}px, ${py}px)`; }
  function joyReset(){ joyActive=false; joyId=null; input.forward=0; input.right=0; joySetKnob(0,0); }

  joyBase.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyActive = true; joyId = t.identifier;
    const rect = joyBase.getBoundingClientRect();
    joyStart.x = rect.left + rect.width/2; joyStart.y = rect.top + rect.height/2;
    joySetKnob(0,0);
  }, { passive:false });

  joyBase.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    for (let i=0;i<e.changedTouches.length;i++){
      const t = e.changedTouches[i];
      if (t.identifier !== joyId) continue;
      const dx = t.clientX - joyStart.x; const dy = t.clientY - joyStart.y;
      const dist = Math.hypot(dx,dy); const clamped = dist > JOY_RADIUS ? JOY_RADIUS/dist : 1;
      const nx = dx*clamped; const ny = dy*clamped;
      joySetKnob(nx,ny);
      input.forward = -ny / JOY_RADIUS; input.right = nx / JOY_RADIUS;
    }
    e.preventDefault();
  }, { passive:false });

  joyBase.addEventListener('touchend', (e) => {
    for (let i=0;i<e.changedTouches.length;i++){
      const t = e.changedTouches[i];
      if (t.identifier === joyId) joyReset();
    }
    e.preventDefault();
  }, { passive:false });

  /* Touch look (right half) */
  let lookId = null, lastTouch = null;
  function onTouchStartLook(t){ lookId=t.identifier; lastTouch={x:t.clientX,y:t.clientY}; }
  function onTouchMoveLook(t){
    if (lookId !== t.identifier || !lastTouch) return;
    const dx = t.clientX - lastTouch.x, dy = t.clientY - lastTouch.y;
    yaw -= dx * sensitivityTouch; pitch -= dy * sensitivityTouch;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
    lastTouch = {x:t.clientX,y:t.clientY};
  }
  function onTouchEndLook(t){ if (lookId===t.identifier) { lookId=null; lastTouch=null; } }

  window.addEventListener('touchstart', (e)=> {
    for (let i=0;i<e.changedTouches.length;i++){
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchStartLook(t);
    }
  }, { passive:false });

  window.addEventListener('touchmove', (e)=> {
    for (let i=0;i<e.changedTouches.length;i++){
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchMoveLook(t);
    }
  }, { passive:false });

  window.addEventListener('touchend', (e)=> {
    for (let i=0;i<e.changedTouches.length;i++){
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchEndLook(t);
    }
  }, { passive:false });

  /* Mobile buttons: jump/place/remove (updated to face-placement/remove) */
  btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); tryJump(); }, { passive:false });
  btnPlace.addEventListener('touchstart', (e) => { e.preventDefault(); mobilePlace(); }, { passive:false });
  btnRemove.addEventListener('touchstart', (e) => { e.preventDefault(); mobileRemove(); }, { passive:false });

  function mobilePlace() {
    // center ray
    const origin = camera.position.clone();
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    // prepare targets: blocks then ground/mask
    const targets = Array.from(blocks.values()); targets.push(ground, mask);
    const intersects = raycaster.intersectObjects(targets, false);
    if (intersects.length === 0) return;
    const firstBlockHit = intersects.find(i => {
      const o = i.object; const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
      return blocks.has(idx);
    });
    if (firstBlockHit) {
      if (placeAdjacentByFace(firstBlockHit)) { updateStats(); return; }
    }
    // fallback to ground hit
    const groundHit = intersects.find(i => i.object === ground || i.object === mask);
    if (groundHit) {
      const pt = groundHit.point;
      const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
      let y = 0;
      while (y < 64) { if (!blocks.has(`${gx},${y},${gz}`)) break; y++; }
      if (y < 64) { placeBlockAt(gx,y,gz); updateStats(); }
    }
  }

  function mobileRemove() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    const targets = Array.from(blocks.values()); targets.push(ground, mask);
    const intersects = raycaster.intersectObjects(targets, false);
    if (intersects.length === 0) return;
    const firstBlockHit = intersects.find(i => {
      const o = i.object; const idx = `${Math.floor(o.position.x)},${Math.floor(o.position.y)},${Math.floor(o.position.z)}`;
      return blocks.has(idx);
    });
    if (firstBlockHit) { removeMeshIntersect(firstBlockHit); updateStats(); return; }
    const groundHit = intersects.find(i => i.object === ground || i.object === mask);
    if (groundHit) {
      const pt = groundHit.point; const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
      for (let y=63;y>=0;y--) { if (blocks.has(`${gx},${y},${gz}`)) { removeBlockAt(gx,y,gz); updateStats(); break; } }
    }
  }

  /* -------------------- Jump logic -------------------- */
  function tryJump() {
    if (canJump) { velY = JUMP_VELOCITY; canJump = false; }
  }

  /* -------------------- Resize handling -------------------- */
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* -------------------- Render loop & movement with collisions -------------------- */
  let last = performance.now();
  function animate(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // input mapping (keyboard or joystick)
    if (!isTouchDevice) {
      input.forward = (keys.w ? -1 : 0) + (keys.s ? 1 : 0);
      input.right = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
    }

    // movement vector in world coords
    const forwardVec = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const rightVec = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).normalize();

    let move = new THREE.Vector3();
    move.addScaledVector(forwardVec, input.forward);
    move.addScaledVector(rightVec, input.right);
    if (move.lengthSq() > 0) move.normalize();

    // desired position
    const desiredX = player.position.x + move.x * walkSpeed * dt;
    const desiredZ = player.position.z + move.z * walkSpeed * dt;
    const feetYBefore = player.position.y;
    const moveTest = canMoveTo(desiredX, desiredZ, feetYBefore);
    if (moveTest.allowed) {
      player.position.x = desiredX;
      player.position.z = desiredZ;
      if (moveTest.newFeetY > player.position.y) {
        player.position.y = moveTest.newFeetY;
        velY = 0; canJump = true;
      }
    } else {
      const tryX = canMoveTo(player.position.x + move.x * walkSpeed * dt, player.position.z, player.position.y);
      const tryZ = canMoveTo(player.position.x, player.position.z + move.z * walkSpeed * dt, player.position.y);
      if (tryX.allowed) { player.position.x += move.x * walkSpeed * dt; if (tryX.newFeetY > player.position.y){ player.position.y = tryX.newFeetY; velY = 0; canJump = true; } }
      else if (tryZ.allowed) { player.position.z += move.z * walkSpeed * dt; if (tryZ.newFeetY > player.position.y){ player.position.y = tryZ.newFeetY; velY = 0; canJump = true; } }
    }

    // gravity
    velY += GRAVITY * dt;
    player.position.y += velY * dt;

    // compute ground under player (highest block)
    const cellX = Math.floor(player.position.x);
    const cellZ = Math.floor(player.position.z);
    let groundTop = 0;
    if (cellX >= 0 && cellX < SIZE && cellZ >= 0 && cellZ < SIZE) groundTop = highestBlockTopAt(cellX, cellZ);
    groundTop = Math.max(groundTop, 0);

    // ground collision including blocks
    const feetY = player.position.y;
    if (feetY <= groundTop + 0.001) {
      player.position.y = groundTop;
      velY = 0;
      canJump = true;
    } else {
      canJump = false;
    }

    // keep inside island
    const cx = player.position.x - (SIZE / 2 - 0.5);
    const cz = player.position.z - (SIZE / 2 - 0.5);
    const dist = Math.sqrt(cx*cx + cz*cz);
    if (dist > ISLAND_RADIUS - 0.5) {
      const nx = cx / dist; const nz = cz / dist;
      player.position.x = (SIZE / 2 - 0.5) + nx * (ISLAND_RADIUS - 0.5);
      player.position.z = (SIZE / 2 - 0.5) + nz * (ISLAND_RADIUS - 0.5);
    }

    // camera update
    updateCameraToPlayer();

    // render
    renderer.render(scene, camera);
    updateStats();
    requestAnimationFrame(animate);
  }

  // initial spawn: set feet to groundTop for spawn cell
  const spawnX = Math.floor(SIZE / 2), spawnZ = Math.floor(SIZE / 2);
  player.position.x = spawnX + 0.0;
  player.position.z = spawnZ + 0.0;
  player.position.y = Math.max(0, highestBlockTopAt(spawnX, spawnZ));

  // decorative blocks to test stepping
  placeBlockAt(spawnX, 1, spawnZ);
  placeBlockAt(spawnX+1, 1, spawnZ);
  placeBlockAt(spawnX+2, 1, spawnZ);
  updateStats();

  animate(performance.now());

  /* -------------------- Expose helper toggle -------------------- */
  window.toggleThirdPerson = function(show) {
    bodyMesh.visible = !!show;
  };

})();
