const socket = io();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const FOV = Math.PI / 3;      
const NUM_RAYS = W;
const MAX_DEPTH = 20;

let MAP = [];
let myId = null;
let players = {};
let ammoBoxes = []; 
let medkits = [];   
let rpgWeapon = { active: false, x: 0, y: 0 }; 

const WEAPONS = {
  pistol: { name: 'ПИСТОЛЕТ', maxAmmo: 8, cd: 0.3, dmg: 25, reloadTime: 1.0 },
  rifle: { name: 'АВТОМАТ', maxAmmo: 30, cd: 0.1, dmg: 10, reloadTime: 1.8 },
  rpg: { name: 'РПГ-7 (ОДНОРАЗОВЫЙ)', maxAmmo: 1, cd: 1.0, dmg: 100, reloadTime: 999 }
};

const me = { 
  x: 2.5, y: 2.5, angle: 0, health: 100, alive: true, kills: 0, deaths: 0, name: '',
  currentWeapon: 'pistol', ammo: { pistol: 8, rifle: 30, rpg: 0 }, reserveAmmo: 60, hasRpg: false 
};

let weaponRecoil = 0, muzzleFlashTimer = 0, hitMarkerTimer = 0, shootCooldown = 0, reloadTimer = 0;        
let isMouseDown = false;

let particles = [];       
let damageTexts = [];     
let killerWeaponName = ''; 

// ---------- ВВОД УПРАВЛЕНИЯ ----------
const keys = {};
document.addEventListener('keydown', (e) => { 
  keys[e.code] = true; 
  if (!me.alive) return;

  if (e.code === 'KeyR' && reloadTimer <= 0 && me.currentWeapon !== 'rpg') {
    initiateReload();
  }
  if (e.code === 'Digit1' && me.currentWeapon !== 'pistol' && reloadTimer <= 0) { me.currentWeapon = 'pistol'; shootCooldown = 0.15; }
  if (e.code === 'Digit2' && me.currentWeapon !== 'rifle' && reloadTimer <= 0) { me.currentWeapon = 'rifle'; shootCooldown = 0.15; }
  if (e.code === 'Digit3' && me.hasRpg && me.currentWeapon !== 'rpg' && reloadTimer <= 0) { me.currentWeapon = 'rpg'; shootCooldown = 0.2; }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

canvas.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  } else {
    isMouseDown = true; shoot(); 
  }
});
document.addEventListener('mouseup', () => { isMouseDown = false; });
window.addEventListener('blur', () => { isMouseDown = false; });
document.addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) me.angle += e.movementX * 0.0025; });
// ---------- СЕТЬ ----------
socket.on('init', (data) => {
  myId = data.id; MAP = data.map; players = data.players; ammoBoxes = data.ammoBoxes || []; medkits = data.medkits || [];
  rpgWeapon = data.rpgWeapon || { active: false, x: 0, y: 0 };
  const p = players[myId]; if (p) { me.x = p.x; me.y = p.y; me.angle = p.angle; me.health = p.health; }
  const name = prompt('Введите имя игрока:', 'Игрок') || 'Игрок';
  me.name = name; socket.emit('setName', name);
});

socket.on('state', (serverPlayers) => {
  for (const id in serverPlayers) {
    if (id === myId) {
      me.health = serverPlayers[id].health; me.kills = serverPlayers[id].kills; me.deaths = serverPlayers[id].deaths; me.alive = serverPlayers[id].alive;
      players[id] = { ...serverPlayers[id], x: me.x, y: me.y, angle: me.angle };
    } else { players[id] = serverPlayers[id]; }
  }
});

socket.on('ammoPicked', (data) => {
  const box = ammoBoxes.find(b => b.id === data.boxId); if (box) box.active = false;
  if (data.playerId === myId) me.reserveAmmo = Math.min(180, me.reserveAmmo + 30);
});
socket.on('ammoRespawned', (sBox) => { const box = ammoBoxes.find(b => b.id === sBox.id); if (box) box.active = true; });

