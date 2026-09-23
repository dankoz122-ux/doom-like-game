const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Надежный текстовый слепок оригинальной цифровой карты. Маркдаун его не сожрет.
const IMMUNE_MAP_DATA = `
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},
  {1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1},
  {1,0,1,1,0,0,1,0,1,1,1,1,1,0,0,1},
  {1,0,1,0,0,0,0,0,1,0,0,0,1,0,0,1},
  {1,0,1,0,1,1,1,1,1,0,1,0,1,0,0,1},
  {1,0,0,0,1,0,0,0,0,0,1,0,0,0,0,1},
  {1,0,1,0,1,0,1,1,1,0,1,1,1,1,0,1},
  {1,0,1,0,0,0,1,0,0,0,0,0,0,1,0,1},
  {1,0,1,1,1,1,1,0,1,1,1,1,0,1,0,1},
  {1,0,0,0,0,0,0,0,1,0,0,1,0,0,0,1},
  {1,1,1,1,0,1,0,1,1,0,1,1,1,1,0,1},
  {1,0,0,1,0,1,0,0,0,0,0,0,0,1,0,1},
  {1,0,0,1,0,1,1,1,1,1,1,1,0,1,0,1},
  {1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1},
  {1,0,1,1,1,1,1,1,1,1,0,1,1,1,0,1},
  {1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1}
`;

// Превращаем фигурные скобки обратно в нативный двухмерный числовой массив JavaScript
const MAP = IMMUNE_MAP_DATA.trim().split('\n').map(row => {
  const cleanRow = row.replace(/\{|\}/g, '').trim();
  if (!cleanRow) return null;
  return cleanRow.split(',').map(char => parseInt(char.trim()));
}).filter(row => row !== null);

