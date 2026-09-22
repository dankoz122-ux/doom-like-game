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
let medkits = [];   // Массив аптечек с сервера

const me = { 
  x: 2.5, y: 2.5, angle: 0, 
  health: 100, alive: true, 
  kills: 0, deaths: 0, name: '',
  ammo: 8, maxAmmo: 8, reserveAmmo: 32 
};

let weaponRecoil = 0;       
let muzzleFlashTimer = 0;   
let hitMarkerTimer = 0;     
let shootCooldown = 0;      
let reloadTimer = 0;        

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
  ammoBoxes = data.ammoBoxes || [];
  medkits = data.medkits || [];
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

socket.on('ammoPicked', (data) => {
  const box = ammoBoxes.find(b => b.id === data.boxId);
  if (box) box.active = false;
  if (data.playerId === myId) me.reserveAmmo = Math.min(99, me.reserveAmmo + 16);
});

socket.on('ammoRespawned', (serverBox) => {
  const box = ammoBoxes.find(b => b.id === serverBox.id);
  if (box) box.active = true;
});

// Триггеры сбора аптечек
socket.on('medkitPicked', (data) => {
  const kit = medkits.find(k => k.id === data.kitId);
  if (kit) kit.active = false;
  if (data.playerId === myId) me.health = data.health;
});

socket.on('medkitRespawned', (serverKit) => {
  const kit = medkits.find(k => k.id === serverKit.id);
  if (kit) kit.active = true;
});

socket.on('playerJoined', (p) => { players[p.id] = p; });
socket.on('playerLeft', (id) => { delete players[id]; });
socket.on('damage', (data) => { if (data.targetId === myId) me.health = data.health; });

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

