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
const me = { x: 2.5, y: 2.5, angle: 0, health: 100, alive: true, kills: 0, deaths: 0, name: '' };

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
      // позицию/угол оставляем локальными для плавности, остальное — от сервера
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

// ---------- RAYCASTING ----------
function castRay(angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const step = 0.02;
  let dist = 0;
  let x = me.x, y = me.y;
  while (dist < MAX_DEPTH) {
    dist += step;
    x = me.x + cos * dist;
    y = me.y + sin * dist;
    if (isWall(x, y)) break;
  }
  return dist;
}

function render() {
  if (!MAP.length) return;

  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, W, H / 2);     // потолок
  ctx.fillStyle = '#5a5a5a'; ctx.fillRect(0, H / 2, W, H / 2);  // пол

  const depthBuffer = new Array(NUM_RAYS);

  for (let i = 0; i < NUM_RAYS; i++) {
    const rayAngle = me.angle - FOV / 2 + (i / NUM_RAYS) * FOV;
    let dist = castRay(rayAngle);
    dist *= Math.cos(rayAngle - me.angle); // коррекция "рыбьего глаза"
    depthBuffer[i] = dist;

    const wallHeight = Math.min(H * 3, H / (dist + 0.0001));
    const shade = Math.max(0, 1 - dist / MAX_DEPTH);
    const c = Math.floor(70 + 150 * shade);
    ctx.fillStyle = `rgb(${c}, ${Math.floor(c * 0.4)}, ${Math.floor(c * 0.25)})`;
    ctx.fillRect(i, (H - wallHeight) / 2, 1, wallHeight);
  }

  const others = Object.values(players).filter((p) => p.id !== myId && p.alive !== false);
  others.sort((a, b) => distTo(b) - distTo(a));
  for (const p of others) drawSprite(p, depthBuffer);

  drawHUD();
}

function distTo(p) {
  return Math.hypot(p.x - me.x, p.y - me.y);
}

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
  if (col >= 0 && col < NUM_RAYS && depthBuffer[col] < dist) return; // закрыт стеной

  // "враг" — простой прямоугольник в духе спрайтов Doom
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

function drawHUD() {
  ctx.textAlign = 'left';
  ctx.font = '18px monospace';
  ctx.fillStyle = '#fff';
  ctx.fillText('HP: ' + Math.max(0, Math.floor(me.health)), 10, H - 20);
  ctx.fillText('Убийства: ' + me.kills + '   Смерти: ' + me.deaths, 10, H - 45);

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 + 8, H / 2);
  ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 + 8);
  ctx.stroke();
}

// ---------- СТРЕЛЬБА ----------
function shoot() {
  if (!me.alive) return;
  const wallDist = castRay(me.angle);
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
}

// ---------- СООБЩЕНИЯ ----------
function showMessage(text) {
  const el = document.getElementById('message');
  el.textContent = text + ' — возрождение через 3 сек...';
  el.style.display = 'block';
}
function hideMessage() {
  document.getElementById('message').style.display = 'none';
}

// ---------- ГЛАВНЫЙ ЦИКЛ ----------
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