// Раздельные кластеры точек спавна: у каждой команды свои точки рядом друг с другом,
// в разных углах карты (красные — сверху слева, синие — снизу справа).
const RED_SPAWNS = [
  { x: 1.5, y: 1.5 }, { x: 3.5, y: 1.5 }, { x: 1.5, y: 3.5 }, { x: 3.5, y: 3.5 }
];
const BLUE_SPAWNS = [
  { x: 12.5, y: 13.5 }, { x: 13.5, y: 13.5 }, { x: 14.5, y: 13.5 },
  { x: 12.5, y: 12.5 }, { x: 14.5, y: 12.5 }
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

let rpgWeapon = { id: 'rpg_pickup', x: 7.5, y: 5.5, active: true };
const players = {};
// Match rotation: Team Deathmatch (120s) <-> Bomb mode (rounds).
let modeIndex = 0;
let match = { mode: 'tdm', phase: 'active', endsAt: Date.now() + 120000, round: 1, roundEndsAt: 0, bomb: null, scores: { red: 0, blue: 0 }, message: 'Командный бой' };
const SITE = { x: 7.5, y: 7.5 }; // существующая свободная клетка; карта не меняется
const teamCounts = () => Object.values(players).reduce((a,p)=>(a[p.team]=(a[p.team]||0)+1,a),{red:0,blue:0});
function assignTeam() { const c=teamCounts(); return (c.red||0) <= (c.blue||0) ? 'red' : 'blue'; }
function publicMatch() { return { ...match, bomb: match.bomb ? { planted: true, x: match.bomb.x, y: match.bomb.y, explodesAt: match.bomb.explodesAt, defusingBy: match.bomb.defusingBy || null, defuseStartedAt: match.bomb.defuseStartedAt || null } : null, site: SITE }; }
function emitMatch() { io.emit('matchState', publicMatch()); }
function aliveTeamCount(team) { return Object.values(players).filter(p=>p.alive && p.team===team).length; }
function finishRound(winner, reason) {
  if (match.phase !== 'active') return;
  match.phase='intermission'; match.message=reason; if(winner) match.scores[winner]++;
  match.bomb=null; match.roundEndsAt=Date.now()+7000; emitMatch();
  io.emit('roundResult',{winner,reason,scores:match.scores});
}
function startRound() {
  match.phase='active'; match.roundEndsAt=0; match.bomb=null; match.message='Раунд '+match.round;
  for (const p of Object.values(players)) { p.alive=true; p.health=100; const sp=randomSpawn(p.team); p.x=sp.x; p.y=sp.y; }
  io.emit('roundReset', players); emitMatch();
}
function startNextMode() {
  modeIndex=(modeIndex+1)%2; match.mode=modeIndex===0?'tdm':'bomb'; match.phase='active'; match.round=1;
  match.endsAt=Date.now()+(match.mode==='tdm'?120000:300000); match.roundEndsAt=0; match.bomb=null; match.scores={red:0,blue:0};
  // Команда игрока — его собственный выбор при входе, при смене режима она не меняется.
  Object.values(players).forEach((p)=>{p.alive=true;p.health=100;const sp=randomSpawn(p.team);p.x=sp.x;p.y=sp.y;});
  match.message=match.mode==='bomb'?'Закладка бомбы':'Командный бой'; io.emit('roundReset',players); emitMatch();
}


function randomSpawn(team) {
  const arr = team === 'blue' ? BLUE_SPAWNS : RED_SPAWNS;
  return arr[Math.floor(Math.random() * arr.length)];
}

io.on('connection', (socket) => {
  // Игрок появляется в мире только после того, как выбрал команду и имя в лобби.
  socket.on('join', (data) => {
    if (players[socket.id]) return; // уже присоединился
    const requestedTeam = (data && (data.team === 'red' || data.team === 'blue')) ? data.team : assignTeam();
    const spawn = randomSpawn(requestedTeam);
    const cleanName = String((data && data.name) || '').slice(0, 16).trim() || ('Player' + socket.id.slice(0, 4));

    players[socket.id] = {
      id: socket.id, x: spawn.x, y: spawn.y, angle: 0,
      health: 100, kills: 0, deaths: 0, team: requestedTeam,
      name: cleanName, alive: true
    };

    socket.emit('init', { id: socket.id, map: MAP, players, ammoBoxes, medkits, rpgWeapon, match: publicMatch() });
    socket.broadcast.emit('playerJoined', players[socket.id]);
    console.log('Игрок подключился:', socket.id, requestedTeam);
  });

  socket.on('bombAction', (action) => {
    const p=players[socket.id]; if(!p||!p.alive||match.mode!=='bomb'||match.phase!=='active') return;
    const near=(x,y)=>Math.hypot(p.x-x,p.y-y)<1.35;
    if(action==='plant' && p.team==='red' && !match.bomb && near(SITE.x,SITE.y)) {
      match.bomb={x:SITE.x,y:SITE.y,explodesAt:Date.now()+35000,defusingBy:null}; match.message='Бомба заложена!'; emitMatch();
    } else if(action==='defuseStart' && p.team==='blue' && match.bomb && near(match.bomb.x,match.bomb.y)) {
      match.bomb.defusingBy=socket.id; match.bomb.defuseStartedAt=Date.now(); match.message='Идёт разминирование'; emitMatch();
    } else if(action==='defuseCancel' && match.bomb && match.bomb.defusingBy===socket.id) {
      match.bomb.defusingBy=null; match.bomb.defuseStartedAt=null; match.message='Разминирование прервано'; emitMatch();
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
        setTimeout(() => { rpgWeapon.active = true; io.emit('rpgRespawned', rpgWeapon); }, 25000);
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
        if(match.mode==='bomb' && match.phase==='active') { if(aliveTeamCount('red')===0) finishRound('blue','Команда атакующих уничтожена'); else if(aliveTeamCount('blue')===0) finishRound('red','Команда защитников уничтожена'); }
        else if(match.mode==='tdm' && match.phase==='active' && aliveTeamCount(target.team)===0) { match.scores[shooter.team]=(match.scores[shooter.team]||0)+1; emitMatch(); }

            // В режиме "Закладка" убитый остаётся мёртв до конца раунда — иначе элиминация
            // не работает. Автовозрождение через 3 сек оставляем только в командном бою.
            if (match.mode === 'tdm') {
              setTimeout(() => {
                if (!players[target.id]) return;
                const sp = randomSpawn(target.team);
                target.x = sp.x; target.y = sp.y; target.health = 100; target.alive = true;
                io.emit('respawn', { id: target.id, x: target.x, y: target.y });
              }, 3000);
            }
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
        if(match.mode==='bomb' && match.phase==='active') { if(aliveTeamCount('red')===0) finishRound('blue','Команда атакующих уничтожена'); else if(aliveTeamCount('blue')===0) finishRound('red','Команда защитников уничтожена'); }
        else if(match.mode==='tdm' && match.phase==='active' && aliveTeamCount(target.team)===0) { match.scores[shooter.team]=(match.scores[shooter.team]||0)+1; emitMatch(); }

        // См. комментарий выше: в "Закладке" мёртвые не воскресают до конца раунда.
        if (match.mode === 'tdm') {
          setTimeout(() => {
            if (!players[target.id]) return;
            const sp = randomSpawn(target.team);
            target.x = sp.x; target.y = sp.y; target.health = 100; target.alive = true;
            io.emit('respawn', { id: target.id, x: target.x, y: target.y });
          }, 3000);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
    }
  });
});

setInterval(() => {
  const now=Date.now();
  if(match.mode==='bomb' && match.phase==='active') {
    if(match.bomb && match.bomb.defusingBy) { const dp=players[match.bomb.defusingBy]; if(!dp || !dp.alive || Math.hypot(dp.x-match.bomb.x,dp.y-match.bomb.y)>=1.35) { match.bomb.defusingBy=null; match.bomb.defuseStartedAt=null; match.message='Разминирование прервано'; emitMatch(); } }
    if(match.bomb && match.bomb.defusingBy && now-(match.bomb.defuseStartedAt||now)>=7000) finishRound('blue','Бомба разминирована!');
    else if(match.bomb && now>=match.bomb.explodesAt) finishRound('red','Бомба взорвалась!');
    else if(!match.bomb && now>=match.endsAt) finishRound('blue','Время атаки вышло');
  }
  if(match.phase==='intermission' && now>=match.roundEndsAt) {
    if(match.mode==='bomb' && match.round<6) { match.round++; // swap sides after 3 rounds
      startRound();
    } else startNextMode();
  }
  if(match.mode==='tdm' && match.phase==='active' && now>=match.endsAt) startNextMode();
  io.emit('state', players); 
}, 50);
setInterval(()=>{ if(match.mode==='bomb' && match.phase==='active' && match.bomb) emitMatch(); },1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
