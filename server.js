// 벌툰 채팅 - 방별 QR 채팅앱 - 손님(방) <-> 직원(관리자) 실시간 채팅 서버
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const crypto = require('crypto');

// ---------- 설정 (환경변수로 변경 가능) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';          // 직원 화면 비밀번호
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT || '40', 10);      // 방 개수 (1번방 ~ N번방)
const ROOM_NAMES = process.env.ROOM_NAMES                              // 직접 이름 지정 시: "101호,102호,201호"
  ? process.env.ROOM_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const BASE_URL = process.env.BASE_URL || '';                           // QR에 들어갈 주소 (예: https://chat.mycamp.com)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');                 // 영구 디스크 경로
const DATA_FILE = path.join(DATA_DIR, 'messages.json');

// ---------- 방 비밀 코드 ----------
// QR 주소는 /r/1-a8f3k2c1 처럼 방 번호 뒤에 비밀 코드가 붙습니다. 번호만 바꿔서는 다른 방에 못 들어갑니다.
// ROOM_SECRET 환경변수가 없으면 처음 실행 때 만들어 data/secret.txt 에 저장합니다. (바뀌면 인쇄한 QR이 전부 무효가 되니 주의)
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
let ROOM_SECRET = process.env.ROOM_SECRET || '';
if (!ROOM_SECRET) {
  try { ROOM_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
  if (!ROOM_SECRET) {
    ROOM_SECRET = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, ROOM_SECRET);
  }
}
function roomToken(id) { return crypto.createHmac('sha256', ROOM_SECRET).update(String(id)).digest('base64url').slice(0, 8).toLowerCase(); }
function roomSlug(id) { return `${id}-${roomToken(id)}`; }
// "1-a8f3k2c1" -> "1" (코드가 틀리면 null)
function parseSlug(slug) {
  const m = /^(\d+)-([a-z0-9_-]{8})$/.exec(String(slug || ''));
  if (!m || !roomById[m[1]]) return null;
  const expected = roomToken(m[1]);
  return expected.length === m[2].length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2])) ? m[1] : null;
}

// ---------- 방 목록 ----------
const rooms = ROOM_NAMES
  ? ROOM_NAMES.map((name, i) => ({ id: String(i + 1), name }))
  : Array.from({ length: ROOM_COUNT }, (_, i) => ({ id: String(i + 1), name: `${i + 1}번방` }));
const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));

