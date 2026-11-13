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
function addMessage(roomId, from, text) {
  const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), room: roomId, from, text, at: Date.now() };
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
app.get('/admin/config', adminAuth, (req, res) => res.json({ password: ADMIN_PASSWORD, rooms: rooms.map((r) => ({ ...r, slug: roomSlug(r.id) })), baseUrl: baseUrl(req) }));

// QR 이미지 (직원만)
app.get('/api/qr/:room.png', adminAuth, async (req, res) => {
  const room = roomById[req.params.room];
  if (!room) return res.status(404).end();
  const url = `${baseUrl(req)}/r/${roomSlug(room.id)}`;
  res.type('png');
  res.send(await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: 'M' }));
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
