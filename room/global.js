// IslaFlotante - global.js
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