// ---------- 메시지 저장 (JSON 파일) ----------
let store = { messages: {}, lastRead: {} }; // messages[roomId] = [...], lastRead[roomId] = timestamp
try {
  if (fs.existsSync(DATA_FILE)) store = Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) {
  console.error('저장 파일을 읽지 못했습니다. 새로 시작합니다.', e.message);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store));
  }, 300);
}
function history(roomId) {
  return store.messages[roomId] || [];
}
// ---------- 통계용 기록: 대화를 비워도 남는 한 줄짜리 로그 (data/stats.jsonl) ----------
const STATS_FILE = path.join(DATA_DIR, 'stats.jsonl');
let statsLog = [];
try { statsLog = fs.readFileSync(STATS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {}
function logStat(msg) {
  const row = { room: msg.room, from: msg.from, text: msg.text, at: msg.at };
  statsLog.push(row);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFile(STATS_FILE, JSON.stringify(row) + '\n', () => {});
}
function buildStats(days) {
  const now = Date.now();
  const dayMs = 86400000;
  const since = now - days * dayMs;
  const rows = statsLog.filter((r) => r.at >= since);
  const guest = rows.filter((r) => r.from === 'guest');
  const kst = (ts) => new Date(ts + 9 * 3600000); // 한국 시간
  const dayKey = (ts) => kst(ts).toISOString().slice(0, 10);
  const todayKey = dayKey(now);
  const weekSince = now - 7 * dayMs;
  // 방별
  const byRoom = {};
  rooms.forEach((r) => { byRoom[r.id] = { id: r.id, name: r.name, guest: 0, staff: 0, last: null }; });
  rows.forEach((r) => { const b = byRoom[r.room]; if (!b) return; b[r.from === 'guest' ? 'guest' : 'staff']++; if (!b.last || r.at > b.last) b.last = r.at; });
  // 문구별 (손님)
  const byText = {};
  guest.forEach((r) => { byText[r.text] = (byText[r.text] || 0) + 1; });
  // 시간대별 / 일별 (손님 메시지)
  const byHour = Array.from({ length: 24 }, () => 0);
  guest.forEach((r) => { byHour[kst(r.at).getUTCHours()]++; });
  const byDay = {};
  for (let i = days - 1; i >= 0; i--) byDay[dayKey(now - i * dayMs)] = 0;
  guest.forEach((r) => { const k = dayKey(r.at); if (k in byDay) byDay[k]++; });
  // 응답 시간: 손님 메시지 뒤 같은 방의 첫 직원 답장까지 (2시간 넘으면 제외)
  const waits = [];
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const open = {}; // room -> 첫 미응답 손님 메시지 시각
  sorted.forEach((r) => {
    if (r.from === 'guest') { if (!(r.room in open)) open[r.room] = r.at; }
    else if (r.room in open) { const w = r.at - open[r.room]; if (w <= 2 * 3600000) waits.push(w); delete open[r.room]; }
  });
  waits.sort((a, b) => a - b);
  const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
  const medWait = waits.length ? waits[Math.floor(waits.length / 2)] : null;
  const unanswered = Object.keys(open).length;
  return {
    days,
    totals: {
      today: guest.filter((r) => dayKey(r.at) === todayKey).length,
      week: guest.filter((r) => r.at >= weekSince).length,
      period: guest.length,
      all: statsLog.filter((r) => r.from === 'guest').length,
      staffPeriod: rows.length - guest.length,
      activeRooms: Object.values(byRoom).filter((b) => b.guest > 0).length,
      avgWait, medWait, answered: waits.length, unanswered,
    },
    byRoom: Object.values(byRoom).sort((a, b) => b.guest - a.guest || Number(a.id) - Number(b.id)),
    byText: Object.entries(byText).map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n).slice(0, 10),
    byHour,
    byDay: Object.entries(byDay).map(([day, n]) => ({ day, n })),
  };
}

function addMessage(roomId, from, text) {
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), room: roomId, from, text, at: Date.now() };
  logStat(msg);
  if (!store.messages[roomId]) store.messages[roomId] = [];
  store.messages[roomId].push(msg);
  if (store.messages[roomId].length > 500) store.messages[roomId] = store.messages[roomId].slice(-500);
  save();
  return msg;
}
function roomSummary(roomId) {
  const msgs = history(roomId);
  const last = msgs[msgs.length - 1] || null;
  const lastRead = store.lastRead[roomId] || 0;
  const unread = msgs.filter((m) => m.from === 'guest' && m.at > lastRead).length;
  return { ...roomById[roomId], last, unread };
}
function allSummaries() {
  return rooms.map((r) => roomSummary(r.id));
}

// ---------- 웹 서버 ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

function baseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

// 직원 화면 보호 (간단한 Basic 인증)
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pw] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pw === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="staff"');
  res.status(401).send('직원 전용 페이지입니다. 비밀번호를 입력하세요.');
}

app.get('/', (req, res) => res.redirect('/admin'));

// 손님 페이지: QR에 담기는 주소  /r/1-a8f3k2c1 ...
app.get('/r/:slug', (req, res) => {
  if (!parseSlug(req.params.slug)) return res.status(404).send('<meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>잘못된 주소입니다</h2><p>방에 붙어 있는 QR을 다시 찍어 주세요.</p></body>');
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});

// 직원 페이지
app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/qr', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'qr.html')));
app.get('/admin/stats', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
// 기록 전체 삭제 (대화 + 통계). 직원 인증 필요, 통계 페이지의 버튼에서 호출
app.post('/admin/reset', adminAuth, (req, res) => {
  store = { messages: {}, lastRead: {} };
  save();
  statsLog = [];
  try { fs.writeFileSync(STATS_FILE, ''); } catch (e) {}
  rooms.forEach((r) => io.to(`room:${r.id}`).emit('cleared'));
  io.to('staff').emit('reset');
  io.to('staff').emit('rooms', allSummaries());
  console.log('기록 전체 삭제됨');
  res.json({ ok: true });
});
app.get('/admin/stats.json', adminAuth, (req, res) => res.json(buildStats(Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30)))));
app.get('/admin/config', adminAuth, (req, res) => res.json({ password: ADMIN_PASSWORD, rooms: rooms.map((r) => ({ ...r, slug: roomSlug(r.id) })), baseUrl: baseUrl(req) }));

