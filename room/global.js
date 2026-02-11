// global.js — FP + salto + colisión tipo Minecraft + móvil
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
    // devuelve la altura Y de la superficie (numero real) en esa celda: 0 si solo suelo
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

  /* -------------------- Movement collision (step-up) -------------------- */
  function canMoveTo(targetX, targetZ, feetY) {
    // approximate collision using nearby block tops and circle collision
    // return { allowed: bool, newFeetY: number }
    const r = playerRadius + 0.05;
    const minX = Math.floor(targetX - r);
    const maxX = Math.floor(targetX + r);
    const minZ = Math.floor(targetZ - r);
    const maxZ = Math.floor(targetZ + r);
    let candidateFeetY = feetY;

    for (let ix = minX; ix <= maxX; ix++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) continue;
        // skip cells outside island circle
        const cx = ix - (SIZE / 2 - 0.5);
        const cz = iz - (SIZE / 2 - 0.5);
        if (Math.sqrt(cx*cx + cz*cz) > ISLAND_RADIUS) continue;

        const top = highestBlockTopAt(ix, iz); // top surface y
        if (top === 0) continue;
        // distance in XZ from player's center to cell center
        const cellCenterX = ix + 0.5;
        const cellCenterZ = iz + 0.5;
        const dx = targetX - cellCenterX;
        const dz = targetZ - cellCenterZ;
        const distSq = dx*dx + dz*dz;
        const minDist = r + Math.SQRT1_2 * 1; // sqrt(0.5^2+0.5^2) ~ cell inscribed
        // Better: check circle vs square (cell)
        const closestX = Math.max(ix, Math.min(targetX, ix+1));
        const closestZ = Math.max(iz, Math.min(targetZ, iz+1));
        const ddx = targetX - closestX;
        const ddz = targetZ - closestZ;
        const d2 = ddx*ddx + ddz*ddz;
        if (d2 < (r * r)) {
          // we'd intersect horizontally; check vertical relationship
          if (top > feetY + stepHeight) {
            // block too high to step onto
            return { allowed: false, newFeetY: feetY };
          } else {
            // can step up onto this block; candidate feetY becomes max
            if (top > candidateFeetY) candidateFeetY = top;
          }
        }
      }
    }
    // allowed; candidateFeetY is possibly raised to step onto blocks
    return { allowed: true, newFeetY: candidateFeetY };
  }

  /* -------------------- Camera setup -------------------- */
  function updateCameraToPlayer() {
    const headPos = new THREE.Vector3(player.position.x, player.position.y + headHeight, player.position.z);
    camera.position.copy(headPos);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.quaternion.copy(quat);
  }

  /* -------------------- Interaction helpers -------------------- */
  function screenToPointDirection(clientX, clientY) {
    if (document.pointerLockElement === canvas) {
      const origin = camera.position.clone();
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      raycaster.set(origin, dir);
    } else {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
    }
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length > 0) return intersects[0].point;
    return null;
  }

  function placeBlockAt(ix, iy, iz) {
    if (ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
    const cx = ix - (SIZE / 2 - 0.5);
    const cz = iz - (SIZE / 2 - 0.5);
    if (Math.sqrt(cx * cx + cz * cz) > ISLAND_RADIUS) return false;
    // don't allow placing inside player's body: check if cell intersects player's capsule
    const px = player.position.x, pz = player.position.z, feetY = player.position.y;
    const playerTop = feetY + playerHeight;
    // if the block's vertical span intersects player's body range, and xz distance < radius+0.5 block -> disallow
    const blockMinY = iy;
    const blockMaxY = iy + 1;
    if (!(blockMaxY <= feetY || blockMinY >= playerTop)) {
      // potential vertical overlap
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
  canvas.addEventListener('click', () => {
    if (isTouchDevice) return;
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  });
  document.addEventListener('pointerlockchange', () => { /* no-op; mousemove checks pointer lock */ });

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

  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const pt = screenToPointDirection(ev.clientX, ev.clientY);
    if (!pt) return;
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);

    if (ev.button === 0) {
      // place on lowest free layer
      let y = 0;
      while (y < 64) {
        const key = `${gx},${y},${gz}`;
        if (!blocks.has(key)) break;
        y++;
      }
      if (y < 64) { placeBlockAt(gx, y, gz); updateStats(); }
    } else if (ev.button === 2) {
      for (let y = 63; y >= 0; y--) {
        const key = `${gx},${y},${gz}`;
        if (blocks.has(key)) { removeBlockAt(gx, y, gz); updateStats(); break; }
      }
    }
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  /* -------------------- Mobile detection + controls (joystick + touch look) -------------------- */
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
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

  /* -------------------- Joystick implementation -------------------- */
  let joyActive = false;
  let joyId = null;
  let joyStart = { x: 0, y: 0 };
  const JOY_RADIUS = 56;

  function joySetKnob(px, py) { joyKnob.style.transform = `translate(${px}px, ${py}px)`; }
  function joyReset() { joyActive = false; joyId = null; input.forward = 0; input.right = 0; joySetKnob(0,0); }

  joyBase.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyActive = true; joyId = t.identifier;
    const rect = joyBase.getBoundingClientRect();
    joyStart.x = rect.left + rect.width / 2;
    joyStart.y = rect.top + rect.height / 2;
    joySetKnob(0,0);
  }, { passive: false });

  joyBase.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    for (let i=0;i<e.changedTouches.length;i++) {
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
    for (let i=0;i<e.changedTouches.length;i++) {
      const t = e.changedTouches[i];
      if (t.identifier === joyId) joyReset();
    }
    e.preventDefault();
  }, { passive: false });

  /* -------------------- Touch look (right half) -------------------- */
  let lookId = null;
  let lastTouch = null;
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
    for (let i=0;i<e.changedTouches.length;i++) {
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchStartLook(t);
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    for (let i=0;i<e.changedTouches.length;i++) {
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchMoveLook(t);
    }
  }, { passive: false });

  window.addEventListener('touchend', (e) => {
    for (let i=0;i<e.changedTouches.length;i++) {
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchEndLook(t);
    }
  }, { passive: false });

  /* -------------------- Mobile buttons -------------------- */
  btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); tryJump(); }, { passive: false });
  btnPlace.addEventListener('touchstart', (e) => { e.preventDefault(); mobilePlace(); }, { passive: false });
  btnRemove.addEventListener('touchstart', (e) => { e.preventDefault(); mobileRemove(); }, { passive: false });

  function mobilePlace() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length === 0) return;
    const pt = intersects[0].point;
    const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
    let y = 0;
    while (y < 64) { if (!blocks.has(`${gx},${y},${gz}`)) break; y++; }
    if (y < 64) { placeBlockAt(gx, y, gz); updateStats(); }
  }
  function mobileRemove() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length === 0) return;
    const pt = intersects[0].point;
    const gx = snapCoord(pt.x), gz = snapCoord(pt.z);
    for (let y = 63; y >= 0; y--) {
      if (blocks.has(`${gx},${y},${gz}`)) { removeBlockAt(gx,y,gz); updateStats(); break; }
    }
  }

  /* -------------------- Jump logic -------------------- */
  function tryJump() {
    if (canJump) {
      velY = JUMP_VELOCITY;
      canJump = false;
    }
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

    // input mapping (desktop keyboard -> input)
    if (!isTouchDevice) {
      input.forward = (keys.w ? -1 : 0) + (keys.s ? 1 : 0);
      input.right = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
    }

    // build desired horizontal movement vector in world coords
    const forwardVec = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const rightVec = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).normalize();

    let move = new THREE.Vector3();
    move.addScaledVector(forwardVec, input.forward);
    move.addScaledVector(rightVec, input.right);
    if (move.lengthSq() > 0) move.normalize();

    // attempt horizontal movement with collision / step-up
    const desiredX = player.position.x + move.x * walkSpeed * dt;
    const desiredZ = player.position.z + move.z * walkSpeed * dt;
    const feetYBefore = player.position.y;
    const canMove = canMoveTo(desiredX, desiredZ, feetYBefore);
    if (canMove.allowed) {
      // apply step-up if needed
      player.position.x = desiredX;
      player.position.z = desiredZ;
      if (canMove.newFeetY > player.position.y) {
        // step up smoothly
        player.position.y = canMove.newFeetY;
        velY = 0;
        canJump = true;
      }
    } else {
      // movement blocked: optionally try sliding along axis X or Z (basic)
      const tryX = canMoveTo(player.position.x + move.x * walkSpeed * dt, player.position.z, player.position.y);
      const tryZ = canMoveTo(player.position.x, player.position.z + move.z * walkSpeed * dt, player.position.y);
      if (tryX.allowed) { player.position.x += move.x * walkSpeed * dt; if (tryX.newFeetY > player.position.y){ player.position.y = tryX.newFeetY; velY = 0; canJump = true; } }
      else if (tryZ.allowed) { player.position.z += move.z * walkSpeed * dt; if (tryZ.newFeetY > player.position.y){ player.position.y = tryZ.newFeetY; velY = 0; canJump = true; } }
      // else fully blocked
    }

    // apply gravity
    velY += GRAVITY * dt;
    player.position.y += velY * dt;

    // compute ground under player (highest block under player's grid cell)
    const cellX = Math.floor(player.position.x);
    const cellZ = Math.floor(player.position.z);
    let groundTop = 0;
    if (cellX >= 0 && cellX < SIZE && cellZ >= 0 && cellZ < SIZE) groundTop = highestBlockTopAt(cellX, cellZ);
    // ensure groundTop at least base plane 0
    groundTop = Math.max(groundTop, 0);

    // collision with ground surface (including blocks)
    const feetY = player.position.y;
    if (feetY <= groundTop + 0.001) {
      player.position.y = groundTop;
      velY = 0;
      canJump = true;
    } else {
      canJump = false;
    }

    // keep player inside island radius (push back)
    const cx = player.position.x - (SIZE / 2 - 0.5);
    const cz = player.position.z - (SIZE / 2 - 0.5);
    const dist = Math.sqrt(cx*cx + cz*cz);
    if (dist > ISLAND_RADIUS - 0.5) {
      const nx = cx / dist; const nz = cz / dist;
      player.position.x = (SIZE / 2 - 0.5) + nx * (ISLAND_RADIUS - 0.5);
      player.position.z = (SIZE / 2 - 0.5) + nz * (ISLAND_RADIUS - 0.5);
    }

    // update camera
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

  // place a few decorative blocks to test stepping
  placeBlockAt(spawnX, 1, spawnZ);
  placeBlockAt(spawnX+1, 1, spawnZ);
  placeBlockAt(spawnX+2, 1, spawnZ);
  updateStats();

  animate(performance.now());

  /* -------------------- Optional: expose toggle for third person view -------------------- */
  window.toggleThirdPerson = function(show) {
    bodyMesh.visible = !!show;
  };

})();
