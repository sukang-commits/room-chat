// 벌툰 채팅 - 방별 QR 채팅앱 - 손님(방) <-> 직원(관리자) 실시간 채팅 서버
// 매장 여러 개를 한 서버에서 운영합니다. 매장마다 대화·통계·설정·사진·QR 비밀코드·비밀번호가 따로 저장됩니다.
//   기본 매장(main): /admin, /r/<코드>              (환경변수 ADMIN_PASSWORD·ROOM_COUNT 로 설정)
//   추가 매장      : /s/<매장아이디>/admin, /s/<매장아이디>/r/<코드>   (/hq 본사 페이지에서 추가)
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const crypto = require('crypto');

// ---------- 설정 (환경변수로 변경 가능) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1234';          // 기본 매장 직원 비밀번호
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || ADMIN_PASSWORD; // 본사 비밀번호: 모든 매장 화면 + /hq 에 쓸 수 있음
const ROOM_COUNT = parseInt(process.env.ROOM_COUNT || '40', 10);      // 기본 매장 방 개수 (1번방 ~ N번방)
const ROOM_NAMES = process.env.ROOM_NAMES                              // 기본 매장 방 이름 직접 지정 시: "101호,102호,201호"
  ? process.env.ROOM_NAMES.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const BASE_URL = process.env.BASE_URL || '';                           // QR에 들어갈 주소 (예: https://chat.mycamp.com)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');  // 영구 디스크 경로
const STORES_FILE = path.join(DATA_DIR, 'stores.json');                // 추가 매장 목록
const KST_OFFSET = 9 * 3600000;

const DEFAULT_SETTINGS = {
  guestButtons: [
    { id: 'cold', label: '추워요 🥶', on: false, reply: '', image: '', keywords: [] },
    { id: 'hot', label: '더워요 🥵', on: false, reply: '', image: '', keywords: [] },
    { id: 'noise', label: '시끄러워요 🔇', on: false, reply: '', image: '', keywords: [] },
    { id: 'ott', label: 'OTT 어떻게 해요? 📺', on: false, reply: '리모컨 사용 순서를 여기에 적어 주세요.\n1. \n2. \n3. \n그래도 안 되면 직원이 바로 가겠습니다.', image: '', keywords: ['ott', '넷플', '유튜브', '리모컨', '티비', 'tv', '빔프'] },
    { id: 'adult', label: '성인인증 비밀번호가 뭐예요? 🔑', on: false, reply: '성인인증 비밀번호: (여기에 입력)\n입력해도 안 되면 직원이 바로 가겠습니다.', image: '', keywords: ['성인', '인증', '성인인증', '19금'] },
    { id: 'wifi', label: '와이파이가 안돼요', on: false, reply: '와이파이 이름: (여기에 입력)\n비밀번호: (여기에 입력)\n연결이 계속 안 되면 직원이 바로 가겠습니다.', image: '', keywords: ['와이파이', 'wifi', '비밀번호', '비번', '인터넷'] },
  ],
  staffReplies: ['에어컨 온도 올려드릴게요', '에어컨 온도 낮춰드릴게요', '시끄러운 방 알려주시면 주의 드릴게요', 'OTT 어떤 게 안되실까요?', '바로 가겠습니다', '카운터로 와주세요'],
  // 손님 채팅 맨 위에 항상 보이는 안내 카드 (리뷰 이벤트 등)
  event: { on: false, title: '리뷰 이벤트 🎁', text: '네이버 리뷰 남기고 카운터에서 뽑기권 받아 가세요!', link: '', linkLabel: '네이버 리뷰 쓰러 가기', image: '' },
  migrations: ['adult-pin'],   // 기본값에는 이미 들어 있으므로 다시 끼워 넣지 않음
};

const STORE_ID_RE = /^[a-z0-9][a-z0-9-]{1,19}$/;
const RESERVED_IDS = new Set(['main', 'admin', 'hq', 'api', 'r', 's', 'uploads', 'socket.io']);
function makeRooms(count, names) {
  return names && names.length
    ? names.map((name, i) => ({ id: String(i + 1), name }))
    : Array.from({ length: Math.max(1, Math.min(500, count || 1)) }, (_, i) => ({ id: String(i + 1), name: `${i + 1}번방` }));
}

