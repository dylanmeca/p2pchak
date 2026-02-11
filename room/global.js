// global.js — FP view + salto + adaptaciones móviles (joystick + touch look)
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

  /* -------------------- Player + physics (jump) -------------------- */
  const playerRadius = 0.5;
  const player = new THREE.Object3D(); // represent position; visible sphere hidden for FP
  player.position.set(Math.floor(SIZE / 2), playerRadius, Math.floor(SIZE / 2));
  scene.add(player);

  // optional visible body (hidden in FP)
  const bodyGeo = new THREE.SphereGeometry(playerRadius, 16, 12);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.9, roughness: 0.2 });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
  bodyMesh.visible = false; // keep hidden for FP; can toggle later
  player.add(bodyMesh);

  const HEAD_HEIGHT = 1.6;
  const cameraOffset = new THREE.Vector3(0, HEAD_HEIGHT, 0);

  // vertical physics
  let velY = 0; // vertical velocity
  const GRAVITY = -30; // units/s^2 (tune)
  const JUMP_VELOCITY = 10; // initial jump velocity (tune)
  let canJump = false;

  // movement state
  const input = { forward: 0, right: 0 };
  const keys = { w: false, a: false, s: false, d: false };
  const speed = 6;

  // orientation
  let yaw = 0, pitch = 0;
  const pitchLimit = Math.PI / 2 - 0.05;
  const sensitivityMouse = 0.0022;
  const sensitivityTouch = 0.006;

  /* -------------------- Raycaster for interactions -------------------- */
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function screenToPointDirection(clientX, clientY) {
    if (document.pointerLockElement === canvas) {
      // origin at camera, direction = camera forward
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

  // UI updates
  const statsEl = document.getElementById('stats');
  function updateStats() {
    statsEl.innerText = `Bloques: ${blocks.size}\nPosición: ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)}\nYaw: ${yaw.toFixed(2)} Pitch: ${pitch.toFixed(2)}`;
  }

  /* -------------------- Desktop input: pointer lock + keyboard -------------------- */
  // toggle pointer lock on click
  canvas.addEventListener('click', () => {
    if (isTouchDevice) return; // mobile uses touch
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  });
  document.addEventListener('pointerlockchange', () => {
    // no-op for now; mousemove handler checks pointerLock
  });

  // keyboard controls
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

  // mouse look (desktop)
  function onMouseMove(e) {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * sensitivityMouse;
    pitch -= e.movementY * sensitivityMouse;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
  }
  document.addEventListener('mousemove', onMouseMove);

  // mouse click interactions: place/remove
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    // left = 0 place, right = 2 remove
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

  /* -------------------- Mobile detection + UI -------------------- */
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
    // hide crosshair on mobile
    document.getElementById('crosshair').style.display = 'none';
    hintEl.innerText = 'Touch: joystick izquierdo para mover; arrastra mitad derecha para mirar; botones a la derecha: salto (⤒), colocar (✚), borrar (−).';
  } else {
    // hide mobile controls if not touch
    touchControls.classList.add('hidden');
  }

  /* -------------------- Touch joystick (left side) -------------------- */
  let joyActive = false;
  let joyId = null;
  let joyStart = { x: 0, y: 0 };
  let joyPos = { x: 0, y: 0 };
  const JOY_RADIUS = 56; // knob movement radius in px

  function joySetKnob(px, py) {
    joyKnob.style.transform = `translate(${px}px, ${py}px)`;
  }
  function joyReset() {
    joyActive = false; joyId = null; joyStart = { x: 0, y: 0 }; joyPos = { x: 0, y: 0 };
    joySetKnob(0, 0);
    input.forward = 0; input.right = 0;
  }

  joyBase.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyActive = true; joyId = t.identifier;
    const rect = joyBase.getBoundingClientRect();
    // center knob relative to base center
    joyStart.x = rect.left + rect.width / 2;
    joyStart.y = rect.top + rect.height / 2;
    joyPos = { x: 0, y: 0 };
    joySetKnob(0, 0);
  }, { passive: false });

  joyBase.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier !== joyId) continue;
      const dx = t.clientX - joyStart.x;
      const dy = t.clientY - joyStart.y;
      // clamp to JOY_RADIUS
      const dist = Math.hypot(dx, dy);
      const clamped = dist > JOY_RADIUS ? JOY_RADIUS / dist : 1;
      const nx = dx * clamped;
      const ny = dy * clamped;
      joySetKnob(nx, ny);
      // map to input: forward = -ny, right = nx
      input.forward = -ny / JOY_RADIUS;
      input.right = nx / JOY_RADIUS;
    }
    e.preventDefault();
  }, { passive: false });

  joyBase.addEventListener('touchend', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === joyId) {
        joyReset();
      }
    }
    e.preventDefault();
  }, { passive: false });

  /* -------------------- Touch look (right half) -------------------- */
  let lookId = null;
  let lastTouch = null;
  function onTouchStartLook(t) {
    lookId = t.identifier;
    lastTouch = { x: t.clientX, y: t.clientY };
  }
  function onTouchMoveLook(t) {
    if (lookId !== t.identifier || !lastTouch) return;
    const dx = t.clientX - lastTouch.x;
    const dy = t.clientY - lastTouch.y;
    // sensitivity tuned for touch
    yaw -= dx * sensitivityTouch;
    pitch -= dy * sensitivityTouch;
    pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));
    lastTouch = { x: t.clientX, y: t.clientY };
  }
  function onTouchEndLook(t) {
    if (lookId === t.identifier) { lookId = null; lastTouch = null; }
  }

  // global touch listeners: decide which touch is for look vs joystick by position
  window.addEventListener('touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      // if started on left joystick, it's handled there; otherwise if x > 40% of width -> look
      if (t.clientX > window.innerWidth * 0.4) {
        onTouchStartLook(t);
      }
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) {
        onTouchMoveLook(t);
      }
    }
  }, { passive: false });

  window.addEventListener('touchend', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.clientX > window.innerWidth * 0.4) onTouchEndLook(t);
    }
  }, { passive: false });

  /* -------------------- Mobile buttons: jump / place / remove -------------------- */
  btnJump.addEventListener('touchstart', (e) => { e.preventDefault(); tryJump(); }, { passive: false });
  btnPlace.addEventListener('touchstart', (e) => { e.preventDefault(); mobilePlace(); }, { passive: false });
  btnRemove.addEventListener('touchstart', (e) => { e.preventDefault(); mobileRemove(); }, { passive: false });

  // mobile place/remove use center ray from camera
  function mobilePlace() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length === 0) return;
    const pt = intersects[0].point;
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);
    let y = 0;
    while (y < 64) {
      const key = `${gx},${y},${gz}`;
      if (!blocks.has(key)) break;
      y++;
    }
    if (y < 64) { placeBlockAt(gx, y, gz); updateStats(); }
  }
  function mobileRemove() {
    const origin = camera.position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    raycaster.set(origin, dir);
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length === 0) return;
    const pt = intersects[0].point;
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);
    for (let y = 63; y >= 0; y--) {
      const key = `${gx},${y},${gz}`;
      if (blocks.has(key)) { removeBlockAt(gx, y, gz); updateStats(); break; }
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

  /* -------------------- Render loop & movement update -------------------- */
  let last = performance.now();
  function animate(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // compute movement input: keyboard (desktop) or joystick (mobile)
    if (!isTouchDevice) {
      // keyboard -> input.forward/right in [-1,1]
      const f = (keys.w ? -1 : 0) + (keys.s ? 1 : 0);
      const r = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      input.forward = f;
      input.right = r;
    }
    // Build movement vector relative to yaw
    const forwardVec = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const rightVec = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).normalize();

    let move = new THREE.Vector3();
    move.addScaledVector(forwardVec, input.forward);
    move.addScaledVector(rightVec, input.right);
    if (move.lengthSq() > 0) {
      move.normalize();
      player.position.addScaledVector(move, speed * dt);
    }

    // clamp inside island (keep margin 1)
    let cx = player.position.x - (SIZE / 2 - 0.5);
    let cz = player.position.z - (SIZE / 2 - 0.5);
    let dist = Math.sqrt(cx * cx + cz * cz);
    if (dist > ISLAND_RADIUS - 1) {
      const nx = cx / dist; const nz = cz / dist;
      player.position.x = (SIZE / 2 - 0.5) + nx * (ISLAND_RADIUS - 1);
      player.position.z = (SIZE / 2 - 0.5) + nz * (ISLAND_RADIUS - 1);
    }

    // vertical physics
    velY += GRAVITY * dt;
    player.position.y += velY * dt;

    // simple ground collision: ground plane at y = playerRadius (we do not support standing on blocks for now)
    const groundY = playerRadius;
    if (player.position.y <= groundY) {
      player.position.y = groundY;
      velY = 0;
      canJump = true;
    } else {
      canJump = false;
    }

    // update camera to player head + apply yaw/pitch
    const headPos = new THREE.Vector3(player.position.x, player.position.y + HEAD_HEIGHT, player.position.z);
    // set camera position (no smoothing for instant FP feel)
    camera.position.copy(headPos);

    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.quaternion.copy(quat);

    // render
    renderer.render(scene, camera);
    updateStats();
    requestAnimationFrame(animate);
  }

  // initial decorative blocks in center
  const centerX = Math.floor(SIZE / 2);
  const centerZ = Math.floor(SIZE / 2);
  placeBlockAt(centerX, 1, centerZ);
  placeBlockAt(centerX + 1, 1, centerZ);
  placeBlockAt(centerX - 1, 1, centerZ);
  updateStats();

  animate(last);

  /* -------------------- Extra: optional toggle to show body (third-person) -------------------- */
  // you can expose a function to toggle bodyMesh.visibility if desired:
  window.toggleThirdPerson = function(show) {
    bodyMesh.visible = !!show;
  };

  /* -------------------- Notes & tweaks -------------------- */
  // - Jump strength, gravity and speeds can be tuned at top constants.
  // - We intentionally use simple ground collision (no per-block stepping) for simplicity.
  // - If you later want to stand on blocks, add a block-collision check to compute groundY
  //   as the highest block under the player's x,z grid position.
})();
