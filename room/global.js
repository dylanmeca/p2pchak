// IslaFlotante - global.js
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

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(80, 60, 140);

  // luces: clara
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

  // parámetros de la isla
  const SIZE = 256; // 256x256
  const CELL = 1;   // tamaño del bloque
  const ISLAND_RADIUS = SIZE * 0.5 - 2; // radio util dentro del plane

  // plataforma de pasto: un plane verde
  const groundGeo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3da84a, roughness: 1 }); // verde pasto
  const ground = new THREE.Mesh(groundGeo, grassMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(SIZE/2 - 0.5, 0, SIZE/2 - 0.5);
  ground.receiveShadow = true;
  scene.add(ground);

  // máscara circular para la isla (ligera elevación y borde)
  const islandMask = new THREE.CircleGeometry(ISLAND_RADIUS, 128);
  const maskMat = new THREE.MeshStandardMaterial({ color: 0x32803b, roughness: 1 });
  const mask = new THREE.Mesh(islandMask, maskMat);
  mask.rotation.x = -Math.PI / 2;
  mask.position.set(SIZE/2 - 0.5, 0.02, SIZE/2 - 0.5);
  scene.add(mask);

  // borde visual: niebla sutil
  scene.fog = new THREE.FogExp2(0x87CEEB, 0.0009);

  // rejilla visual
  const grid = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
  grid.material.opacity = 0.06;
  grid.material.transparent = true;
  grid.position.set(SIZE/2 - 0.5, 0.03, SIZE/2 - 0.5);
  scene.add(grid);

  // cubo "madera" para construir
  const woodColor = 0x8B5A2B; // color madera
  const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const woodMat = new THREE.MeshStandardMaterial({ color: woodColor, roughness: 0.8 });

  // estructura para guardar bloques colocados: Map keyed por 'x,y,z'
  const blocks = new Map();

  // helper: snap a grid
  function snapCoord(value){
    return Math.floor(value + 0.5);
  }

  // player (esfera plateada)
  const playerRadius = 0.5;
  const playerGeo = new THREE.SphereGeometry(playerRadius, 24, 18);
  const playerMat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, metalness: 0.9, roughness: 0.2 });
  const player = new THREE.Mesh(playerGeo, playerMat);
  player.castShadow = true;
  player.receiveShadow = true;
  // start center
  player.position.set(Math.floor(SIZE/2), playerRadius, Math.floor(SIZE/2));
  scene.add(player);

  // camera follow parameters
  let camOffset = new THREE.Vector3(0, 25, 60);
  let targetOffset = new THREE.Vector3(0, 10, 0);
  let zoom = 1.0;

  // keyboard state
  const keys = { w:false, a:false, s:false, d:false };
  const speed = 6; // units per second

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

  // raycaster
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function screenToGroundPlane(clientX, clientY){
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ( (clientX - rect.left) / rect.width ) * 2 - 1;
    mouse.y = - ( (clientY - rect.top) / rect.height ) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    // intersect with ground and mask
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if(intersects.length>0) return intersects[0].point;
    return null;
  }

  // coloca bloque en coordenadas de grilla (x,y,z)
  function placeBlockAt(ix, iy, iz){
    if(ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
    // enforce island circular limit
    const cx = ix - (SIZE/2 - 0.5);
    const cz = iz - (SIZE/2 - 0.5);
    if(Math.sqrt(cx*cx + cz*cz) > ISLAND_RADIUS) return false;

    const key = `${ix},${iy},${iz}`;
    if(blocks.has(key)) return false; // ya hay
    const mesh = new THREE.Mesh(blockGeo, woodMat.clone());
    mesh.position.set(ix + 0.5, iy + 0.5, iz + 0.5);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    blocks.set(key, mesh);
    return true;
  }

  function removeBlockAt(ix, iy, iz){
    const key = `${ix},${iy},${iz}`;
    const m = blocks.get(key);
    if(!m) return false;
    scene.remove(m);
    blocks.delete(key);
    return true;
  }

  // UI stats
  const statsEl = document.getElementById('stats');
  function updateStats(){
    statsEl.innerText = `Bloques: ${blocks.size}\nPosición: ${player.position.x.toFixed(1)}, ${player.position.y.toFixed(1)}, ${player.position.z.toFixed(1)}`;
  }

  // eventos de mouse: colocar/borrar
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const pt = screenToGroundPlane(ev.clientX, ev.clientY);
    if(!pt) return;
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);

    if(ev.button === 0){
      // colocar en la capa más baja libre
      let y = 0;
      while(y < 64){
        const key = `${gx},${y},${gz}`;
        if(!blocks.has(key)) break;
        y++;
      }
      if(y >= 64) return;
      placeBlockAt(gx, y, gz);
      updateStats();
    } else if(ev.button === 2){
      // borrar: capa superior
      for(let y = 63; y >= 0; y--){
        const key = `${gx},${y},${gz}`;
        if(blocks.has(key)){
          removeBlockAt(gx, y, gz);
          updateStats();
          break;
        }
      }
    }
  });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // zoom con wheel
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    zoom += delta * 0.08;
    zoom = Math.max(0.4, Math.min(2.2, zoom));
  }, { passive: false });

  // handle resize
  window.addEventListener('resize', onWindowResize);
  function onWindowResize(){
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // render loop
  let last = performance.now();
  function animate(now){
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // player movement (world-axis relative: W: -Z, S: +Z, A: -X, D: +X)
    let dx = 0, dz = 0;
    if(keys.w) dz -= 1;
    if(keys.s) dz += 1;
    if(keys.a) dx -= 1;
    if(keys.d) dx += 1;
    // normalize
    const len = Math.hypot(dx, dz);
    if(len > 0){
      dx /= len; dz /= len;
      player.position.x += dx * speed * dt;
      player.position.z += dz * speed * dt;
    }

    // clamp player within island circle
    const cx = player.position.x - (SIZE/2 - 0.5);
    const cz = player.position.z - (SIZE/2 - 0.5);
    const dist = Math.sqrt(cx*cx + cz*cz);
    if(dist > ISLAND_RADIUS - 1){
      // push back inside
      const nx = cx / dist;
      const nz = cz / dist;
      player.position.x = (SIZE/2 - 0.5) + nx * (ISLAND_RADIUS - 1);
      player.position.z = (SIZE/2 - 0.5) + nz * (ISLAND_RADIUS - 1);
    }

    // keep player on ground
    player.position.y = playerRadius;

    // camera follow: place camera behind player with offset and zoom
    const desiredCam = new THREE.Vector3(
      player.position.x + camOffset.x * zoom,
      player.position.y + camOffset.y * zoom,
      player.position.z + camOffset.z * zoom
    );
    camera.position.lerp(desiredCam, 0.12);
    const lookAt = new THREE.Vector3(player.position.x, player.position.y + targetOffset.y, player.position.z);
    camera.lookAt(lookAt);

    renderer.render(scene, camera);
    updateStats();
    requestAnimationFrame(animate);
  }

  // colocar algunos bloques decorativos cerca del centro
  const centerX = Math.floor(SIZE/2);
  const centerZ = Math.floor(SIZE/2);
  placeBlockAt(centerX, 1, centerZ);
  placeBlockAt(centerX+1, 1, centerZ);
  placeBlockAt(centerX-1, 1, centerZ);
  updateStats();

  animate(last);
})();