// =====================================================================
// 매장 하나: 방 목록 + 대화 + 통계 로그 + 설정 + 비밀 코드. 파일은 매장 폴더에 저장
// =====================================================================
function createStore(id, cfg) {
  const isMain = id === 'main';
  const dir = isMain ? DATA_DIR : path.join(DATA_DIR, 'stores', id);     // 기본 매장은 예전 그대로 data/ 바로 아래
  const uploadDir = path.join(dir, 'uploads');
  const uploadUrl = isMain ? '/uploads/' : `/uploads/${id}/`;
  const urlBase = isMain ? '' : `/s/${id}`;                                // 페이지·API 주소 앞에 붙는 부분
  fs.mkdirSync(dir, { recursive: true });

  const S = { id, isMain, dir, uploadDir, uploadUrl, urlBase, name: cfg.name || (isMain ? '벌툰' : id), password: cfg.password || '' };
  S.rooms = makeRooms(cfg.roomCount, cfg.roomNames);
  S.roomById = Object.fromEntries(S.rooms.map((r) => [r.id, r]));

  // ---------- 방 비밀 코드 (QR 주소 /r/1-a8f3k2c1 의 뒷부분). 바뀌면 인쇄한 QR이 전부 무효 ----------
  const SECRET_FILE = path.join(dir, 'secret.txt');
  let secret = isMain ? (process.env.ROOM_SECRET || '') : '';
  if (!secret) {
    try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
    if (!secret) { secret = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(SECRET_FILE, secret); }
  }
  S.roomToken = (roomId) => crypto.createHmac('sha256', secret).update(String(roomId)).digest('base64url').slice(0, 8).toLowerCase();
  S.roomSlug = (roomId) => `${roomId}-${S.roomToken(roomId)}`;
  S.parseSlug = (slug) => {                 // "1-a8f3k2c1" -> "1" (코드가 틀리면 null)
    const m = /^(\d+)-([a-z0-9_-]{8})$/.exec(String(slug || ''));
    if (!m || !S.roomById[m[1]]) return null;
    const expected = S.roomToken(m[1]);
    return expected.length === m[2].length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2])) ? m[1] : null;
  };
  S.guestUrl = (base, roomId) => `${base}${urlBase}/r/${S.roomSlug(roomId)}`;

  // ---------- 대화 저장 (messages.json) ----------
  const DATA_FILE = path.join(dir, 'messages.json');
  S.data = { messages: {}, lastRead: {} };
  try { if (fs.existsSync(DATA_FILE)) S.data = Object.assign(S.data, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { console.error(`[${id}] 저장 파일을 읽지 못했습니다. 새로 시작합니다.`, e.message); }
  let saveTimer = null;
  S.save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(S.data)); }, 300); };
  S.history = (roomId) => S.data.messages[roomId] || [];

  // ---------- 통계용 기록 (stats.jsonl): 대화를 비워도 남음 ----------
  const STATS_FILE = path.join(dir, 'stats.jsonl');
  S.statsLog = [];
  try { S.statsLog = fs.readFileSync(STATS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {}
  S.logStat = (msg) => {
    const row = { room: msg.room, from: msg.from, text: msg.text, at: msg.at };
    if (msg.image) row.image = msg.image;
    S.statsLog.push(row);
    fs.appendFile(STATS_FILE, JSON.stringify(row) + '\n', () => {});
  };
  S.addMessage = (roomId, from, text, extra) => {
    const msg = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), room: roomId, from, text, at: Date.now(), ...(extra || {}) };
    S.logStat(msg);
    if (!S.data.messages[roomId]) S.data.messages[roomId] = [];
    S.data.messages[roomId].push(msg);
    if (S.data.messages[roomId].length > 500) S.data.messages[roomId] = S.data.messages[roomId].slice(-500);
    S.save();
    return msg;
  };
  S.roomSummary = (roomId) => {
    const msgs = S.history(roomId);
    const last = [...msgs].reverse().find((m) => m.from !== 'auto') || null;
    const lastRead = S.data.lastRead[roomId] || 0;
    const unread = msgs.filter((m) => m.from === 'guest' && m.at > lastRead).length;
    return { ...S.roomById[roomId], last, unread };
  };
  S.allSummaries = () => S.rooms.map((r) => S.roomSummary(r.id));
  S.reset = () => {
    S.data = { messages: {}, lastRead: {} }; S.save();
    S.statsLog = []; try { fs.writeFileSync(STATS_FILE, ''); } catch (e) {}
  };

  // ---------- 설정: 손님 빠른 버튼 + 자동 답변 + 리뷰 안내 + 직원 빠른 답장 (settings.json) ----------
  const SETTINGS_FILE = path.join(dir, 'settings.json');
  S.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  let hadSaved = false;
  try { Object.assign(S.settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); hadSaved = true; } catch (e) {}
  S.saveSettings = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(S.settings, null, 2)); };
  // 나중에 추가된 기본 버튼을 기존 저장 설정에 한 번만 끼워 넣음 (사용자가 지우면 다시 생기지 않음)
  S.settings.migrations = Array.isArray(S.settings.migrations) ? S.settings.migrations : [];
  if (hadSaved && !S.settings.migrations.includes('adult-pin')) {
    if (!S.settings.guestButtons.some((b) => b.id === 'adult' || /성인/.test(String(b.label)))) {
      const btn = DEFAULT_SETTINGS.guestButtons.find((b) => b.id === 'adult');
      const after = S.settings.guestButtons.findIndex((b) => b.id === 'ott');
      S.settings.guestButtons.splice(after >= 0 ? after + 1 : S.settings.guestButtons.length, 0, JSON.parse(JSON.stringify(btn)));
    }
    S.settings.migrations.push('adult-pin');
    S.saveSettings();
  }
  // "1-10, 15, 22" 같은 방 범위 문자열 -> 방 id 배열 (없는 방은 무시)
  S.parseRoomSpec = (spec) => {
    const ids = new Set();
    String(spec || '').split(/[,\s]+/).filter(Boolean).forEach((tok) => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(tok);
      if (!m) return;
      const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= 500; i++) if (S.roomById[String(i)]) ids.add(String(i));
    });
    return [...ids].sort((x, y) => Number(x) - Number(y));
  };
  // 손님 메시지에 맞는 자동 답변 찾기: 버튼 id → 버튼 문구 그대로 → 키워드(많이 맞는 버튼 우선). 방별 변형이 있으면 그 방 것을 우선
  S.findAutoReply = (text, quickId, roomId) => {
    const t = String(text || '').trim().toLowerCase();
    const list = S.settings.guestButtons || [];
    let b = quickId ? list.find((x) => x.id === quickId) : null;
    if (!b) b = list.find((x) => String(x.label).trim().toLowerCase() === t);
    if (!b) {
      let best = null, bestScore = 0, bestLen = 0;
      for (const x of list) {
        const hits = (x.keywords || []).filter((k) => k && t.includes(String(k).toLowerCase()));
        const len = Math.max(0, ...hits.map((k) => String(k).length));
        if (hits.length > bestScore || (hits.length === bestScore && hits.length && len > bestLen)) { best = x; bestScore = hits.length; bestLen = len; }
      }
      b = best;
    }
    if (!b || !b.on) return null;
    const v = (b.variants || []).find((x) => (x.roomIds || []).includes(String(roomId)));
    const reply = String((v && v.reply) || b.reply || '').trim();
    const image = (v && v.image) || b.image || '';
    if (!reply) return null;
    return { text: reply, image };
  };
  // 관리 화면에서 보낸 설정 검사 + 이미지(base64) 파일로 저장
  S.applySettings = (input) => {
    const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
    const buttons = Array.isArray(input.guestButtons) ? input.guestButtons.slice(0, 10) : [];
    const out = [];
    fs.mkdirSync(uploadDir, { recursive: true });
    const resolveImage = (obj) => {
      let image = clean(obj.image, 200);
      if (!image.startsWith(uploadUrl) || !/^[a-z0-9]+\.(jpg|png|webp)$/.test(image.slice(uploadUrl.length))) image = '';
      const dataUrl = typeof obj.imageData === 'string' ? obj.imageData : '';
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length <= 3 * 1024 * 1024) {
          const name = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
          fs.writeFileSync(path.join(uploadDir, name), buf);
          image = uploadUrl + name;
        }
      }
      return image;
    };
    const newId = (prefix) => prefix + crypto.randomBytes(3).toString('hex');
    for (const b of buttons) {
      const label = clean(b.label, 30);
      if (!label) continue;
      const variants = [];   // 방별 변형(묶음): 방 범위 + 다른 글/사진. 범위가 비면 버림
      for (const v of (Array.isArray(b.variants) ? b.variants.slice(0, 20) : [])) {
        const rooms = clean(v.rooms, 200);
        const roomIds = S.parseRoomSpec(rooms);
        if (!roomIds.length) continue;
        variants.push({ id: /^[a-z0-9_-]{1,20}$/i.test(String(v.id || '')) ? String(v.id) : newId('v'), rooms, roomIds, reply: clean(v.reply, 1000), image: resolveImage(v) });
      }
      out.push({
        id: /^[a-z0-9_-]{1,20}$/i.test(String(b.id || '')) ? String(b.id) : newId('b'),
        label, on: !!b.on, reply: clean(b.reply, 1000), image: resolveImage(b),
        keywords: (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(',')).map((k) => clean(k, 20)).filter(Boolean).slice(0, 10),
        variants,
      });
    }
    if (!out.length) throw new Error('손님 버튼이 하나 이상 필요합니다.');
    const replies = (Array.isArray(input.staffReplies) ? input.staffReplies : String(input.staffReplies || '').split('\n')).map((r) => clean(r, 60)).filter(Boolean).slice(0, 12);
    const ev = input.event && typeof input.event === 'object' ? input.event : {};
    let link = clean(ev.link, 300);
    if (!/^https?:\/\/[^\s]+$/i.test(link)) link = '';
    const event = { on: !!ev.on, title: clean(ev.title, 40), text: clean(ev.text, 500), link, linkLabel: clean(ev.linkLabel, 30) || '자세히 보기', image: resolveImage(ev) };
    S.settings = { ...S.settings, guestButtons: out, staffReplies: replies.length ? replies : DEFAULT_SETTINGS.staffReplies, event };
    S.saveSettings();
    try {   // 더 이상 쓰지 않는 업로드 이미지 정리
      const used = new Set([...out.flatMap((b) => [b.image, ...(b.variants || []).map((v) => v.image)]), event.image].filter(Boolean).map((u) => u.slice(uploadUrl.length)));
      for (const f of fs.readdirSync(uploadDir)) if (!used.has(f)) fs.unlinkSync(path.join(uploadDir, f));
    } catch (e) {}
    return S.settings;
  };

  // ---------- 통계 ----------
  S.buildStats = (days) => {
    const now = Date.now();
    const dayMs = 86400000;
    const since = now - days * dayMs;
    const allRows = S.statsLog.filter((r) => r.at >= since);
    const autoCount = allRows.filter((r) => r.from === 'auto').length;
    const rows = allRows.filter((r) => r.from === 'guest' || r.from === 'staff');   // 자동 답변·퇴실 표시는 직원 응답으로 치지 않음
    const guest = rows.filter((r) => r.from === 'guest');
    const kst = (ts) => new Date(ts + KST_OFFSET);
    const dayKey = (ts) => kst(ts).toISOString().slice(0, 10);
    const todayKey = dayKey(now);
    const weekSince = now - 7 * dayMs;
    const byRoom = {};
    S.rooms.forEach((r) => { byRoom[r.id] = { id: r.id, name: r.name, guest: 0, staff: 0, last: null }; });
    rows.forEach((r) => { const b = byRoom[r.room]; if (!b) return; b[r.from === 'guest' ? 'guest' : 'staff']++; if (!b.last || r.at > b.last) b.last = r.at; });
    const byText = {};
    guest.forEach((r) => { byText[r.text] = (byText[r.text] || 0) + 1; });
    const byHour = Array.from({ length: 24 }, () => 0);
    guest.forEach((r) => { byHour[kst(r.at).getUTCHours()]++; });
    const byDay = {};
    for (let i = days - 1; i >= 0; i--) byDay[dayKey(now - i * dayMs)] = 0;
    guest.forEach((r) => { const k = dayKey(r.at); if (k in byDay) byDay[k]++; });
    // 응답 시간: 손님 메시지 뒤 같은 방의 첫 직원 답장까지 (2시간 넘으면 제외)
    const waits = [];
    const sorted = [...rows].sort((a, b) => a.at - b.at);
    const open = {};
    sorted.forEach((r) => {
      if (r.from === 'guest') { if (!(r.room in open)) open[r.room] = r.at; }
      else if (r.room in open) { const w = r.at - open[r.room]; if (w <= 2 * 3600000) waits.push(w); delete open[r.room]; }
    });
    waits.sort((a, b) => a - b);
    const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null;
    const medWait = waits.length ? waits[Math.floor(waits.length / 2)] : null;
    return {
      days,
      totals: {
        today: guest.filter((r) => dayKey(r.at) === todayKey).length,
        week: guest.filter((r) => r.at >= weekSince).length,
        period: guest.length,
        all: S.statsLog.filter((r) => r.from === 'guest').length,
        staffPeriod: rows.length - guest.length,
        auto: autoCount,
        activeRooms: Object.values(byRoom).filter((b) => b.guest > 0).length,
        avgWait, medWait, answered: waits.length, unanswered: Object.keys(open).length,
      },
      byRoom: Object.values(byRoom).sort((a, b) => b.guest - a.guest || Number(a.id) - Number(b.id)),
      byText: Object.entries(byText).map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n).slice(0, 10),
      byHour,
      byDay: Object.entries(byDay).map(([day, n]) => ({ day, n })),
    };
  };
  // ---------- 대화 기록 조회 ----------
  S.queryLog = (q) => {
    const today = new Date(Date.now() + KST_OFFSET).toISOString().slice(0, 10);
    const from = kstDayStart(q.from) ?? kstDayStart(today);
    const to = (kstDayStart(q.to) ?? kstDayStart(today)) + 86400000 - 1;
    const room = q.room && S.roomById[q.room] ? String(q.room) : '';
    const text = String(q.q || '').trim().toLowerCase();
    const rows = S.statsLog.filter((r) => r.at >= from && r.at <= to && (!room || r.room === room) && (!text || String(r.text).toLowerCase().includes(text)));
    return { from, to, room, text, total: rows.length, rows };
  };
  // 본사 화면용 요약
  S.summary = () => {
    const today = new Date(Date.now() + KST_OFFSET).toISOString().slice(0, 10);
    const todayCount = S.statsLog.filter((r) => r.from === 'guest' && new Date(r.at + KST_OFFSET).toISOString().slice(0, 10) === today).length;
    const unread = S.allSummaries().reduce((n, r) => n + r.unread, 0);
    return { id, name: S.name, isMain, roomCount: S.rooms.length, roomNames: S.rooms.map((r) => r.name), urlBase, todayCount, unread, total: S.statsLog.filter((r) => r.from === 'guest').length };
  };
  return S;
}
function kstDayStart(ymd) {               // 'YYYY-MM-DD'(한국 날짜) -> 그날 00:00 KST 의 epoch ms
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - KST_OFFSET;
}

