// IslaFlotante - global.js
(() => {
  const canvas = document.getElementById('c');
  const scene = new THREE.Scene();

  // cielo celeste
  scene.background = new THREE.Color(0x87CEEB); // light sky blue

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.position.set(80, 120, 180);

  // luces: clara
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(100, 200, 100);
  dir.castShadow = true;
  scene.add(dir);

  // controls
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(128, 0, 128);
  controls.maxPolarAngle = Math.PI / 2.1;
  controls.update();

  // parámetros de la isla
  const SIZE = 256; // 256x256
  const CELL = 1;   // tamaño del bloque

  // plataforma de pasto: un plane verde
  const groundGeo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3da84a, roughness: 1 }); // verde pasto
  const ground = new THREE.Mesh(groundGeo, grassMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(SIZE/2 - 0.5, 0, SIZE/2 - 0.5);
  ground.receiveShadow = true;
  scene.add(ground);

  // opcional: borde de isla circular (transparencia suave)
  const islandMask = new THREE.CircleGeometry(SIZE*0.5, 64);
  const maskMat = new THREE.MeshBasicMaterial({ color: 0x3da84a, opacity: 0.95, transparent: true });
  const mask = new THREE.Mesh(islandMask, maskMat);
  mask.rotation.x = -Math.PI / 2;
  mask.position.set(SIZE/2 - 0.5, 0.01, SIZE/2 - 0.5);
  scene.add(mask);

  // rejilla visual para guiar la construcción
  const grid = new THREE.GridHelper(SIZE, SIZE, 0x000000, 0x000000);
  grid.material.opacity = 0.08;
  grid.material.transparent = true;
  grid.position.set(SIZE/2 - 0.5, 0.02, SIZE/2 - 0.5);
  scene.add(grid);

  // cubo "madera" para construir
  const woodColor = 0x8B5A2B; // color madera
  const blockGeo = new THREE.BoxGeometry(CELL, CELL, CELL);
  const woodMat = new THREE.MeshStandardMaterial({ color: woodColor });

  // estructura para guardar bloques colocados: Map keyed por 'x,z,y'
  const blocks = new Map();

  // helper: snap a grid
  function snapCoord(value){
    return Math.floor(value + 0.5);
  }

  // raycaster
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  function screenToGroundPlane(clientX, clientY){
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ( (clientX - rect.left) / rect.width ) * 2 - 1;
    mouse.y = - ( (clientY - rect.top) / rect.height ) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects([ground, mask], false);
    if(intersects.length>0) return intersects[0].point;
    return null;
  }

  // coloca bloque en coordenadas de grilla (x,z)
  function placeBlockAt(ix, iy, iz){
    if(ix < 0 || ix >= SIZE || iz < 0 || iz >= SIZE) return false;
    const key = `${ix},${iy},${iz}`;
    if(blocks.has(key)) return false; // ya hay
    const mesh = new THREE.Mesh(blockGeo, woodMat.clone());
    mesh.position.set(ix + 0.5, iy + 0.5, iz + 0.5);
    mesh.castShadow = true;
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
    statsEl.innerText = `Bloques: ${blocks.size}`;
  }

  // eventos de mouse
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const pt = screenToGroundPlane(ev.clientX, ev.clientY);
    if(!pt) return;
    // calcular celda
    const gx = snapCoord(pt.x);
    const gz = snapCoord(pt.z);

    // buscar altura: coloca en la pila más baja libre (simple)
    // buscamos desde y=1 hasta 64
    if(ev.button === 0){
      // colocar
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
      // borrar: intenta borrar la capa superior
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

  // evitar menú contextual en canvas
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  // handle resize
  window.addEventListener('resize', onWindowResize);
  function onWindowResize(){
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // render loop
  function animate(){
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  // punto de inicio: colocar algunos bloques decorativos cercanos al centro
  const centerX = Math.floor(SIZE/2);
  const centerZ = Math.floor(SIZE/2);
  placeBlockAt(centerX, 1, centerZ);
  placeBlockAt(centerX+1, 1, centerZ);
  placeBlockAt(centerX-1, 1, centerZ);
  updateStats();

  animate();
})();
