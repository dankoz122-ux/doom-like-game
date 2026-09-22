const socket = io();

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const FOV = Math.PI / 3;      // 60 градусов, как в Doom
const NUM_RAYS = W;
const MAX_DEPTH = 20;

let MAP = [];
let myId = null;
let players = {};

// --- ОБЪЕКТ ИГРОКА (ДОБАВЛЕНЫ ПАТРОНЫ) ---
const me = { 
  x: 2.5, y: 2.5, angle: 0, 
  health: 100, alive: true, 
  kills: 0, deaths: 0, name: '',
  ammo: 8, maxAmmo: 8, reserveAmmo: 32 
};

// --- ТАЙМЕРЫ ЭФФЕКТОВ И ГЕЙМПЛЕЯ ---
let weaponRecoil = 0;       // Смещение оружия при отдаче
let muzzleFlashTimer = 0;   // Таймер отрисовки вспышки
let hitMarkerTimer = 0;     // Таймер красного прицела при попадании
let shootCooldown = 0;      // КД между выстрелами
let reloadTimer = 0;        // Таймер блокировки при перезарядке

// ---------- ВВОД ----------
const keys = {};
document.addEventListener('keydown', (e) => { keys[e.code] = true; });
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  } else {
    shoot();
  }
});

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    me.angle += e.movementX * 0.0025;
  }
});

// ---------- СЕТЬ ----------
socket.on('init', (data) => {
  myId = data.id;
  MAP = data.map;
  players = data.players;
  const p = players[myId];
  if (p) { me.x = p.x; me.y = p.y; me.angle = p.angle; me.health = p.health; }

  const name = prompt('Введите имя игрока:', 'Игрок') || 'Игрок';
  me.name = name;
  socket.emit('setName', name);
});

socket.on('state', (serverPlayers) => {
  for (const id in serverPlayers) {
    if (id === myId) {
      me.health = serverPlayers[id].health;
      me.kills = serverPlayers[id].kills;
      me.deaths = serverPlayers[id].deaths;
      me.alive = serverPlayers[id].alive;
      players[id] = { ...serverPlayers[id], x: me.x, y: me.y, angle: me.angle };
    } else {
      players[id] = serverPlayers[id];
    }
  }
});

socket.on('playerJoined', (p) => { players[p.id] = p; });
socket.on('playerLeft', (id) => { delete players[id]; });

socket.on('damage', (data) => {
  if (data.targetId === myId) me.health = data.health;
});

socket.on('death', (data) => {
  if (data.targetId === myId) {
    me.alive = false;
    showMessage('Вас убил ' + data.killerName);
  }
});

socket.on('respawn', (data) => {
  if (data.id === myId) {
    me.x = data.x; me.y = data.y; me.health = 100; me.alive = true;
    me.ammo = me.maxAmmo; me.reserveAmmo = 32;
    reloadTimer = 0; shootCooldown = 0;
    hideMessage();
  }
});

// ---------- ЛОГИКА КАРТЫ ----------
function isWall(x, y) {
  const mx = Math.floor(x), my = Math.floor(y);
  if (my < 0 || my >= MAP.length || mx < 0 || mx >= MAP[0].length) return true;
  return MAP[my][mx] === 1;
}
function update(dt) {
  if (!me.alive || !MAP.length) return;
  const moveSpeed = 3 * dt;
  const rotSpeed = 2.2 * dt;

  if (weaponRecoil > 0) weaponRecoil -= dt * 6;
  if (weaponRecoil < 0) weaponRecoil = 0;

  if (shootCooldown > 0) shootCooldown -= dt;
  if (reloadTimer > 0) {
    reloadTimer -= dt;
    if (reloadTimer > 0.6) weaponRecoil = (1.2 - reloadTimer) * 1.5;
    else weaponRecoil = reloadTimer * 1.5;

    if (reloadTimer <= 0) {
      const needed = me.maxAmmo - me.ammo;
      const transfer = Math.min(needed, me.reserveAmmo);
      me.ammo += transfer;
      me.reserveAmmo -= transfer;
      weaponRecoil = 0;
    }
  }

  if (muzzleFlashTimer > 0) muzzleFlashTimer -= dt;
  if (hitMarkerTimer > 0) hitMarkerTimer -= dt;

  if (keys['ArrowLeft']) me.angle -= rotSpeed;
  if (keys['ArrowRight']) me.angle += rotSpeed;

  let dx = 0, dy = 0;
  if (keys['KeyW']) { dx += Math.cos(me.angle) * moveSpeed; dy += Math.sin(me.angle) * moveSpeed; }
  if (keys['KeyS']) { dx -= Math.cos(me.angle) * moveSpeed; dy -= Math.sin(me.angle) * moveSpeed; }
  if (keys['KeyA']) { dx += Math.cos(me.angle - Math.PI / 2) * moveSpeed; dy += Math.sin(me.angle - Math.PI / 2) * moveSpeed; }
  if (keys['KeyD']) { dx += Math.cos(me.angle + Math.PI / 2) * moveSpeed; dy += Math.sin(me.angle + Math.PI / 2) * moveSpeed; }

  const newX = me.x + dx, newY = me.y + dy;
  if (!isWall(newX, me.y)) me.x = newX;
  if (!isWall(me.x, newY)) me.y = newY;

  socket.emit('move', { x: me.x, y: me.y, angle: me.angle });
}