// QR 이미지 (직원만)
app.get('/api/qr/:room.png', adminAuth, async (req, res) => {
  const room = roomById[req.params.room];
  if (!room) return res.status(404).end();
  const url = `${baseUrl(req)}/r/${roomSlug(room.id)}`;
  res.type('png');
  res.send(await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: 'M' }));
});
// 동그란 점 스타일 QR (SVG). 오류 정정 레벨 H라 점 스타일로도 잘 찍힘
app.get('/api/qr/:room.svg', adminAuth, (req, res) => {
  const room = roomById[req.params.room];
  if (!room) return res.status(404).end();
  const url = `${baseUrl(req)}/r/${roomSlug(room.id)}`;
  const qr = QRCode.create(url, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size, data = qr.modules.data;
  const dark = req.query.color ? '#' + String(req.query.color).replace(/[^0-9a-f]/gi, '').slice(0, 6) : '#1e1b4b';
  const accent = req.query.accent ? '#' + String(req.query.accent).replace(/[^0-9a-f]/gi, '').slice(0, 6) : '#f43f5e';
  const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  let dots = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!data[r * n + c] || isFinder(r, c)) continue;
    dots += `<circle cx="${c + 0.5}" cy="${r + 0.5}" r="0.43"/>`;
  }
  const finder = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7" rx="2.2" fill="${accent}"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1" fill="${accent}"/>`;
  res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="geometricPrecision"><rect width="${n}" height="${n}" fill="#fff"/><g fill="${dark}">${dots}</g>${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`);
});
app.get('/api/rooms', (req, res) => res.json(rooms));

// ---------- 실시간 소켓 ----------
io.on('connection', (socket) => {
  // 손님 입장
  socket.on('guest:join', ({ room: slug }, cb) => {
    const room = parseSlug(slug);
    if (!room) return cb && cb({ error: '잘못된 주소입니다. QR을 다시 찍어 주세요.' });
    socket.data.role = 'guest';
    socket.data.room = room;
    socket.join(`room:${room}`);
    cb && cb({ room: roomById[room], messages: history(room) });
  });

  // 손님 메시지
  socket.on('guest:message', ({ text }, cb) => {
    const room = socket.data.room;
    if (socket.data.role !== 'guest' || !room) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const msg = addMessage(room, 'guest', text);
    io.to(`room:${room}`).emit('message', msg);
    io.to('staff').emit('message', msg);
    io.to('staff').emit('rooms', allSummaries());
    cb && cb({ ok: true });
  });

  // 직원 입장
  socket.on('staff:join', ({ password }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb && cb({ error: '비밀번호가 틀렸습니다.' });
    socket.data.role = 'staff';
    socket.join('staff');
    cb && cb({ rooms: allSummaries(), messages: store.messages });
  });

  // 직원 답장
  socket.on('staff:message', ({ room, text }, cb) => {
    if (socket.data.role !== 'staff' || !roomById[room]) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const msg = addMessage(room, 'staff', text);
    io.to(`room:${room}`).emit('message', msg);
    io.to('staff').emit('message', msg);
    io.to('staff').emit('rooms', allSummaries());
    cb && cb({ ok: true });
  });

  // 직원이 방을 열어봄 -> 읽음 처리
  socket.on('staff:read', ({ room }) => {
    if (socket.data.role !== 'staff' || !roomById[room]) return;
    store.lastRead[room] = Date.now();
    save();
    io.to('staff').emit('rooms', allSummaries());
  });

  // 직원이 방 대화 비우기 (퇴실 처리)
  socket.on('staff:clear', ({ room }) => {
    if (socket.data.role !== 'staff' || !roomById[room]) return;
    store.messages[room] = [];
    store.lastRead[room] = Date.now();
    save();
    io.to(`room:${room}`).emit('cleared');
    io.to('staff').emit('cleared', { room });
    io.to('staff').emit('rooms', allSummaries());
  });
});

server.listen(PORT, () => {
  console.log(`방 채팅 서버 실행 중: http://localhost:${PORT}`);
  console.log(`직원 화면: http://localhost:${PORT}/admin  (비밀번호: ${ADMIN_PASSWORD})`);
  console.log(`QR 인쇄:   http://localhost:${PORT}/admin/qr`);
  console.log(`방 개수: ${rooms.length}`);
});
