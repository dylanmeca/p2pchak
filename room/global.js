// IslaFlotante - global.js (primera persona + mouse look)
(() => {
  const canvas = document.getElementById('c');
  const scene = new THREE.Scene();

  // cielo celeste
  const SKY_COLOR = 0x87CEEB;
  scene.background = new THREE.Color(SKY_COLOR);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(SKY_COLOR);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

  // luces
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

  // parámetros isla
  const SIZE = 256;
  const CELL = 1;
  const ISLAND_RADIUS = SIZE * 0.5 - 2;

  // suelo base (plane) y máscara circular de isla
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

  // bloques madera
  const woodColor = 0x8B5A2B;
  const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const woodMat = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.8 });

  // map de bloques
  const blocks = new Map();

  function snapCoord(value){ return Math.floor(value + 0.5); }

  // player: esfera plateada (representación) — estará oculta en primera persona
  const playerRadius = 0.5;
  const playerGeo = new THREE.SphereGeometry(playerRadius, 24, 18);
  const playerMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.9, roughness: 0.2 });
  const player = new THREE.Mesh(playerGeo, playerMat);
  player.castShadow = true; player.receiveShadow = true;
  player.position.set(Math.floor(SIZE / 2), playerRadius, Math.floor(SIZE / 2));
  scene.add(player);

  // primera persona por defecto -> ocultar la esfera (no queremos verla desde FP)
  player.visible = false;

  // cámara colocada en la "cabeza" del jugador
  const HEAD_HEIGHT = 1.6;
  camera.position.set(player.position.x, player.position.y + HEAD_HEIGHT, player.position.z + 0.01);

  // orientación (yaw, pitch) en radianes
  let yaw = 0; // giro en Y
  let pitch = 0; // mirar arriba/abajo
  const pitchLimit = Math.PI / 2 - 0.05;
  const sensitivity = 0.0022;

  // movimiento
  const keys = { w: false, a: false, s: false, d: false };
  const speed = 6; // unidades/segundo

  window.addEventListener('keydown', (e) => {
    if(e.key === 'w' || e.key === 'W') keys.w = true;
    if(e.key === 'a' || e.key === 'A') keys.a = true;
    if(e.key === 's' || e.key === 'S') keys.s = true;
    if(e.key === 'd' || e.key === 'D') keys.d = true;
  });
  window.addEventListener('keyup', (e) => {
    if(e.key === 'w' || e.key === 'W') keys.w = false;
    if(e.key === 'a' || e.key === 'A') keys.a = false;
    if(e.key === 's' || e.key === 'S') keys.s = false;
    if(e.key === 'd' || e.key === 'D') keys.d = false;
  });

  // pointer lock (mouse look)
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  });

  function onPointerLockChange() {
    // nothing special required here for now
  }
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // mouse movement
  function onMouseMove(e) {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    // clamp pitch
    if (pitch > pitchLimit) pitch = pitchLimit;
    if (pitch < -pitchLimit) pitch = -pitchLimit;
  }
  document.addEventListener('mousemove', onMouseMove);

  // raycaster para interacciones
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // screenToGroundPlane: si pointer locked -> ray desde cámara en su dirección,
  // sino -> ray a partir de mouse coords (útil si no se tomó pointer)
  function screenToGroundPlane(clientX, clientY) {
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
    // preferir intersección con ground/mask para obtener columna x,z
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if (intersects.length > 0) return intersects[0].point;
    return null;
  }

  // colocar / quitar bloques por columna apuntada (misma lógica previa)
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

  // UI stats
  const statsEl = document.getElementById('stats');
  function updateStats(){
    statsEl.innerText = `Bloques: ${blocks.size}\nPosición: ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)}\nYaw: ${yaw.toFixed(2)} Pitch: ${pitch.toFixed(2)}`;
  }

  // pointerdown: usar screenToGroundPlane (funciona en pointerlock y fuera)
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    // si no hay pointer lock y botón izquierdo, el primer click ya pidió pointerLock — procesamos la acción también
    const pt = screenToGroundPlane(ev.clientX, ev.clientY);
    if (!pt) return;
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);

    if (ev.button === 0) {
      // colocar en la capa más baja libre
      let y = 0;
      while (y < 64) {
        const key = `${gx},${y},${gz}`;
        if (!blocks.has(key)) break;
        y++;
      }
      if (y < 64) {
        placeBlockAt(gx, y, gz);
        updateStats();
      }
    } else if (ev.button === 2) {
      // borrar: capa superior
      for (let y = 63; y >= 0; y--) {
        const key = `${gx},${y},${gz}`;
        if (blocks.has(key)) {
          removeBlockAt(gx, y, gz);
          updateStats();
          break;
        }
      }
    }
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // zoom con rueda (modifica FOV)
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    camera.fov = THREE.MathUtils.clamp(camera.fov + delta * 2.5, 40, 100);
    camera.updateProjectionMatrix();
  }, { passive: false });

  // resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // render loop y movimiento relativo a yaw
  let last = performance.now();
  function animate(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // compute forward/right in XZ from yaw
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const right = new THREE.Vector3(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)).normalize();

    let moveX = 0, moveZ = 0;
    if (keys.w) { moveZ -= 1; }
    if (keys.s) { moveZ += 1; }
    if (keys.a) { moveX -= 1; }
    if (keys.d) { moveX += 1; }

    if (moveX !== 0 || moveZ !== 0) {
      // direction in XZ plane
      const dir = new THREE.Vector3();
      dir.addScaledVector(forward, moveZ);
      dir.addScaledVector(right, moveX);
      dir.normalize();
      player.position.addScaledVector(dir, speed * dt);
    }

    // clamp player inside island
    const cx = player.position.x - (SIZE / 2 - 0.5);
    const cz = player.position.z - (SIZE / 2 - 0.5);
    const dist = Math.sqrt(cx * cx + cz * cz);
    if (dist > ISLAND_RADIUS - 1) {
      const nx = cx / dist; const nz = cz / dist;
      player.position.x = (SIZE / 2 - 0.5) + nx * (ISLAND_RADIUS - 1);
      player.position.z = (SIZE / 2 - 0.5) + nz * (ISLAND_RADIUS - 1);
    }

    // keep player grounded
    player.position.y = playerRadius;

    // position camera at head and apply yaw/pitch
    const headPos = new THREE.Vector3(player.position.x, player.position.y + HEAD_HEIGHT, player.position.z);
    camera.position.lerp(headPos, 0.6); // smooth follow of head position

    // apply rotation: construct quaternion from yaw/pitch
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    camera.quaternion.slerp(quat, 0.6); // smooth rotation

    renderer.render(scene, camera);
    updateStats();
    requestAnimationFrame(animate);
  }

  // colocar algunos bloques decorativos en el centro
  const centerX = Math.floor(SIZE / 2);
  const centerZ = Math.floor(SIZE / 2);
  placeBlockAt(centerX, 1, centerZ);
  placeBlockAt(centerX + 1, 1, centerZ);
  placeBlockAt(centerX - 1, 1, centerZ);
  updateStats();

  animate(last);
})();