socket.on('medkitPicked', (data) => {
  const kit = medkits.find(k => k.id === data.kitId); if (kit) kit.active = false;
  if (data.playerId === myId) me.health = data.health;
});
socket.on('medkitRespawned', (sKit) => { const kit = medkits.find(k => k.id === sKit.id); if (kit) kit.active = true; });

socket.on('rpgPicked', (data) => {
  rpgWeapon.active = false;
  if (data.playerId === myId) { me.hasRpg = true; me.ammo.rpg = 1; me.currentWeapon = 'rpg'; }
});
socket.on('rpgRespawned', (sRpg) => { rpgWeapon.active = true; });
socket.on('playerJoined', (p) => { players[p.id] = p; });
socket.on('playerLeft', (id) => { delete players[id]; });

socket.on('damage', (data) => {
  if (data.targetId === myId) me.health = data.health;
  const target = players[data.targetId];
  if (target) {
    let damageInfo = data.health <= 0 ? 25 : 10; 
    if (data.byId === myId) hitMarkerTimer = 0.15; 
    damageTexts.push({ x: target.x, y: target.y, text: `-${damageInfo}`, timer: 0.6, color: '#e74c3c' });
  }
});

socket.on('rpg_explosion_fx', (data) => { createExplosionParticles(data.x, data.y); });

socket.on('death', (data) => {
  if (data.targetId === myId) {
    me.alive = false; isMouseDown = false;
    
    // Получаем точное имя оружия, переданное сервером из кастомного пакета выстрела врага
    killerWeaponName = data.weaponName || 'НЕИЗВЕСТНОГО ОРУЖИЯ';
    showMessage(`Вас убил ${data.killerName} из ${killerWeaponName}`);
  }
});

socket.on('respawn', (data) => {
  if (data.id === myId) {
    me.x = data.x; me.y = data.y; me.health = 100; me.alive = true;
    me.ammo.pistol = WEAPONS.pistol.maxAmmo; me.ammo.rifle = WEAPONS.rifle.maxAmmo; me.ammo.rpg = 0;
    me.reserveAmmo = 60; me.hasRpg = false; me.currentWeapon = 'pistol'; reloadTimer = 0; shootCooldown = 0; 
    hideMessage();
  }
});

// --- СИСТЕМЫ ЧАСТИЦ ---
function createWallSparks(x, y) {
  for (let i = 0; i < 8; i++) {
    particles.push({
      x: x, y: y,
      vx: (Math.random() - 0.5) * 1.5, vy: (Math.random() - 0.5) * 1.5,
      timer: 0.3 + Math.random() * 0.2,
      color: Math.random() > 0.5 ? '#7f8c8d' : '#d2dae2', 
      size: 2 + Math.random() * 2
    });
  }
}

function createExplosionParticles(x, y) {
  for (let i = 0; i < 40; i++) {
    const angle = Math.random() * Math.PI * 2, speed = 0.5 + Math.random() * 2.5;
    const colors = ['#e74c3c', '#e67e22', '#f1c40f', '#fa8231'];
    particles.push({
      x: x, y: y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      timer: 0.4 + Math.random() * 0.3, color: colors[Math.floor(Math.random() * colors.length)], size: 3 + Math.random() * 5
    });
  }
}
function initiateReload() {
  const wConf = WEAPONS[me.currentWeapon];
  if (me.ammo[me.currentWeapon] < wConf.maxAmmo && me.reserveAmmo > 0) {
    reloadTimer = wConf.reloadTime;
  }
}