function isWall(x, y) {
  const mx = Math.floor(x), my = Math.floor(y);
  if (my < 0 || my >= MAP.length || mx < 0 || mx >= MAP[0].length) return true;
  return MAP[my][mx] === 1;
}
function update(dt) {
  if (!me.alive || !MAP.length) return;
  const moveSpeed = 3 * dt;
  const rotSpeed = 2.2 * dt;

  if (weaponRecoil > 0) weaponRecoil -= dt * 7; // Чуть быстрее возврат пистолета
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

function castRay(angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const step = 0.02; 
  let dist = 0;
  let x = me.x, y = me.y;
  
  while (dist < MAX_DEPTH) {
    dist += step;
    x = me.x + cos * dist;
    y = me.y + sin * dist;
    if (isWall(x, y)) {
      const hitX = x - Math.floor(x);
      const hitY = y - Math.floor(y);
      let wallX = (Math.abs(hitX) < 0.03 || Math.abs(hitX) > 0.97) ? hitY : hitX;
      let isVertical = (Math.abs(hitX) < 0.03 || Math.abs(hitX) > 0.97);
      return { dist, wallX, isVertical };
    }
  }
  return { dist: MAX_DEPTH, wallX: 0, isVertical: false };
}

function render() {
  if (!MAP.length) return;

  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, W, H / 2);     
  ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, H / 2, W, H / 2);  

  const depthBuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = me.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    let { dist, wallX, isVertical } = castRay(rayAngle);
    dist *= Math.cos(rayAngle - me.angle); 
    depthBuffer[i] = dist;

    const wallHeight = Math.min(H * 4, H / (dist + 0.0001));
    const startY = Math.floor((H - wallHeight) / 2);
    const light = Math.max(0, 1 - dist / MAX_DEPTH);
    
    const r = isVertical ? Math.floor(100 * light) : Math.floor(140 * light);
    const g = isVertical ? Math.floor(30 * light) : Math.floor(45 * light);
    const b = isVertical ? Math.floor(15 * light) : Math.floor(25 * light);
    const brickColor = `rgb(${r},${g},${b})`;
    
    const seamR = isVertical ? Math.floor(35 * light) : Math.floor(50 * light);
    const seamColor = `rgb(${seamR},${seamR},${seamR})`;

    const grad = ctx.createLinearGradient(0, startY, 0, startY + wallHeight);
    for (let row = 0; row < 8; row++) {
      const startPos = row / 8;
      const endPos = (row + 1) / 8;
      const noise = Math.sin(row * 5 + wallX * 10) > 0;
      const currentBrickColor = noise ? `rgb(${Math.min(255, r+15)},${Math.min(255, g+5)},${b})` : brickColor;

      grad.addColorStop(startPos, seamColor);       
      grad.addColorStop(startPos + 0.03, currentBrickColor); 
      grad.addColorStop(endPos - 0.03, currentBrickColor);
    }
    
    const isVertSeam = Math.floor(wallX * 5) % 2 === 0;
    ctx.fillStyle = isVertSeam ? seamColor : grad;
    ctx.fillRect(i, startY, 1, wallHeight); 
  }

  // --- СОРТИРОВКА ОБЪЕКТОВ ---
  const sprites = [];
  Object.values(players).forEach(p => {
    if (p.id !== myId && p.alive) sprites.push({ x: p.x, y: p.y, type: 'player', data: p });
  });
  ammoBoxes.forEach(b => {
    if (b.active) sprites.push({ x: b.x, y: b.y, type: 'ammo', data: b });
  });
  medkits.forEach(k => {
    if (k.active) sprites.push({ x: k.x, y: k.y, type: 'medkit', data: k });
  });

  sprites.sort((a, b) => Math.hypot(b.x - me.x, b.y - me.y) - Math.hypot(a.x - me.x, a.y - me.y));
  sprites.forEach(s => drawSprite(s, depthBuffer));

  if (me.alive) {
    drawWeapon();
    drawMuzzleFlash();
  }
  drawHUD();
  drawMinimap(); // Рисуем карту поверх всего экрана
}
function distTo(p) { return Math.hypot(p.x - me.x, p.y - me.y); }
function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Отрисовка игрока в виде курицы и других предметов
function drawSprite(sprite, depthBuffer) {
  const dx = sprite.x - me.x, dy = sprite.y - me.y;
  const dist = Math.hypot(dx, dy);
  const angleToSprite = normalizeAngle(Math.atan2(dy, dx) - me.angle);

  if (Math.abs(angleToSprite) > FOV / 2 + 0.3) return;

  const screenX = (0.5 + angleToSprite / FOV) * W;
  const size = Math.min(H * 2, H / (dist + 0.0001)) * 0.6;
  const col = Math.floor(screenX);

  if (col >= 0 && col < NUM_RAYS && depthBuffer[col] < dist) return;

  ctx.save();
  if (sprite.type === 'player') {
    // --- СПРАЙТ КУРИЦЫ ИЗ ГЕОМЕТРИИ (РЕТРО-СТИЛЬ) ---
    const cx = screenX;
    const cy = H / 2 + size * 0.1;
    const w = size * 0.4;
    const h = size * 0.5;

    // Тело курицы (белое)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);

    // Гребешок (красный)
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(cx - w / 4, cy - h / 2 - h * 0.2, w / 2, h * 0.2);

    // Клюв (желтый)
    ctx.fillStyle = '#f1c40f';
    ctx.fillRect(cx - w * 0.1, cy - h * 0.2, w * 0.4, h * 0.15);

    // Глаз (черный)
    ctx.fillStyle = '#111111';
    ctx.fillRect(cx - w * 0.2, cy - h * 0.3, w * 0.1, h * 0.1);

    // Текст над курицей
    ctx.fillStyle = '#fff';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sprite.data.name || '', screenX, cy - h / 2 - 25);

    const hpWidth = size / 2;
    ctx.fillStyle = '#222';
    ctx.fillRect(screenX - hpWidth / 2, cy - h / 2 - 15, hpWidth, 4);
    ctx.fillStyle = '#2ecc71';
    ctx.fillRect(screenX - hpWidth / 2, cy - h / 2 - 15, hpWidth * Math.max(0, (sprite.data.health || 0) / 100), 4);
  } 
  else if (sprite.type === 'ammo') {
    const boxWidth = size * 0.4, boxHeight = size * 0.25;
    const bx = screenX - boxWidth / 2, by = H / 2 + size * 0.2;
    ctx.fillStyle = '#d35400'; ctx.fillRect(bx, by, boxWidth, boxHeight);
    ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = Math.max(1, size * 0.02); ctx.strokeRect(bx, by, boxWidth, boxHeight);
    ctx.fillStyle = '#f1c40f'; ctx.font = `bold ${Math.max(8, size * 0.1)}px monospace`; ctx.textAlign = 'center';
    ctx.fillText('AMMO', screenX, by + boxHeight * 0.7);
  }
  else if (sprite.type === 'medkit') {
    // --- ОТРИСОВКА АПТЕЧКИ ---
    const kw = size * 0.35, kh = size * 0.35;
    const kx = screenX - kw / 2, ky = H / 2 + size * 0.15;

    ctx.fillStyle = '#ecf0f1'; // Белый корпус
    ctx.fillRect(kx, ky, kw, kh);
    ctx.strokeStyle = '#bdc3c7'; ctx.strokeRect(kx, ky, kw, kh);

    // Красный медицинский крест
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(kx + kw * 0.4, ky + kh * 0.15, kw * 0.2, kh * 0.7);
    ctx.fillRect(kx + kw * 0.15, ky + kh * 0.4, kw * 0.7, kh * 0.2);
  }
  ctx.restore();
}

