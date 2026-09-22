const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Карта изменена на массив текстовых строк, чтобы маркдаун её не стирал.
// '1' = стена, '0' = свободный проход. Коридорный лабиринт 16x16.
const MAP = [
  "1111111111111111",
  "1000001000000001",
  "1011001011111001",
  "1010000010001001",
  "1010111110101001",
  "1000100000100001",
  "1010101110111101",
  "1010001000000101",
  "1011111011110101",
  "1000000010010001",
  "1111010110111101",
  "1001010000000101",
  "1001011111110101",
  "1000000000010001",
  "1011111111011101",
  "1111111111111111"
];

const SPAWNS = [
  { x: 2.5, y: 1.5 }, { x: 13.5, y: 1.5 },
  { x: 2.5, y: 13.5 }, { x: 13.5, y: 13.5 }, { x: 7.5, y: 7.5 }
];

const ammoBoxes = [
  { id: 'b1', x: 5.5, y: 1.5, active: true },
  { id: 'b2', x: 1.5, y: 5.5, active: true },
  { id: 'b3', x: 14.5, y: 5.5, active: true },
  { id: 'b4', x: 9.5, y: 9.5, active: true },
  { id: 'b5', x: 5.5, y: 13.5, active: true }
];

const medkits = [
  { id: 'm1', x: 3.5, y: 3.5, active: true },
  { id: 'm2', x: 11.5, y: 3.5, active: true }, 
  { id: 'm3', x: 2.5, y: 11.5, active: true },
  { id: 'm4', x: 12.5, y: 11.5, active: true }
];

// Ровно 1 экземпляр РПГ на карте
let rpgWeapon = { id: 'rpg_pickup', x: 7.5, y: 5.5, active: true };

const players = {};

function randomSpawn() {
  return SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
}

io.on('connection', (socket) => {
  const spawn = randomSpawn();
  players[socket.id] = {
    id: socket.id, x: spawn.x, y: spawn.y, angle: 0,
    health: 100, kills: 0, deaths: 0,
    name: 'Player' + socket.id.slice(0, 4), alive: true
  };

  socket.emit('init', { id: socket.id, map: MAP, players, ammoBoxes, medkits, rpgWeapon });
  socket.broadcast.emit('playerJoined', players[socket.id]);

  socket.on('ping_test', () => { socket.emit('pong_test'); });

  socket.on('setName', (name) => {
    if (players[socket.id]) {
      const clean = String(name || '').slice(0, 16).trim();
      if (clean) players[socket.id].name = clean;
    }
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.x === 'number' && typeof data.y === 'number' && typeof data.angle === 'number') {
      p.x = data.x; p.y = data.y; p.angle = data.angle;

      for (const box of ammoBoxes) {
        if (box.active && Math.hypot(p.x - box.x, p.y - box.y) < 0.5) {
          box.active = false;
          io.emit('ammoPicked', { boxId: box.id, playerId: socket.id });
          setTimeout(() => { box.active = true; io.emit('ammoRespawned', box); }, 10000);
        }
      }

      for (const kit of medkits) {
        if (kit.active && p.health < 100 && Math.hypot(p.x - kit.x, p.y - kit.y) < 0.5) {
          kit.active = false;
          p.health = Math.min(100, p.health + 25);
          io.emit('medkitPicked', { kitId: kit.id, playerId: socket.id, health: p.health });
          setTimeout(() => { kit.active = true; io.emit('medkitRespawned', kit); }, 15000);
        }
      }

      if (rpgWeapon.active && Math.hypot(p.x - rpgWeapon.x, p.y - rpgWeapon.y) < 0.5) {
        rpgWeapon.active = false;
        io.emit('rpgPicked', { playerId: socket.id });
        setTimeout(() => {
          rpgWeapon.active = true;
          io.emit('rpgRespawned', rpgWeapon);
        }, 25000);
      }
    }
  });

  socket.on('shoot', (data) => {
    const shooter = players[socket.id];
    if (!shooter || !shooter.alive) return;

    if (data.isRpg) {
      const explosionX = data.explX;
      const explosionY = data.explY;
      io.emit('rpg_explosion_fx', { x: explosionX, y: explosionY });

      Object.values(players).forEach(target => {
        if (!target.alive) return;
        const distToExplosion = Math.hypot(target.x - explosionX, target.y - explosionY);
        
        if (distToExplosion < 3.0) {
          const damage = Math.floor(100 * (1 - distToExplosion / 3.0));
          if (damage <= 0) return;

          target.health -= damage;
          io.emit('damage', { targetId: target.id, health: target.health, byId: socket.id });

          if (target.health <= 0) {
            target.alive = false; target.deaths++; 
            if (target.id !== shooter.id) shooter.kills++;
            io.emit('death', { targetId: target.id, byId: socket.id, killerName: shooter.name });

            setTimeout(() => {
              if (!players[target.id]) return;
              const sp = randomSpawn();
              target.x = sp.x; target.y = sp.y; target.health = 100; target.alive = true;
              io.emit('respawn', { id: target.id, x: target.x, y: target.y });
            }, 3000);
          }
        }
      });
    } else {
      const target = players[data.targetId];
      if (!target || !target.alive || data.targetId === socket.id) return;

      target.health -= data.damage || 25;
      io.emit('damage', { targetId: target.id, health: target.health, byId: socket.id });

      if (target.health <= 0) {
        target.alive = false; target.deaths++; shooter.kills++;
        io.emit('death', { targetId: target.id, byId: socket.id, killerName: shooter.name });

        setTimeout(() => {
          if (!players[target.id]) return;
          const sp = randomSpawn();
          target.x = sp.x; target.y = sp.y; target.health = 100; target.alive = true;
          io.emit('respawn', { id: target.id, x: target.x, y: target.y });
        }, 3000);
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

setInterval(() => { io.emit('state', players); }, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