// =====================================================================
// 매장 목록: 기본 매장(main)은 환경변수, 나머지는 data/stores.json
// =====================================================================
let registry = {};
try { registry = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8')); } catch (e) {}
function saveRegistry() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STORES_FILE, JSON.stringify(registry, null, 2)); }
const stores = {};
stores.main = createStore('main', { name: (registry.main && registry.main.name) || process.env.STORE_NAME || '벌툰', password: ADMIN_PASSWORD, roomCount: ROOM_COUNT, roomNames: ROOM_NAMES });
for (const [id, cfg] of Object.entries(registry)) {
  if (id === 'main' || !STORE_ID_RE.test(id) || RESERVED_IDS.has(id)) continue;
  try { stores[id] = createStore(id, cfg); } catch (e) { console.error(`[${id}] 매장을 불러오지 못했습니다.`, e.message); }
}
function getStore(id) { return stores[id || 'main'] || null; }

// ---------- 웹 서버 ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));
// 업로드 사진: /uploads/<파일>(기본 매장), /uploads/<매장>/<파일>
app.get('/uploads/:store/:file', (req, res, next) => {
  const st = stores[req.params.store];
  if (!st || st.isMain || !/^[a-z0-9]+\.(jpg|png|webp)$/.test(req.params.file)) return next();
  res.sendFile(path.join(st.uploadDir, req.params.file), { maxAge: '7d' }, (err) => { if (err) next(); });
});
app.use('/uploads', express.static(stores.main.uploadDir, { maxAge: '7d' }));

function baseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}
function basicPassword(req) {
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  const idx = Buffer.from(encoded, 'base64').toString().indexOf(':');
  return idx < 0 ? '' : Buffer.from(encoded, 'base64').toString().slice(idx + 1);
}
// 직원 화면 보호: 그 매장 비밀번호 또는 본사 비밀번호. 매장마다 realm 이 달라 브라우저가 매장별로 따로 기억
function adminAuth(req, res, next) {
  const pw = basicPassword(req);
  if (pw !== null && (pw === req.store.password || pw === MASTER_PASSWORD)) return next();
  res.set('WWW-Authenticate', `Basic realm="bultoon-${req.store.id}"`);
  res.status(401).send(`<meta charset="utf-8">${req.store.name} 직원 전용 페이지입니다. 비밀번호를 입력하세요.`);
}
function hqAuth(req, res, next) {
  const pw = basicPassword(req);
  if (pw !== null && pw === MASTER_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="bultoon-hq"');
  res.status(401).send('<meta charset="utf-8">본사 전용 페이지입니다. 본사 비밀번호를 입력하세요.');
}
const pub = (f) => path.join(__dirname, 'public', f);
const fmtKST = (ts) => { const d = new Date(ts + KST_OFFSET); return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16); };
const FROM_LABEL = { guest: '손님', staff: '직원', auto: '자동 답변', system: '시스템' };

