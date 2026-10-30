// TRAITOR PROTOCOL — servidor autoritativo (sin dependencias). Node 18+
// HTTP estático + SSE (tiempo real servidor->cliente) + POST (acciones cliente->servidor)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 4, MAX_PLAYERS = 10;

// ---------- Balance ----------
const CFG = {
  killCd: 25000,        // enfriamiento del asesinato
  firstKillCd: 20000,   // espera inicial antes del primer asesinato
  shootCd: 30000,       // enfriamiento del disparo del detective
  scanCd: 35000,        // enfriamiento de la investigación
  scanAccuracy: 0.78,
  sabCd: 50000,         // enfriamiento del apagón
  sabDur: 15000,
  travel: 2000,         // tiempo de viaje entre salas
  tasksPerPlayer: 5,
  minTaskMs: 3000,
  meetingMs: 75000,
  resultMs: 7000,
  revealMs: 6500,
  afterMeetingCd: 12000,
  noMeetingAfter: 20000,
};
const killersFor = n => (n <= 5 ? 1 : n <= 8 ? 2 : 3);

// ---------- Mapa ----------
const ring = [
  ['elec', 'Electricidad'], ['med', 'Enfermería'], ['armory', 'Armería'], ['storage', 'Almacén'],
  ['lab', 'Laboratorio'], ['security', 'Seguridad'], ['engine', 'Motores'], ['reactor', 'Reactor'],
];
const MAP = { rooms: [{ id: 'cafe', name: 'Cafetería', x: 50, y: 50 }], edges: [] };
ring.forEach(([id, name], i) => {
  const a = (-90 + 45 * i) * Math.PI / 180;
  MAP.rooms.push({ id, name, x: +(50 + 38 * Math.cos(a)).toFixed(1), y: +(50 + 38 * Math.sin(a)).toFixed(1) });
  MAP.edges.push([id, ring[(i + 1) % 8][0]]);
  if (i % 2 === 0) MAP.edges.push(['cafe', id]);
});
const ROOM_IDS = MAP.rooms.map(r => r.id);
const ROOM_NAME = Object.fromEntries(MAP.rooms.map(r => [r.id, r.name]));
const adj = {};
MAP.edges.forEach(([a, b]) => { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); });

const TASK_TYPES = ['seq', 'reflex', 'memory', 'math'];
const COLORS = ['#ff4d6d', '#4dabf7', '#51cf66', '#ffd43b', '#b197fc', '#ff922b', '#22d3ee', '#f783ac', '#a9e34b', '#ced4da'];

// ---------- Estado ----------
const rooms = new Map();
const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = () => crypto.randomBytes(6).toString('hex');