// ---------- RAYCASTING С РАСЧЕТОМ СТОРОНЫ СТЕНЫ ----------
function castRay(angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const step = 0.015; 
  let dist = 0;
  let x = me.x, y = me.y;
  
  while (dist < MAX_DEPTH) {
    dist += step;
    x = me.x + cos * dist;
    y = me.y + sin * dist;
    if (isWall(x, y)) {
      const hitX = x - Math.floor(x);
      const hitY = y - Math.floor(y);
      let wallX = hitX;
      let isVertical = false;
      
      if (Math.abs(hitX) < 0.02 || Math.abs(hitX) > 0.98) {
        wallX = hitY;
        isVertical = true;
      }
      return { dist, wallX, isVertical };
    }
  }
  return { dist: MAX_DEPTH, wallX: 0, isVertical: false };
}

function render() {
  if (!MAP.length) return;

  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, W, H / 2);     // Потолок
  ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, H / 2, W, H / 2);  // Пол

  const depthBuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = me.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    let { dist, wallX, isVertical } = castRay(rayAngle);
    dist *= Math.cos(rayAngle - me.angle); 
    depthBuffer[i] = dist;

    const wallHeight = Math.min(H * 4, H / (dist + 0.0001));
    const startY = Math.floor((H - wallHeight) / 2);
    const light = Math.max(0, 1 - dist / MAX_DEPTH);
    
    // --- ПРОЦЕДУРНАЯ ТЕКСТУРА КИРПИЧЕЙ ---
    const rBase = isVertical ? 110 : 150;
    const gBase = isVertical ? 35 : 50;
    const bBase = isVertical ? 20 : 30;
    const texHeight = 64;
    const brickRowHeight = 8;

    for (let sy = 0; sy < wallHeight; sy++) {
      const currentY = startY + sy;
      if (currentY < 0 || currentY >= H) continue;

      const texY = Math.floor((sy / wallHeight) * texHeight);
      const isHorizontalJoint = (texY % brickRowHeight === 0);
      const brickRow = Math.floor(texY / brickRowHeight);
      const xOffset = (brickRow % 2 === 0) ? 0.25 : 0.75;
      const normalizedWallX = (wallX + xOffset) * 2;
      const isVerticalJoint = (Math.floor(normalizedWallX * 32) % 16 === 0);

      let r = rBase, g = gBase, b = bBase;

      if (isHorizontalJoint || isVerticalJoint) {
        r = isVertical ? 40 : 60; g = isVertical ? 40 : 60; b = isVertical ? 40 : 60;
      } else {
        const noise = (Math.sin(texY * 2 + wallX * 20) * 12);
        r = Math.min(255, Math.max(0, r + noise));
        g = Math.min(255, Math.max(0, g + noise));
        b = Math.min(255, Math.max(0, b + noise));
      }

      ctx.fillStyle = `rgb(${Math.floor(r * light)}, ${Math.floor(g * light)}, ${Math.floor(b * light)})`;
      ctx.fillRect(i, currentY, 1, 1);
    }
  }

  const others = Object.values(players).filter((p) => p.id !== myId && p.alive !== false);
  others.sort((a, b) => distTo(b) - distTo(a));
  for (const p of others) drawSprite(p, depthBuffer);

  if (me.alive) {
    drawWeapon();
    drawMuzzleFlash();
  }
  drawHUD();
}
function distTo(p) { return Math.hypot(p.x - me.x, p.y - me.y); }
function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function drawSprite(p, depthBuffer) {
  const dx = p.x - me.x, dy = p.y - me.y;
  const dist = Math.hypot(dx, dy);
  const angleToPlayer = normalizeAngle(Math.atan2(dy, dx) - me.angle);

  if (Math.abs(angleToPlayer) > FOV / 2 + 0.3) return;

  const screenX = (0.5 + angleToPlayer / FOV) * W;
  const size = Math.min(H * 2, H / (dist + 0.0001)) * 0.6;

  const col = Math.floor(screenX);
  if (col >= 0 && col < NUM_RAYS && depthBuffer[col] < dist) return; 

  ctx.fillStyle = '#c0392b';
  ctx.fillRect(screenX - size / 4, H / 2 - size / 2, size / 2, size);
  ctx.fillStyle = '#111';
  ctx.fillRect(screenX - size / 6, H / 2 - size / 2, size / 3, size / 4);

  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(p.name || '', screenX, H / 2 - size / 2 - 8);

  const hpWidth = size / 2;
  ctx.fillStyle = '#222';
  ctx.fillRect(screenX - hpWidth / 2, H / 2 - size / 2 - 18, hpWidth, 4);
  ctx.fillStyle = '#2ecc71';
  ctx.fillRect(screenX - hpWidth / 2, H / 2 - size / 2 - 18, hpWidth * Math.max(0, (p.health || 0) / 100), 4);
}