// =====================================================================
// 매장 라우터: 기본 매장은 / 아래, 추가 매장은 /s/<매장아이디>/ 아래에 같은 경로로 붙음
// =====================================================================
const storeRouter = express.Router({ mergeParams: true });
storeRouter.use((req, res, next) => {
  const st = getStore(req.params.store);
  if (!st) return res.status(404).send('<meta charset="utf-8">없는 매장입니다.');
  req.store = st;
  next();
});
storeRouter.get('/', (req, res) => res.redirect(`${req.store.urlBase}/admin`));

// 손님 페이지: QR에 담기는 주소  /r/1-a8f3k2c1 ...
storeRouter.get('/r/:slug', (req, res) => {
  if (!req.store.parseSlug(req.params.slug)) return res.status(404).send('<meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><h2>잘못된 주소입니다</h2><p>방에 붙어 있는 QR을 다시 찍어 주세요.</p></body>');
  res.sendFile(pub('guest.html'));
});
storeRouter.get('/api/guest-config', (req, res) => {
  const st = req.store;
  res.json({
    store: { id: st.id, name: st.name },
    buttons: st.settings.guestButtons.map((b) => ({ id: b.id, label: b.label })),
    event: st.settings.event && st.settings.event.on && (st.settings.event.text || st.settings.event.title) ? st.settings.event : null,
  });
});
storeRouter.get('/api/rooms', (req, res) => res.json(req.store.rooms));