function update(dt) {
  if (!me.alive || !MAP.length) return;
  const moveSpeed = 3 * dt, rotSpeed = 2.2 * dt;

  if (weaponRecoil > 0) weaponRecoil -= dt * 8; if (weaponRecoil < 0) weaponRecoil = 0;
  if (shootCooldown > 0) shootCooldown -= dt;
  
  if (reloadTimer > 0) {
    reloadTimer -= dt; const wConf = WEAPONS[me.currentWeapon];
    if (reloadTimer > wConf.reloadTime / 2) weaponRecoil = (wConf.reloadTime - reloadTimer) * 1.5; else weaponRecoil = reloadTimer * 1.5;
    if (reloadTimer <= 0) {
      const needed = wConf.maxAmmo - me.ammo[me.currentWeapon]; const transfer = Math.min(needed, me.reserveAmmo);
      me.ammo[me.currentWeapon] += transfer; me.reserveAmmo -= transfer; weaponRecoil = 0;
    }
  }

  // Автоматический огонь для автомата при удержании ЛКМ
  if (isMouseDown && me.currentWeapon === 'rifle' && shootCooldown <= 0 && reloadTimer <= 0) {
    shoot();
  }

  if (muzzleFlashTimer > 0) muzzleFlashTimer -= dt; if (hitMarkerTimer > 0) hitMarkerTimer -= dt;
  if (keys['ArrowLeft']) me.angle -= rotSpeed; if (keys['ArrowRight']) me.angle += rotSpeed;

  let dx = 0, dy = 0;
  if (keys['KeyW']) { dx += Math.cos(me.angle) * moveSpeed; dy += Math.sin(me.angle) * moveSpeed; }
  if (keys['KeyS']) { dx -= Math.cos(me.angle) * moveSpeed; dy -= Math.sin(me.angle) * moveSpeed; }
  if (keys['KeyA']) { dx += Math.cos(me.angle - Math.PI / 2) * moveSpeed; dy += Math.sin(me.angle - Math.PI / 2) * moveSpeed; }
  if (keys['KeyD']) { dx += Math.cos(me.angle + Math.PI / 2) * moveSpeed; dy += Math.sin(me.angle + Math.PI / 2) * moveSpeed; }

  const newX = me.x + dx, newY = me.y + dy;
  if (!isWall(newX, me.y)) me.x = newX; if (!isWall(me.x, newY)) me.y = newY;

  particles.forEach(p => { p.x += p.vx * dt * 4; p.y += p.vy * dt * 4; p.timer -= dt; });
  particles = particles.filter(p => p.timer > 0);

  damageTexts.forEach(t => { t.timer -= dt; });
  damageTexts = damageTexts.filter(t => t.timer > 0);

  socket.emit('move', { x: me.x, y: me.y, angle: me.angle });
}