// --- НОВАЯ МОДЕЛЬ ОРУЖИЯ (ПИСТОЛЕТ) ---
function drawWeapon() {
  const ox = W / 2;
  const oy = H + (weaponRecoil * 35); // Меньше ход отдачи у пистолета

  ctx.save();
  if (reloadTimer > 0) {
    ctx.fillStyle = '#e74c3c'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center';
    ctx.fillText('ПЕРЕЗАРЯДКА...', ox, H - 160);
  }

  // Рукоять пистолета
  ctx.fillStyle = '#111111';
  ctx.fillRect(ox - 10, oy - 60, 20, 60);

  // Ствол и затвор пистолета (серая сталь)
  ctx.fillStyle = '#7f8c8d';
  ctx.fillRect(ox - 8, oy - 110, 16, 60);
  
  // Мушка и лазерный прицел
  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(ox - 6, oy - 115, 12, 10);
  ctx.fillStyle = '#e74c3c'; // Красная точка лазера на дуле
  ctx.fillRect(ox - 2, oy - 115, 4, 4);
  ctx.restore();
}

function drawMuzzleFlash() {
  if (muzzleFlashTimer <= 0) return;
  const ox = W / 2, oy = H - 115 + (weaponRecoil * 35);
  ctx.save();
  ctx.fillStyle = 'rgba(241, 196, 15, 0.8)';
  ctx.beginPath(); ctx.arc(ox, oy, 20, 0, Math.PI * 2); ctx.fill(); // Вспышка пистолета меньше
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(ox, oy, 8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --- ОТРИСОВКА 2D-МИНИКАРТЫ (РАДАР) ---
function drawMinimap() {
  if (!MAP.length) return;
  
  const scale = 6; // Размер одной ячейки на карте в пикселях
  const mx = 10, my = 10; // Координаты карты на экране

  ctx.save();
  // Фон подложки радара
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(mx, my, MAP[0].length * scale, MAP.length * scale);

  // Стены
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  for (let r = 0; r < MAP.length; r++) {
    for (let c = 0; c < MAP[r].length; c++) {
      if (MAP[r][c] === 1) {
        ctx.fillRect(mx + c * scale, my + r * scale, scale - 1, scale - 1);
      }
    }
  }

  // Точки предметов патронов и аптечек
  ammoBoxes.forEach(b => { if (b.active) { ctx.fillStyle = '#e67e22'; ctx.fillRect(mx + b.x * scale - 1, my + b.y * scale - 1, 3, 3); } });
  medkits.forEach(k => { if (k.active) { ctx.fillStyle = '#2ecc71'; ctx.fillRect(mx + k.x * scale - 1, my + k.y * scale - 1, 3, 3); } });

  // Точки врагов (игроков)
  ctx.fillStyle = '#e74c3c';
  Object.values(players).forEach(p => {
    if (p.id !== myId && p.alive) {
      ctx.fillRect(mx + p.x * scale - 2, my + p.y * scale - 2, 4, 4);
    }
  });

  // Моя позиция и луч направления взгляда
  const pSize = 4;
  const px = mx + me.x * scale;
  const py = my + me.y * scale;

  ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(me.angle) * 12, py + Math.sin(me.angle) * 12); ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(px, py, pSize / 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawHUD() {
  ctx.textAlign = 'left'; ctx.font = '18px monospace'; ctx.fillStyle = '#fff';
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
  shootCooldown = 0.3; // У пистолета кулдаун чуть меньше
  weaponRecoil = 1.0;
  muzzleFlashTimer = 0.06; 
  hitMarkerTimer = 0.12;   

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
    setTimeout(() => { if (me.alive && me.ammo === 0) reloadTimer = 1.2; }, 300);
  }
}

function showMessage(text) {
  const el = document.getElementById('message');
  if (el) { el.textContent = text + ' — возрождение через 3 сек...'; el.style.display = 'block'; }
}
function hideMessage() {
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