// 직원 페이지
storeRouter.get('/admin', adminAuth, (req, res) => res.sendFile(pub('admin.html')));
storeRouter.get('/admin/qr', adminAuth, (req, res) => res.sendFile(pub('qr.html')));
storeRouter.get('/admin/stats', adminAuth, (req, res) => res.sendFile(pub('stats.html')));
storeRouter.get('/admin/log', adminAuth, (req, res) => res.sendFile(pub('log.html')));
storeRouter.get('/admin/settings', adminAuth, (req, res) => res.sendFile(pub('settings.html')));
storeRouter.get('/admin/config', adminAuth, (req, res) => {
  const st = req.store;
  res.json({ store: { id: st.id, name: st.name }, base: st.urlBase, password: st.password, rooms: st.rooms.map((r) => ({ ...r, slug: st.roomSlug(r.id) })), baseUrl: baseUrl(req), guestBase: `${baseUrl(req)}${st.urlBase}`, staffReplies: st.settings.staffReplies });
});
// 기록 전체 삭제 (대화 + 통계). 통계 페이지의 버튼에서 호출
storeRouter.post('/admin/reset', adminAuth, (req, res) => {
  const st = req.store;
  st.reset();
  st.rooms.forEach((r) => io.to(`room:${st.id}:${r.id}`).emit('cleared'));
  io.to(`staff:${st.id}`).emit('reset');
  io.to(`staff:${st.id}`).emit('rooms', st.allSummaries());
  console.log(`[${st.id}] 기록 전체 삭제됨`);
  res.json({ ok: true });
});
storeRouter.get('/admin/log.json', adminAuth, (req, res) => {
  const st = req.store;
  const r = st.queryLog(req.query);
  const LIMIT = 3000;
  res.json({ ...r, store: { id: st.id, name: st.name }, truncated: r.rows.length > LIMIT, rows: r.rows.slice(-LIMIT).map((x) => ({ ...x, roomName: (st.roomById[x.room] || { name: x.room }).name })), roomNames: Object.fromEntries(st.rooms.map((x) => [x.id, x.name])) });
});
storeRouter.get('/admin/log.csv', adminAuth, (req, res) => {
  const st = req.store;
  const r = st.queryLog(req.query);
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = ['일시,방,보낸 쪽,내용,사진'];
  r.rows.forEach((x) => lines.push([fmtKST(x.at), (st.roomById[x.room] || { name: x.room }).name, FROM_LABEL[x.from] || x.from, x.text, x.image ? `${baseUrl(req)}${x.image}` : ''].map(cell).join(',')));
  const name = `bultoon-chat-${st.id}-${new Date(r.from + KST_OFFSET).toISOString().slice(0, 10)}_${new Date(r.to + KST_OFFSET).toISOString().slice(0, 10)}${r.room ? '_' + r.room + '번방' : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send('﻿' + lines.join('\r\n'));   // BOM: 엑셀에서 한글 깨짐 방지
});
storeRouter.get('/admin/stats.json', adminAuth, (req, res) => res.json({ ...req.store.buildStats(Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30))), store: { id: req.store.id, name: req.store.name } }));
storeRouter.get('/admin/settings.json', adminAuth, (req, res) => res.json({ ...req.store.settings, store: { id: req.store.id, name: req.store.name }, roomCount: req.store.rooms.length, roomNames: Object.fromEntries(req.store.rooms.map((r) => [r.id, r.name])) }));
storeRouter.post('/admin/settings', adminAuth, (req, res) => {
  try {
    const saved = req.store.applySettings(req.body || {});
    io.to(`staff:${req.store.id}`).to(`guests:${req.store.id}`).emit('settings');   // 손님·직원 화면 버튼 즉시 갱신
    res.json(saved);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// QR 이미지 (직원만)
storeRouter.get('/api/qr/:room.png', adminAuth, async (req, res) => {
  const room = req.store.roomById[req.params.room];
  if (!room) return res.status(404).end();
  res.type('png');
  res.send(await QRCode.toBuffer(req.store.guestUrl(baseUrl(req), room.id), { width: 600, margin: 2, errorCorrectionLevel: 'M' }));
});
// 동그란 점 스타일 QR (SVG). 오류 정정 레벨 H라 점 스타일로도 잘 찍힘
storeRouter.get('/api/qr/:room.svg', adminAuth, (req, res) => {
  const room = req.store.roomById[req.params.room];
  if (!room) return res.status(404).end();
  const qr = QRCode.create(req.store.guestUrl(baseUrl(req), room.id), { errorCorrectionLevel: 'H' });
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

// =====================================================================
// 본사 페이지 (/hq): 매장 목록, 추가, 이름·방·비밀번호 변경
// =====================================================================
app.get('/hq', hqAuth, (req, res) => res.sendFile(pub('hq.html')));
app.get('/hq/stores.json', hqAuth, (req, res) => res.json({ baseUrl: baseUrl(req), stores: Object.values(stores).map((s) => ({ ...s.summary(), password: s.password })) }));
app.post('/hq/stores', hqAuth, (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 40);
  const password = String(b.password || '').trim().slice(0, 60);
  const roomNames = Array.isArray(b.roomNames) ? b.roomNames.map((x) => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 500) : null;
  const roomCount = Math.max(1, Math.min(500, parseInt(b.roomCount, 10) || 0));
  if (id === 'main') {   // 기본 매장은 이름만 바꿀 수 있음 (비밀번호·방은 Render 환경변수)
    if (name) { stores.main.name = name; registry.main = { name }; saveRegistry(); }
    return res.json({ ok: true, store: stores.main.summary() });
  }
  if (!STORE_ID_RE.test(id) || RESERVED_IDS.has(id)) return res.status(400).json({ error: '매장 아이디는 영문 소문자·숫자·하이픈 2~20자여야 합니다. (예: cheolsan, dongbaek)' });
  if (!name) return res.status(400).json({ error: '매장 이름을 입력하세요.' });
  const existing = stores[id];
  if (!existing && password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
  if (!existing && !roomNames && !roomCount) return res.status(400).json({ error: '방 개수를 입력하세요.' });
  const cfg = { name, password: password || (existing ? existing.password : ''), roomCount: roomNames ? undefined : (roomCount || (existing ? existing.rooms.length : 1)), roomNames: roomNames || (existing && !roomCount ? (registry[id] || {}).roomNames : null) || null };
  registry[id] = cfg;
  saveRegistry();
  stores[id] = createStore(id, cfg);   // 방 목록·비밀번호가 바뀌면 다시 읽음 (대화·설정 파일은 그대로)
  res.json({ ok: true, store: stores[id].summary(), created: !existing });
});
app.delete('/hq/stores/:id', hqAuth, (req, res) => {
  const id = req.params.id;
  if (id === 'main' || !stores[id]) return res.status(400).json({ error: '지울 수 없는 매장입니다.' });
  delete registry[id]; saveRegistry();
  const st = stores[id]; delete stores[id];
  try { fs.renameSync(st.dir, `${st.dir}.deleted-${Date.now()}`); } catch (e) {}   // 데이터는 지우지 않고 이름만 바꿔 보관
  res.json({ ok: true });
});

app.use('/s/:store', storeRouter);
app.use('/', storeRouter);

// ---------- 실시간 소켓 ----------
io.on('connection', (socket) => {
  // 손님 입장: { store, room: 슬러그 }
  socket.on('guest:join', ({ store: sid, room: slug }, cb) => {
    const st = getStore(sid);
    const room = st && st.parseSlug(slug);
    if (!room) return cb && cb({ error: '잘못된 주소입니다. QR을 다시 찍어 주세요.' });
    socket.data.role = 'guest'; socket.data.store = st.id; socket.data.room = room;
    socket.join(`room:${st.id}:${room}`); socket.join(`guests:${st.id}`);
    cb && cb({ store: { id: st.id, name: st.name }, room: st.roomById[room], messages: st.history(room) });
  });

  // 손님 메시지
  socket.on('guest:message', ({ text, quick }, cb) => {
    const st = getStore(socket.data.store);
    const room = socket.data.room;
    if (socket.data.role !== 'guest' || !st || !room) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const msg = st.addMessage(room, 'guest', text);
    io.to(`room:${st.id}:${room}`).emit('message', msg);
    io.to(`staff:${st.id}`).emit('message', msg);
    // 자동 답변: 직원 알림은 그대로 가고, 손님에게는 즉시 안내가 뜸
    const auto = st.findAutoReply(text, typeof quick === 'string' ? quick : '', room);
    if (auto) {
      const am = st.addMessage(room, 'auto', auto.text, auto.image ? { image: auto.image } : {});
      io.to(`room:${st.id}:${room}`).emit('message', am);
      io.to(`staff:${st.id}`).emit('message', am);
    }
    io.to(`staff:${st.id}`).emit('rooms', st.allSummaries());
    cb && cb({ ok: true, auto: !!auto });
  });

  // 직원 입장: { store, password }
  socket.on('staff:join', ({ store: sid, password }, cb) => {
    const st = getStore(sid);
    if (!st || (password !== st.password && password !== MASTER_PASSWORD)) return cb && cb({ error: '비밀번호가 틀렸습니다.' });
    socket.data.role = 'staff'; socket.data.store = st.id;
    socket.join(`staff:${st.id}`);
    cb && cb({ store: { id: st.id, name: st.name }, rooms: st.allSummaries(), messages: st.data.messages });
  });

  // 직원 답장
  socket.on('staff:message', ({ room, text }, cb) => {
    const st = getStore(socket.data.store);
    if (socket.data.role !== 'staff' || !st || !st.roomById[room]) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const msg = st.addMessage(room, 'staff', text);
    io.to(`room:${st.id}:${room}`).emit('message', msg);
    io.to(`staff:${st.id}`).emit('message', msg);
    io.to(`staff:${st.id}`).emit('rooms', st.allSummaries());
    cb && cb({ ok: true });
  });

  // 직원이 방을 열어봄 -> 읽음 처리
  socket.on('staff:read', ({ room }) => {
    const st = getStore(socket.data.store);
    if (socket.data.role !== 'staff' || !st || !st.roomById[room]) return;
    st.data.lastRead[room] = Date.now();
    st.save();
    io.to(`staff:${st.id}`).emit('rooms', st.allSummaries());
  });

  // 직원이 방 대화 비우기 (퇴실 처리)
  socket.on('staff:clear', ({ room }) => {
    const st = getStore(socket.data.store);
    if (socket.data.role !== 'staff' || !st || !st.roomById[room]) return;
    if (st.history(room).length) st.logStat({ room, from: 'system', text: '퇴실 처리 (대화 비우기)', at: Date.now() });
    st.data.messages[room] = [];
    st.data.lastRead[room] = Date.now();
    st.save();
    io.to(`room:${st.id}:${room}`).emit('cleared');
    io.to(`staff:${st.id}`).emit('cleared', { room });
    io.to(`staff:${st.id}`).emit('rooms', st.allSummaries());
  });
});

server.listen(PORT, () => {
  console.log(`방 채팅 서버 실행 중: http://localhost:${PORT}`);
  console.log(`직원 화면: http://localhost:${PORT}/admin  (비밀번호: ${ADMIN_PASSWORD})`);
  console.log(`본사 화면: http://localhost:${PORT}/hq`);
  console.log(`매장: ${Object.values(stores).map((s) => `${s.name}(${s.id}, 방 ${s.rooms.length}개)`).join(', ')}`);
});