function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += L[rnd(L.length)];
    if (!rooms.has(c)) return c;
  }
}
function makePlayer(name, r) {
  name = String(name || '').replace(/[<>]/g, '').trim().slice(0, 12) || 'Agente';
  let base = name, k = 2;
  while (r.players.some(p => p.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 10) + k++;
  const used = new Set(r.players.map(p => p.color));
  return {
    id: uid(), token: uid() + uid(), name, color: COLORS.find(c => !used.has(c)) || COLORS[0],
    res: null, connected: false, lastSeen: Date.now(), notes: [], noteSeq: 0, score: 0,
    role: null, alive: true, revealed: false, room: 'cafe', from: 'cafe', moving: null, doing: null, tasks: [],
    killReadyAt: 0, shootReadyAt: 0, scanReadyAt: 0, sabReadyAt: 0, meetingsLeft: 1, scans: [],
    stats: { kills: 0, tasks: 0, correct: 0, shots: 0 },
  };
}
function newRoom() {
  const r = {
    code: newCode(), phase: 'lobby', players: [], hostId: null, created: Date.now(),
    phaseEnd: 0, bodies: [], blackoutUntil: 0, noMeetingBefore: 0, visits: [],
    meeting: null, result: null, winner: null, winReason: '', ranking: null,
  };
  rooms.set(r.code, r);
  return r;
}
const getP = (r, id) => r.players.find(p => p.id === id);
const note = (p, text, kind = 'info') => { p.notes.push({ id: ++p.noteSeq, text, kind }); if (p.notes.length > 8) p.notes.shift(); };
const noteAll = (r, text, kind, filter = () => true) => r.players.forEach(p => filter(p) && note(p, text, kind));
const alivePl = r => r.players.filter(p => p.alive);
const goodAlive = r => r.players.filter(p => p.alive && p.role !== 'killer');
const killersAlive = r => r.players.filter(p => p.alive && p.role === 'killer');
function progress(r) {
  let done = 0, total = 0;
  r.players.forEach(p => p.role !== 'killer' && p.tasks.forEach(t => { total++; if (t.done) done++; }));
  return { done, total };
}

// ---------- Vista filtrada por jugador (nadie recibe información secreta de más) ----------
function view(r, p) {
  const now = Date.now();
  const ghost = !p.alive;
  const dark = now < r.blackoutUntil && p.role !== 'killer';
  const inRoom = q => q.alive && q.room && q.room === p.room && !q.moving;
  const players = r.players.map(q => {
    const o = { id: q.id, name: q.name, color: q.color, alive: q.alive, connected: q.connected, left: !!q.left };
    if (q.id === p.id || (p.role === 'killer' && q.role === 'killer') || r.phase === 'end' || q.revealed || (ghost && r.phase === 'end')) o.role = q.role;
    if (q.id !== p.id && q.alive) {
      if (ghost && q.room && !q.moving) o.room = q.room;
      else if (!ghost && inRoom(q)) { if (dark) o.dark = true; else o.here = true; }
    }
    if (q.id === p.id) o.here = true;
    if (r.phase === 'end') o.score = q.score;
    return o;
  });
  const bodies = r.bodies.filter(b => ghost || b.room === p.room).map(b => ({ pid: b.pid, room: b.room }));
  const pr = progress(r);
  const v = {
    now, code: r.code, phase: r.phase, hostId: r.hostId, phaseEnd: r.phaseEnd, map: MAP,
    min: MIN_PLAYERS, max: MAX_PLAYERS, players, bodies, progress: pr,
    blackoutUntil: dark ? r.blackoutUntil : 0,
    me: {
      id: p.id, name: p.name, role: p.role, alive: p.alive, room: p.room, from: p.from, moving: p.moving, doing: p.doing,
      tasks: p.tasks, killReadyAt: p.killReadyAt, shootReadyAt: p.shootReadyAt, scanReadyAt: p.scanReadyAt,
      sabReadyAt: p.sabReadyAt, meetingsLeft: p.meetingsLeft, scans: p.scans, notes: p.notes, score: p.score,
      canMeetingAt: r.noMeetingBefore,
    },
    killersCount: r.players.filter(q => q.role === 'killer').length,
  };
  if (r.meeting && (r.phase === 'meeting' || r.phase === 'result')) {
    const m = r.meeting;
    v.meeting = {
      endAt: m.endAt, reason: m.reason, caller: getP(r, m.callerId)?.name, hints: m.hints, chat: m.chat.slice(-40),
      voted: Object.keys(m.votes), myVote: m.votes[p.id] || null,
    };
  }
  if (r.phase === 'result') v.result = r.result;
  if (r.phase === 'end') v.end = { winner: r.winner, reason: r.winReason, ranking: r.ranking };
  return v;
}
function push(r, p) {
  if (!p.res) return;
  try { p.res.write('data: ' + JSON.stringify(view(r, p)) + '\n\n'); } catch (e) { p.res = null; }
}
const broadcast = r => r.players.forEach(p => push(r, p));

// ---------- Reglas ----------
function startGame(r) {
  const ps = r.players.filter(p => !p.left);
  r.players = ps;
  const roles = shuffle(ps.map((_, i) => i));
  const nk = killersFor(ps.length);
  ps.forEach(p => {
    Object.assign(p, {
      role: 'innocent', alive: true, revealed: false, room: 'cafe', from: 'cafe', moving: null, doing: null, tasks: [], scans: [],
      score: 0, meetingsLeft: 1, stats: { kills: 0, tasks: 0, correct: 0, shots: 0 }, notes: p.notes.slice(-1),
    });
  });
  roles.slice(0, nk).forEach(i => ps[i].role = 'killer');
  ps[roles[nk]].role = 'detective';
  const now = Date.now();
  ps.forEach(p => {
    const rs = shuffle(ROOM_IDS.slice()).slice(0, CFG.tasksPerPlayer);
    p.tasks = rs.map((room, i) => ({ id: 't' + i, room, type: TASK_TYPES[rnd(TASK_TYPES.length)], done: false, fake: p.role === 'killer' }));
    p.killReadyAt = now + CFG.revealMs + CFG.firstKillCd;
    p.shootReadyAt = now + CFG.revealMs + 10000;
    p.scanReadyAt = now + CFG.revealMs + 5000;
    p.sabReadyAt = now + CFG.revealMs + 30000;
  });
  r.bodies = []; r.visits = []; r.meeting = null; r.result = null; r.winner = null; r.ranking = null; r.blackoutUntil = 0;
  r.noMeetingBefore = now + CFG.revealMs + CFG.noMeetingAfter;
  r.phase = 'reveal'; r.phaseEnd = now + CFG.revealMs;
}

function checkWin(r) {
  if (r.phase === 'lobby' || r.phase === 'end') return false;
  const ka = killersAlive(r).length, ga = goodAlive(r).length;
  const pr = progress(r);
  if (ka === 0) return endGame(r, 'innocents', 'Todos los traidores han sido eliminados.');
  if (pr.total && pr.done >= pr.total) return endGame(r, 'innocents', 'Los agentes completaron todas las tareas.');
  if (ka >= ga) return endGame(r, 'killers', 'Los traidores dominan la base.');
  return false;
}
function endGame(r, winner, reason) {
  r.winner = winner; r.winReason = reason; r.phase = 'end'; r.phaseEnd = 0;
  r.players.forEach(p => {
    const team = p.role === 'killer' ? 'killers' : 'innocents';
    if (team === winner) p.score += 40;
    if (p.alive) p.score += 10;
    if (p.role === 'killer' && p.alive) p.score += 20; // traidor sin ser descubierto
  });
  r.ranking = r.players.map(p => ({ id: p.id, name: p.name, color: p.color, role: p.role, score: p.score, alive: p.alive, kills: p.stats.kills, tasks: p.stats.tasks, correct: p.stats.correct, won: (p.role === 'killer' ? 'killers' : 'innocents') === winner }))
    .sort((a, b) => b.score - a.score);
  return true;
}

function startMeeting(r, caller, reason, bodyRoom) {
  const now = Date.now();
  const hints = [];
  if (reason === 'body') {
    const near = [...new Set(r.visits.filter(v => v.room === bodyRoom && now - v.t < 45000 && v.pid !== caller.id).map(v => v.pid))]
      .map(id => getP(r, id)).filter(Boolean).map(p => p.name);
    hints.push('Cuerpo hallado en: ' + ROOM_NAME[bodyRoom]);
    hints.push(near.length ? 'Pasaron por esa sala hace poco: ' + near.join(', ') + ' (no es una prueba definitiva)' : 'Nadie más fue visto cerca de esa sala.');
    const dead = r.bodies.map(b => getP(r, b.pid)?.name).filter(Boolean);
    if (dead.length) hints.push('Víctimas: ' + dead.join(', '));
  } else hints.push('Reunión de emergencia convocada en la Cafetería.');
  r.bodies = [];
  r.players.forEach(p => { p.room = 'cafe'; p.from = 'cafe'; p.moving = null; p.doing = null; });
  r.meeting = { callerId: caller.id, reason, hints, chat: [], votes: {}, endAt: now + CFG.meetingMs };
  r.phase = 'meeting'; r.phaseEnd = r.meeting.endAt;
  r.blackoutUntil = 0;
}

function endMeeting(r) {
  const m = r.meeting;
  const tally = {};
  Object.entries(m.votes).forEach(([voter, t]) => { tally[t] = (tally[t] || 0) + 1; });
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const res = { kind: 'none', tally, votes: m.votes, ejectedId: null, role: null, name: null };
  if (sorted.length && sorted[0][0] !== 'skip' && (!sorted[1] || sorted[1][1] < sorted[0][1])) {
    const ej = getP(r, sorted[0][0]);
    if (ej) {
      ej.alive = false; ej.revealed = true;
      res.kind = 'eject'; res.ejectedId = ej.id; res.role = ej.role; res.name = ej.name;
      if (ej.role === 'killer') Object.entries(m.votes).forEach(([voter, t]) => { if (t === ej.id) { const v = getP(r, voter); if (v && v.role !== 'killer') { v.score += 15; v.stats.correct++; } } });
      else killersAlive(r).forEach(k => k.score += 10); // engañar al grupo
    }
  } else if (sorted.length && sorted[0][0] !== 'skip') res.kind = 'tie';
  r.result = res; r.phase = 'result'; r.phaseEnd = Date.now() + CFG.resultMs;
}

function resumePlay(r) {
  const now = Date.now();
  r.phase = 'play'; r.phaseEnd = 0; r.meeting = null;
  r.players.forEach(p => {
    p.killReadyAt = Math.max(p.killReadyAt, now + CFG.afterMeetingCd);
    p.shootReadyAt = Math.max(p.shootReadyAt, now + 8000);
    p.scanReadyAt = Math.max(p.scanReadyAt, now + 5000);
    p.sabReadyAt = Math.max(p.sabReadyAt, now + 20000);
  });
  r.noMeetingBefore = now + CFG.noMeetingAfter;
}

function toLobby(r) {
  r.phase = 'lobby'; r.meeting = null; r.result = null; r.bodies = []; r.winner = null; r.ranking = null; r.phaseEnd = 0;
  r.players = r.players.filter(p => !p.left && (p.connected || Date.now() - p.lastSeen < 60000));
  r.players.forEach(p => { p.role = null; p.alive = true; p.revealed = false; p.tasks = []; p.moving = null; p.doing = null; p.room = 'cafe'; });
  if (!r.players.find(p => p.id === r.hostId)) r.hostId = r.players[0]?.id || null;
}

// ---------- Acciones ----------
function act(r, p, d) {
  const now = Date.now();
  const type = d.type;
  const playing = r.phase === 'play';
  const tgt = () => { const t = getP(r, d.target); return t && t.id !== p.id ? t : null; };
  const sameRoom = t => t && t.alive && t.room && t.room === p.room && !t.moving && p.room && !p.moving;

  switch (type) {
    case 'start':
      if (r.phase !== 'lobby' || p.id !== r.hostId) return 'No puedes iniciar.';
      if (r.players.length < MIN_PLAYERS) return `Se necesitan al menos ${MIN_PLAYERS} jugadores.`;
      startGame(r); break;
    case 'again':
      if (r.phase !== 'end' || p.id !== r.hostId) return 'Solo el anfitrión.';
      toLobby(r); break;
    case 'leave':
      if (r.phase === 'lobby') {
        r.players = r.players.filter(q => q.id !== p.id);
        if (r.hostId === p.id) r.hostId = r.players[0]?.id || null;
      } else { p.left = true; p.alive = false; p.res && p.res.end(); p.res = null; checkWin(r); }
      break;
    case 'move': {
      if (!playing || p.moving || !adj[p.room]?.includes(d.to)) return null;
      p.doing = null; p.from = p.room;
      p.moving = { to: d.to, arriveAt: now + CFG.travel };
      if (p.alive) r.visits.push({ pid: p.id, room: p.room, t: now });
      p.room = null; break;
    }
    case 'task_start': {
      if (!playing || p.moving || !p.room) return null;
      const t = p.tasks.find(x => x.id === d.id);
      if (!t || t.done || t.room !== p.room) return 'Tarea no disponible aquí.';
      p.doing = { id: t.id, at: now }; break;
    }
    case 'task_done': {
      if (!playing || !p.doing || p.doing.id !== d.id || p.moving) return null;
      const t = p.tasks.find(x => x.id === d.id);
      if (!t || t.done || t.room !== p.room) return null;
      if (now - p.doing.at < CFG.minTaskMs) return 'Demasiado rápido.';
      t.done = true; p.doing = null;
      if (!t.fake) { p.score += 10; p.stats.tasks++; note(p, '+10 puntos · tarea completada', 'good'); }
      else note(p, 'Tarea completada (falsa). ¡Parece real!', 'info');
      checkWin(r); break;
    }
    case 'task_cancel': p.doing = null; break;
    case 'kill': {
      const t = tgt();
      if (!playing || !p.alive || p.role !== 'killer' || now < p.killReadyAt || !sameRoom(t) || t.role === 'killer') return null;
      t.alive = false; t.doing = null;
      r.bodies.push({ pid: t.id, room: p.room });
      p.killReadyAt = now + CFG.killCd; p.stats.kills++; p.score += 20;
      note(p, `Has eliminado a ${t.name}. +20`, 'bad');
      note(t, 'Te han asesinado. Sigue ayudando como fantasma: ¡completa tareas!', 'kill');
      checkWin(r); break;
    }
    case 'shoot': {
      const t = tgt();
      if (!playing || !p.alive || p.role !== 'detective' || now < p.shootReadyAt || !sameRoom(t)) return null;
      p.shootReadyAt = now + CFG.shootCd; p.stats.shots++;
      if (t.role === 'killer') {
        t.alive = false; t.revealed = true; t.doing = null; p.score += 30;
        r.bodies.push({ pid: t.id, room: p.room });
        note(p, `¡Has abatido a ${t.name}, era un TRAIDOR! +30`, 'good');
        note(t, 'El detective te ha abatido.', 'kill');
        noteAll(r, '¡Un disparo! Un traidor ha caído.', 'good', q => q.id !== p.id && q.id !== t.id);
      } else {
        p.alive = false; p.doing = null;
        r.bodies.push({ pid: p.id, room: p.room });
        note(p, `${t.name} era inocente. Tu culpa te mata.`, 'kill');
        noteAll(r, `El detective ${p.name} falló el disparo y ha caído.`, 'bad', q => q.id !== p.id && q.alive && q.room === r.bodies[r.bodies.length - 1].room);
      }
      checkWin(r); break;
    }
    case 'scan': {
      const t = tgt();
      if (!playing || !p.alive || p.role !== 'detective' || now < p.scanReadyAt || !sameRoom(t)) return null;
      p.scanReadyAt = now + CFG.scanCd;
      const truth = t.role === 'killer';
      const flag = Math.random() < CFG.scanAccuracy ? truth : !truth;
      p.scans.push({ pid: t.id, sus: flag });
      note(p, flag ? `${t.name}: rastros sospechosos (no es 100% fiable)` : `${t.name}: parece limpio (no es 100% fiable)`, flag ? 'bad' : 'good');
      break;
    }
    case 'sabotage': {
      if (!playing || !p.alive || p.role !== 'killer' || now < p.sabReadyAt) return null;
      p.sabReadyAt = now + CFG.sabCd; r.blackoutUntil = now + CFG.sabDur;
      noteAll(r, '¡APAGÓN! No distinguirás quién está contigo durante unos segundos.', 'bad', q => q.role !== 'killer' && q.alive);
      note(p, 'Apagón activado.', 'info'); break;
    }
    case 'report': {
      if (!playing || !p.alive || p.moving || !p.room || !r.bodies.some(b => b.room === p.room)) return null;
      startMeeting(r, p, 'body', p.room); break;
    }
    case 'emergency': {
      if (!playing || !p.alive || p.moving || p.room !== 'cafe' || p.meetingsLeft < 1 || now < r.noMeetingBefore) return 'Aún no puedes convocar una reunión.';
      p.meetingsLeft--; startMeeting(r, p, 'emergency'); break;
    }
    case 'chat': {
      if (r.phase !== 'meeting' || !p.alive) return null;
      const text = String(d.text || '').replace(/[<>]/g, '').trim().slice(0, 140);
      if (!text) return null;
      r.meeting.chat.push({ n: p.name, c: p.color, t: text }); break;
    }
    case 'vote': {
      if (r.phase !== 'meeting' || !p.alive) return null;
      if (d.target !== 'skip') { const t = getP(r, d.target); if (!t || !t.alive) return null; }
      r.meeting.votes[p.id] = d.target;
      if (alivePl(r).every(q => r.meeting.votes[q.id])) r.meeting.endAt = Math.min(r.meeting.endAt, now + 2500), r.phaseEnd = r.meeting.endAt;
      break;
    }
    default: return 'Acción desconocida.';
  }
  return null;
}

// ---------- Temporizadores ----------
function tick() {
  const now = Date.now();
  for (const r of rooms.values()) {
    let changed = false;
    if (r.phase === 'reveal' && now >= r.phaseEnd) { r.phase = 'play'; r.phaseEnd = 0; changed = true; }
    if (r.phase === 'play' || r.phase === 'reveal') {
      r.players.forEach(p => {
        if (p.moving && now >= p.moving.arriveAt) {
          p.room = p.moving.to; p.moving = null; changed = true;
          if (p.alive) r.visits.push({ pid: p.id, room: p.room, t: now });
        }
      });
      if (r.visits.length > 400) r.visits = r.visits.filter(v => now - v.t < 60000);
      if (r.blackoutUntil && now >= r.blackoutUntil) { r.blackoutUntil = 0; changed = true; }
    }
    if (r.phase === 'meeting' && now >= r.meeting.endAt) { endMeeting(r); changed = true; }
    if (r.phase === 'result' && now >= r.phaseEnd) { if (!checkWin(r)) resumePlay(r); changed = true; }
    // desconexiones
    r.players.forEach(p => { if (p.res && !p.connected) p.connected = true; });
    if (r.phase === 'lobby') {
      const before = r.players.length;
      r.players = r.players.filter(p => p.connected || now - p.lastSeen < 20000);
      if (r.players.length !== before) { if (!getP(r, r.hostId)) r.hostId = r.players[0]?.id || null; changed = true; }
    }
    if (changed) broadcast(r);
    if (!r.players.some(p => p.connected) && now - Math.max(...r.players.map(p => p.lastSeen), r.created) > 5 * 60000) rooms.delete(r.code);
  }
}
setInterval(tick, 400);
setInterval(() => { for (const r of rooms.values()) r.players.forEach(p => { if (p.res) try { p.res.write(': ping\n\n'); } catch (e) { } }); }, 15000);

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function body(req) {
  return new Promise(res => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 5000) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch (e) { res({}); } });
  });
}
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
function auth(d) {
  const r = rooms.get(String(d.code || '').toUpperCase());
  const p = r && getP(r, d.pid);
  return r && p && p.token === d.token ? { r, p } : null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/api/stream') {
      const a = auth({ code: u.searchParams.get('code'), pid: u.searchParams.get('pid'), token: u.searchParams.get('token') });
      if (!a) return json(res, 404, { error: 'Sala o jugador no encontrado.' });
      const { r, p } = a;
      if (p.res) try { p.res.end(); } catch (e) { }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      p.res = res; p.connected = true; p.lastSeen = Date.now();
      req.on('close', () => { if (p.res === res) { p.res = null; p.connected = false; p.lastSeen = Date.now(); broadcast(r); } });
      push(r, p); broadcast(r); return;
    }
    if (req.method === 'POST' && u.pathname === '/api/create') {
      const d = await body(req);
      const r = newRoom(); const p = makePlayer(d.name, r);
      r.players.push(p); r.hostId = p.id;
      return json(res, 200, { code: r.code, pid: p.id, token: p.token });
    }
    if (req.method === 'POST' && u.pathname === '/api/join') {
      const d = await body(req);
      const r = rooms.get(String(d.code || '').toUpperCase().trim());
      if (!r) return json(res, 404, { error: 'No existe esa sala.' });
      if (r.phase !== 'lobby') return json(res, 400, { error: 'La partida ya ha empezado.' });
      if (r.players.length >= MAX_PLAYERS) return json(res, 400, { error: 'Sala llena (máx. 10).' });
      const p = makePlayer(d.name, r); r.players.push(p);
      return json(res, 200, { code: r.code, pid: p.id, token: p.token });
    }
    if (req.method === 'POST' && u.pathname === '/api/act') {
      const d = await body(req);
      const a = auth(d);
      if (!a) return json(res, 404, { error: 'Sesión no válida.' });
      const err = act(a.r, a.p, d);
      a.p.lastSeen = Date.now();
      broadcast(a.r);
      return json(res, 200, { ok: !err, error: err });
    }
    if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
    // estáticos
    let f = u.pathname === '/' ? '/index.html' : u.pathname;
    const fp = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!fp.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e); try { json(res, 500, { error: 'Error interno' }); } catch (_) { } }
}).listen(PORT, () => console.log('Traitor Protocol en http://localhost:' + PORT));

module.exports = { rooms, CFG };