function castRay(angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const step = 0.02; let dist = 0; let x = me.x, y = me.y;
  while (dist < MAX_DEPTH) {
    dist += step; x = me.x + cos * dist; y = me.y + sin * dist;
    if (isWall(x, y)) {
      const hitX = x - Math.floor(x), hitY = y - Math.floor(y);
      let wallX = (Math.abs(hitX) < 0.03 || Math.abs(hitX) > 0.97) ? hitY : hitX;
      let isVertical = (Math.abs(hitX) < 0.03 || Math.abs(hitX) > 0.97);
      return { dist, wallX, isVertical, endX: x, endY: y };
    }
  }
  return { dist: MAX_DEPTH, wallX: 0, isVertical: false, endX: x, endY: y };
}
function render() {
  if (!MAP.length) return;

  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, W, H / 2);     
  ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, H / 2, W, H / 2);  

  const depthBuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = me.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    let { dist, wallX, isVertical } = castRay(rayAngle);
    dist *= Math.cos(rayAngle - me.angle); depthBuffer[i] = dist;

    const wallHeight = Math.min(H * 4, H / (dist + 0.0001));
    const startY = Math.floor((H - wallHeight) / 2); const light = Math.max(0, 1 - dist / MAX_DEPTH);
    
    const r = isVertical ? Math.floor(100 * light) : Math.floor(140 * light);
    const g = isVertical ? Math.floor(30 * light) : Math.floor(45 * light);
    const b = isVertical ? Math.floor(15 * light) : Math.floor(25 * light);
    const seamColor = isVertical ? `rgb(${Math.floor(35*light)},${Math.floor(35*light)},${Math.floor(35*light)})` : `rgb(${Math.floor(50*light)},${Math.floor(50*light)},${Math.floor(50*light)})`;

    const grad = ctx.createLinearGradient(0, startY, 0, startY + wallHeight);
    for (let row = 0; row < 8; row++) {
      const startPos = row / 8, endPos = (row + 1) / 8;
      const noise = Math.sin(row * 5 + wallX * 10) > 0;
      grad.addColorStop(startPos, seamColor);       
      grad.addColorStop(startPos + 0.03, noise ? `rgb(${Math.min(255, r+15)},${Math.min(255, g+5)},${b})` : `rgb(${r},${g},${b})`); 
      grad.addColorStop(endPos - 0.03, noise ? `rgb(${Math.min(255, r+15)},${Math.min(255, g+5)},${b})` : `rgb(${r},${g},${b})`);
    }
    ctx.fillStyle = (Math.floor(wallX * 5) % 2 === 0) ? seamColor : grad; ctx.fillRect(i, startY, 1, wallHeight); 
  }

  const sprites = [];
  Object.values(players).forEach(p => { if (p.id !== myId && p.alive) sprites.push({ x: p.x, y: p.y, type: 'player', data: p }); });
  ammoBoxes.forEach(b => { if (b.active) sprites.push({ x: b.x, y: b.y, type: 'ammo', data: b }); });
  medkits.forEach(k => { if (k.active) sprites.push({ x: k.x, y: k.y, type: 'medkit', data: k }); });
  if (rpgWeapon.active) sprites.push({ x: rpgWeapon.x, y: rpgWeapon.y, type: 'rpgDrop', data: rpgWeapon });

  particles.forEach(p => { sprites.push({ x: p.x, y: p.y, type: 'particle', data: p }); });
  damageTexts.forEach(t => { sprites.push({ x: t.x, y: t.y, type: 'damageText', data: t }); });

  sprites.sort((a, b) => Math.hypot(b.x - me.x, b.y - me.y) - Math.hypot(a.x - me.x, a.y - me.y));
  sprites.forEach(s => drawSprite(s, depthBuffer));

  if (me.alive) { drawWeapon(); drawMuzzleFlash(); }
  drawHUD(); drawMinimap(); 
}
function drawSprite(sprite, depthBuffer) {
  const dx = sprite.x - me.x, dy = sprite.y - me.y; const dist = Math.hypot(dx, dy);
  const angleToSprite = normalizeAngle(Math.atan2(dy, dx) - me.angle);
  if (Math.abs(angleToSprite) > FOV / 2 + 0.3) return;
  const screenX = (0.5 + angleToSprite / FOV) * W; const size = Math.min(H * 2, H / (dist + 0.0001)) * 0.6;
  const col = Math.floor(screenX); if (col >= 0 && col < NUM_RAYS && depthBuffer[col] < dist) return;

  ctx.save();
  if (sprite.type === 'player') {
    const cx = screenX, cy = H / 2 + size * 0.1; const w = size * 0.4, h = size * 0.5;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - w / 2, cy - h / 2, w, h); 
    ctx.fillStyle = '#e74c3c'; ctx.fillRect(cx - w / 4, cy - h / 2 - h * 0.2, w / 2, h * 0.2); 
    ctx.fillStyle = '#f1c40f'; ctx.fillRect(cx - w * 0.1, cy - h * 0.2, w * 0.4, h * 0.15); 
    ctx.fillStyle = '#111111'; ctx.fillRect(cx - w * 0.2, cy - h * 0.3, w * 0.1, h * 0.1); 

    ctx.fillStyle = '#fff'; ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.fillText(sprite.data.name || '', screenX, cy - h / 2 - 25);
    const hpWidth = size / 2; ctx.fillStyle = '#222'; ctx.fillRect(screenX - hpWidth / 2, cy - h / 2 - 15, hpWidth, 4);
    ctx.fillStyle = '#2ecc71'; ctx.fillRect(screenX - hpWidth / 2, cy - h / 2 - 15, hpWidth * Math.max(0, (sprite.data.health || 0) / 100), 4);
  } else if (sprite.type === 'ammo') {
    const boxWidth = size * 0.4, boxHeight = size * 0.25; const bx = screenX - boxWidth / 2, by = H / 2 + size * 0.2;
    ctx.fillStyle = '#d35400'; ctx.fillRect(bx, by, boxWidth, boxHeight); ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = Math.max(1, size * 0.02); ctx.strokeRect(bx, by, boxWidth, boxHeight);
    ctx.fillStyle = '#f1c40f'; ctx.font = `bold ${Math.max(8, size * 0.1)}px monospace`; ctx.textAlign = 'center'; ctx.fillText('AMMO', screenX, by + boxHeight * 0.7);
  } else if (sprite.type === 'medkit') {
    const kw = size * 0.35, kh = size * 0.35; const kx = screenX - kw / 2, ky = H / 2 + size * 0.15;
    ctx.fillStyle = '#ecf0f1'; ctx.fillRect(kx, ky, kw, kh); ctx.fillStyle = '#e74c3c'; ctx.fillRect(kx + kw * 0.4, ky + kh * 0.15, kw * 0.2, kh * 0.7); ctx.fillRect(kx + kw * 0.15, ky + kh * 0.4, kw * 0.7, kh * 0.2);
  } else if (sprite.type === 'rpgDrop') {
    const rw = size * 0.5, rh = size * 0.12; const rx = screenX - rw / 2, ry = H / 2 + size * 0.25;
    ctx.fillStyle = '#1e3799'; ctx.fillRect(rx, ry, rw, rh); ctx.fillStyle = '#f1c40f'; ctx.fillRect(rx + rw * 0.7, ry - 3, rw * 0.2, rh + 6);
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(8, size * 0.08)}px monospace`; ctx.textAlign = 'center'; ctx.fillText('RPG-7', screenX, ry - 6);
  } else if (sprite.type === 'particle') {
    const p = sprite.data, pSize = Math.max(1, p.size * (H / (dist + 0.0001)) * 0.01);
    ctx.fillStyle = p.color; ctx.fillRect(screenX - pSize / 2, H / 2 + (size * 0.1) + (Math.sin(p.timer * 10) * 5), pSize, pSize);
  } else if (sprite.type === 'damageText') {
    const t = sprite.data, fontSize = Math.max(10, (H / (dist + 0.0001)) * 0.15);
    ctx.fillStyle = t.color; ctx.font = `bold ${fontSize}px monospace`; ctx.textAlign = 'center'; ctx.fillText(t.text, screenX, H / 2 - size / 2 - 40 - (0.6 - t.timer) * 80);
  }
  ctx.restore();
}

function drawWeapon() {
  const ox = W / 2, oy = H + (weaponRecoil * 35); ctx.save();
  if (reloadTimer > 0) { ctx.fillStyle = '#e74c3c'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center'; ctx.fillText('ПЕРЕЗАРЯДКА...', W / 2, H - 160); }
  if (me.currentWeapon === 'pistol') {
    ctx.fillStyle = '#111111'; ctx.fillRect(ox - 10, oy - 60, 20, 60); ctx.fillStyle = '#7f8c8d'; ctx.fillRect(ox - 8, oy - 110, 16, 60); ctx.fillStyle = '#e74c3c'; ctx.fillRect(ox - 2, oy - 115, 4, 4);
  } else if (me.currentWeapon === 'rifle') {
    ctx.fillStyle = '#111111'; ctx.fillRect(ox - 12, oy - 70, 24, 70); ctx.fillStyle = '#2c3e50'; ctx.fillRect(ox - 8, oy - 145, 16, 85); ctx.fillStyle = '#111111'; ctx.beginPath(); ctx.moveTo(ox - 10, oy - 30); ctx.quadraticCurveTo(ox - 25, oy - 10, ox - 25, oy + 20); ctx.lineTo(ox - 12, oy + 20); ctx.fill();
  } else if (me.currentWeapon === 'rpg') {
    ctx.fillStyle = '#1e3799'; ctx.fillRect(ox - 16, oy - 120, 32, 120); ctx.fillStyle = '#2c3e50'; ctx.fillRect(ox - 5, oy - 160, 10, 40);   
    if (me.ammo.rpg > 0) { ctx.fillStyle = '#f1c40f'; ctx.beginPath(); ctx.moveTo(ox - 15, oy - 160); ctx.lineTo(ox + 15, oy - 160); ctx.lineTo(ox + 25, oy - 185); ctx.lineTo(ox, oy - 210); ctx.lineTo(ox - 25, oy - 185); ctx.fill(); }
  }
  ctx.restore();
}

function drawMuzzleFlash() {
  if (muzzleFlashTimer <= 0) return;
  const isRpg = me.currentWeapon === 'rpg', rad = isRpg ? 60 : (me.currentWeapon === 'pistol' ? 20 : 30);
  const ox = W / 2, oy = H - (isRpg ? 160 : (me.currentWeapon === 'pistol' ? 115 : 145)) + (weaponRecoil * 35);
  ctx.save(); ctx.fillStyle = isRpg ? 'rgba(231, 76, 60, 0.9)' : 'rgba(241, 196, 15, 0.8)'; ctx.beginPath(); ctx.arc(ox, oy, rad, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(ox, oy, rad / 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
function drawMinimap() {
  if (!MAP.length) return;
  const scale = 6, mx = 10, my = 10;
  ctx.save(); ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'; ctx.fillRect(mx, my, MAP.length * scale, MAP.length * scale); ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  for (let r = 0; r < MAP.length; r++) { for (let c = 0; c < MAP[r].length; c++) { if (MAP[r][c] === 1) ctx.fillRect(mx + c * scale, my + r * scale, scale - 1, scale - 1); } }
  ammoBoxes.forEach(b => { if (b.active) { ctx.fillStyle = '#e67e22'; ctx.fillRect(mx + b.x * scale - 1, my + b.y * scale - 1, 3, 3); } });
  medkits.forEach(k => { if (k.active) { ctx.fillStyle = '#2ecc71'; ctx.fillRect(mx + k.x * scale - 1, my + k.y * scale - 1, 3, 3); } });
  if (rpgWeapon.active) { ctx.fillStyle = '#3498db'; ctx.fillRect(mx + rpgWeapon.x * scale - 2, my + rpgWeapon.y * scale - 2, 4, 4); } 
  ctx.fillStyle = '#e74c3c'; Object.values(players).forEach(p => { if (p.id !== myId && p.alive) ctx.fillRect(mx + p.x * scale - 2, my + p.y * scale - 2, 4, 4); });
  const px = mx + me.x * scale, py = my + me.y * scale; ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(me.angle) * 12, py + Math.sin(me.angle) * 12); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function drawHUD() {
  ctx.textAlign = 'left'; ctx.font = '18px monospace'; ctx.fillStyle = '#fff';
  const wConf = WEAPONS[me.currentWeapon]; ctx.fillText(`ОРУЖИЕ: ${wConf.name}`, 10, H - 45);
  if (me.currentWeapon === 'rpg') ctx.fillText(`AMMO: ${me.ammo.rpg} / 1 [ОДНОРАЗОВОЙ]`, 10, H - 20); else ctx.fillText(`AMMO: ${me.ammo[me.currentWeapon]} / ${wConf.maxAmmo} [РЕЗЕРВ: ${me.reserveAmmo}]`, 10, H - 20);
  ctx.fillText('HP: ' + Math.max(0, Math.floor(me.health)), 450, H - 20); ctx.fillText(`K: ${me.kills}  D: ${me.deaths}`, W - 120, H - 20);
  ctx.save(); ctx.strokeStyle = hitMarkerTimer > 0 ? '#e74c3c' : '#fff'; ctx.lineWidth = hitMarkerTimer > 0 ? 3 : 2;
  ctx.beginPath(); ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 + 8, H / 2); ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 + 8); ctx.stroke();
  if (hitMarkerTimer > 0) {
    ctx.strokeStyle = '#e74c3c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W / 2 - 12, H / 2 - 12); ctx.lineTo(W / 2 - 6, H / 2 - 6); ctx.moveTo(W / 2 + 12, H / 2 - 12); ctx.lineTo(W / 2 + 6, H / 2 - 6); ctx.moveTo(W / 2 - 12, H / 2 + 12); ctx.lineTo(W / 2 - 6, H / 2 + 6); ctx.moveTo(W / 2 + 12, H / 2 + 12); ctx.lineTo(W / 2 + 6, H / 2 + 6); ctx.stroke();
  }
  ctx.restore();
}

function shoot() {
  if (!me.alive || shootCooldown > 0 || reloadTimer > 0) return;
  const wConf = WEAPONS[me.currentWeapon];
  
  if (me.currentWeapon === 'rpg') {
    if (me.ammo.rpg <= 0) return;
    me.ammo.rpg = 0; me.hasRpg = false; shootCooldown = WEAPONS.rpg.cd; weaponRecoil = 1.2; muzzleFlashTimer = 0.1;
    const { dist, endX, endY } = castRay(me.angle); let targetId = null, targetDist = dist;
    for (const id in players) {
      if (id === myId || !players[id].alive) continue;
      const p = players[id]; const dx = p.x - me.x, dy = p.y - me.y; const d = Math.hypot(dx, dy); const angleToPlayer = normalizeAngle(Math.atan2(dy, dx) - me.angle);
      if (Math.abs(angleToPlayer) < 0.08 && d < targetDist) { targetId = id; targetDist = d; }
    }
    let explosionX = endX, explosionY = endY; if (targetId) { explosionX = players[targetId].x; explosionY = players[targetId].y; }
    createExplosionParticles(explosionX, explosionY);
    
    socket.emit('shoot', { isRpg: true, explX: explosionX, explY: explosionY, weaponName: wConf.name });
    setTimeout(() => { if (me.alive && me.currentWeapon === 'rpg') me.currentWeapon = 'pistol'; }, 500); return;
  }
  
  const currentAmmo = me.ammo[me.currentWeapon]; if (currentAmmo <= 0) { if (me.currentWeapon !== 'rpg') initiateReload(); return; }
  me.ammo[me.currentWeapon]--; shootCooldown = wConf.cd;
  weaponRecoil = 1.0; muzzleFlashTimer = me.currentWeapon === 'pistol' ? 0.06 : 0.04; 
  const { dist: wallDist, endX, endY } = castRay(me.angle); if (wallDist < MAX_DEPTH) { createWallSparks(endX, endY); }
  
  let best = null, bestDist = Infinity;
  for (const id in players) {
    if (id === myId || !players[id].alive) continue;
    const p = players[id]; const dx = p.x - me.x, dy = p.y - me.y; const d = Math.hypot(dx, dy); const angleToPlayer = normalizeAngle(Math.atan2(dy, dx) - me.angle);
    if (Math.abs(angleToPlayer) < 0.06 && d < wallDist && d < bestDist) { best = id; bestDist = d; }
  }
  
  if (best) socket.emit('shoot', { targetId: best, damage: wConf.dmg, weaponName: wConf.name });
  if (me.ammo[me.currentWeapon] === 0 && me.reserveAmmo > 0) { setTimeout(() => { if (me.alive && me.ammo[me.currentWeapon] === 0) initiateReload(); }, wConf.cd * 1000); }
}

function showMessage(text) { const el = document.getElementById('message'); if (el) { el.textContent = text + ' — возрождение через 3 сек...'; el.style.display = 'block'; } }
function hideMessage() { const el = document.getElementById('message'); if (el) el.style.display = 'none'; }
function normalizeAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

let lastTime = performance.now();
function loop(now) { const dt = Math.min(0.05, (now - lastTime) / 1000); lastTime = now; update(dt); render(); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