function drawWeapon() {
  const ox = W / 2;
  const oy = H + (weaponRecoil * 50); 

  ctx.save();
  if (reloadTimer > 0) {
    ctx.fillStyle = '#e74c3c';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ПЕРЕЗАРЯДКА...', ox, H - 160);
  }

  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(ox - 30, oy - 90, 60, 90);
  
  ctx.fillStyle = '#7f8c8d';
  ctx.fillRect(ox - 14, oy - 140, 12, 70);
  ctx.fillRect(ox + 2, oy - 140, 12, 70);

  ctx.fillStyle = '#111';
  ctx.fillRect(ox - 12, oy - 140, 8, 5);
  ctx.fillRect(ox + 4, oy - 140, 8, 5);
  ctx.restore();
}

function drawMuzzleFlash() {
  if (muzzleFlashTimer <= 0) return;

  const ox = W / 2;
  const oy = H - 140 + (weaponRecoil * 50);

  ctx.save();
  ctx.fillStyle = 'rgba(241, 196, 15, 0.8)';
  ctx.beginPath();
  ctx.arc(ox, oy, 35, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ox, oy, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHUD() {
  ctx.textAlign = 'left';
  ctx.font = '18px monospace';
  ctx.fillStyle = '#fff';
  
  ctx.fillText(`AMMO: ${me.ammo} / ${me.reserveAmmo}`, 10, H - 20);
  ctx.fillText('HP: ' + Math.max(0, Math.floor(me.health)), 200, H - 20);
  ctx.fillText('Убийства: ' + me.kills + '   Смерти: ' + me.deaths, 10, H - 45);

  ctx.strokeStyle = hitMarkerTimer > 0 ? '#e74c3c' : '#fff';
  ctx.lineWidth = hitMarkerTimer > 0 ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 + 8, H / 2);
  ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 + 8);
  ctx.stroke();
}

function shoot() {
  if (!me.alive || shootCooldown > 0 || reloadTimer > 0) return;

  if (me.ammo <= 0) {
    if (me.reserveAmmo > 0) reloadTimer = 1.2;
    return;
  }

  me.ammo--;
  shootCooldown = 0.4;
  weaponRecoil = 1.0;
  muzzleFlashTimer = 0.08; 
  hitMarkerTimer = 0.15;   

  const { dist: wallDist } = castRay(me.angle);
  let best = null, bestDist = Infinity;

  for (const id in players) {
    if (id === myId) continue;
    const p = players[id];
    if (p.alive === false) continue;
    const dx = p.x - me.x, dy = p.y - me.y;
    const dist = Math.hypot(dx, dy);
    const angleToPlayer = normalizeAngle(Math.atan2(dy, dx) - me.angle);

    if (Math.abs(angleToPlayer) < 0.06 && dist < wallDist && dist < bestDist) {
      best = id;
      bestDist = dist;
    }
  }

  if (best) socket.emit('shoot', { targetId: best, damage: 25 });
  
  if (me.ammo === 0 && me.reserveAmmo > 0) {
    setTimeout(() => { if (me.alive && me.ammo === 0) reloadTimer = 1.2; }, 400);
  }
}

function showMessage(text) {
  const el = document.getElementById('message');
  el.textContent = text + ' — возрождение через 3 сек...';
  el.style.display = 'block';
}
function hideMessage() {
  document.getElementById('message').style.none = 'none';
  const el = document.getElementById('message');
  if (el) el.style.display = 'none';
}

let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
