'use strict';
/**
 * BeKyredezcutiii🦖 - máy chủ cửa hàng (không cần cài thêm thư viện, Node >= 18)
 * - Lưu dữ liệu chung cho mọi người dùng (data/db.json)
 * - Đẩy thay đổi tức thì tới mọi máy đang mở web (Server-Sent Events)
 * - Mọi thao tác nhạy cảm (duyệt tiền, sửa sản phẩm, sửa code...) chỉ admin làm được, kiểm tra ở máy chủ
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIVE = path.join(DATA_DIR, 'index.html'); // bản web đang chạy (admin sửa ở đây)
const BACKUPS = path.join(DATA_DIR, 'backups');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_NAME = 'BeKyredezcutiii🦖';
const CATS = {
  A: 'DPI iOS Riêng',
  B: 'File Hỗ Trợ Kéo Tâm iOS + DPI iOS',
  C: 'File ADR (Android)',
  D: 'Công Thức DPI iOS (Bao Ra Nghề)',
};
const MAX_MONEY = 10_000_000_000;

[DATA_DIR, BACKUPS, UPLOADS].forEach((d) => fs.mkdirSync(d, { recursive: true }));
if (!fs.existsSync(LIVE)) fs.copyFileSync(path.join(PUBLIC_DIR, 'index.html'), LIVE);

/* ---------------- tiện ích ---------------- */
const norm = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
const uid = (p) => p + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
const rnd = (n = 3) => Array.from({ length: n }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join('');
const shortP = (n) => (n >= 1000 && n % 1000 === 0 ? n / 1000 + 'K' : String(n));
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => {
  const [salt, h] = String(stored).split(':'); if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const isMoney = (n) => Number.isInteger(n) && n > 0 && n <= MAX_MONEY;
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

/* ---------------- dữ liệu ---------------- */
function seed() {
  const packs = { A: [50000, 100000, 150000, 200000, 300000], B: [50000, 100000, 200000, 300000, 500000], C: [50000, 100000, 150000], D: [550000] };
  return {
    users: [{ username: ADMIN_NAME, pass: hashPw(process.env.ADMIN_PASSWORD || '28112003'), balance: 999999999999, isAdmin: true, createdAt: Date.now() }],
    products: Object.entries(packs).flatMap(([c, arr]) => arr.map((p) => ({ id: `p_${c}_${p}`, category: c, name: c === 'D' ? 'Gói Bao Ra Nghề' : 'Gói ' + shortP(p), price: p, sold: 0, description: '' }))),
    transactions: [],
    settings: { bannerUrl: './banner.png', bankName: 'Ngân hàng số', bankAccount: 'VN1 - BeKyredezcutiii', accountName: 'NGUYEN QUANG TIEN', qrUrl: '' },
    sessions: {},
  };
}
let db = null;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch (e) {
  if (fs.existsSync(DB_FILE)) { const bk = DB_FILE + '.corrupt-' + Date.now(); fs.copyFileSync(DB_FILE, bk); console.error('db.json lỗi, đã giữ bản sao tại', bk); }
}
if (!db || !Array.isArray(db.users) || !db.users.length) db = seed();
db.sessions = db.sessions || {}; db.transactions = db.transactions || []; db.products = db.products || []; db.settings = db.settings || seed().settings;
if (process.env.ADMIN_PASSWORD) { const a = db.users.find((u) => u.isAdmin); if (a) a.pass = hashPw(process.env.ADMIN_PASSWORD); }
function save() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
save();
if (!process.env.ADMIN_PASSWORD) console.warn('⚠️  Đang dùng mật khẩu admin mặc định. Hãy đặt biến môi trường ADMIN_PASSWORD để đổi!');

const findUser = (name) => db.users.find((u) => norm(u.username) === norm(name));
const byName = (name) => db.users.find((u) => u.username === name);

/* ---------------- phiên đăng nhập ---------------- */
const SESSION_MS = 30 * 24 * 3600 * 1000;
function newSession(username) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[t] = { u: username, t: Date.now() };
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (now - db.sessions[k].t > SESSION_MS) delete db.sessions[k];
  return t;
}
function authUser(req, url) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (!t) return null;
  const s = db.sessions[t]; if (!s) return null;
  if (Date.now() - s.t > SESSION_MS) { delete db.sessions[t]; return null; }
  return byName(s.u) || null;
}

/* ---------------- realtime (SSE) ---------------- */
const clients = new Set();
function push(event, filter = {}) {
  for (const c of clients) {
    const ok = filter.all || (filter.admins && c.isAdmin) || (filter.users && c.user && filter.users.includes(c.user));
    if (ok) { try { c.res.write(`event: ${event}\ndata: {}\n\n`); } catch {} }
  }
}
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch {} } }, 20000).unref();

/* ---------------- trạng thái gửi cho trình duyệt ---------------- */
function stateFor(u) {
  const s = { settings: db.settings, products: db.products, me: null, transactions: [], users: [], stats: { users: 0, revenue: 0 } };
  if (!u) return s;
  s.me = {
    username: u.username, balance: u.balance, isAdmin: !!u.isAdmin, createdAt: u.createdAt,
    unseen: db.transactions.filter((t) => t.username === u.username && t.unseen).map((t) => ({ id: t.id, amount: t.amount, status: t.status })),
  };
  if (u.isAdmin) {
    const pending = db.transactions.filter((t) => t.status === 'pending');
    const rest = db.transactions.filter((t) => t.status !== 'pending').slice(0, 200);
    s.transactions = pending.concat(rest).sort((a, b) => b.time - a.time).map(({ unseen, ...t }) => t);
    s.users = db.users.map((x) => ({ username: x.username, balance: x.balance, isAdmin: !!x.isAdmin }));
    s.stats = { users: db.users.length, revenue: db.transactions.filter((t) => t.type === 'buy').reduce((a, t) => a + t.amount, 0) };
  } else {
    s.transactions = db.transactions.filter((t) => t.username === u.username).slice(0, 500).map(({ unseen, ...t }) => t);
  }
  return s;
}

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Dữ liệu gửi lên quá lớn')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Dữ liệu không hợp lệ')); } });
    req.on('error', reject);
  });
}
const loginFails = new Map();
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
const imgUrlOk = (s) => s === '' || /^(https?:\/\/|\.\/|\/)/.test(s);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
    res.end(buf);
  });
}
function safeJoin(base, rel) { const p = path.normalize(path.join(base, rel)); return p.startsWith(base + path.sep) ? p : null; }

function backupLive(tag = 'index') {
  const name = `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`;
  fs.copyFileSync(LIVE, path.join(BACKUPS, name));
  const all = fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.html')).sort();
  while (all.length > 40) fs.unlinkSync(path.join(BACKUPS, all.shift()));
  return name;
}
function writeLive(html) { const tmp = LIVE + '.tmp'; fs.writeFileSync(tmp, html); fs.renameSync(tmp, LIVE); }
function listBackups() {
  return fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.html')).sort().reverse().slice(0, 40)
    .map((name) => { const st = fs.statSync(path.join(BACKUPS, name)); return { name, size: st.size, time: st.mtimeMs }; });
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  const me = authUser(req, url);
  const needUser = () => me || fail(401, 'Vui lòng đăng nhập lại.');
  const needAdmin = () => { needUser(); if (!me.isAdmin) fail(403, 'Chỉ admin mới được thực hiện thao tác này.'); return me; };

  if (route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const c = { res, user: me?.username || null, isAdmin: !!me?.isAdmin };
    clients.add(c); req.on('close', () => clients.delete(c));
    return;
  }
  if (route === 'GET /api/state') return json(res, 200, stateFor(me));

  if (route === 'POST /api/register') {
    const b = await readBody(req, 20000); const name = str(b.username, 40), pass = String(b.password ?? '');
    if (name.length < 3 || name.length > 30) fail(400, 'Tên tài khoản cần từ 3 đến 30 ký tự.');
    if (!norm(name)) fail(400, 'Tên tài khoản phải chứa chữ cái hoặc số.');
    if (pass.length < 6 || pass.length > 100) fail(400, 'Mật khẩu cần tối thiểu 6 ký tự.');
    if (findUser(name)) fail(409, 'Tên tài khoản đã tồn tại.');
    db.users.push({ username: name, pass: hashPw(pass), balance: 0, isAdmin: false, createdAt: Date.now() });
    const token = newSession(name); save();
    push('sync', { admins: true });
    return json(res, 200, { token });
  }
  if (route === 'POST /api/login') {
    const ip = ipOf(req), f = loginFails.get(ip);
    if (f && f.n >= 10 && Date.now() - f.t < 10 * 60000) fail(429, 'Bạn nhập sai quá nhiều lần. Vui lòng thử lại sau 10 phút.');
    const b = await readBody(req, 20000); const u = findUser(String(b.username ?? ''));
    if (!u || !checkPw(String(b.password ?? ''), u.pass)) {
      loginFails.set(ip, { n: (f && Date.now() - f.t < 10 * 60000 ? f.n : 0) + 1, t: Date.now() });
      fail(400, 'Sai tên tài khoản hoặc mật khẩu.');
    }
    loginFails.delete(ip);
    const token = newSession(u.username); save();
    return json(res, 200, { token });
  }
  if (route === 'POST /api/logout') {
    const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (t && db.sessions[t]) { delete db.sessions[t]; save(); }
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/ack') {
    needUser(); const b = await readBody(req, 50000); const ids = new Set(Array.isArray(b.ids) ? b.ids : []);
    let ch = false; for (const t of db.transactions) if (t.username === me.username && t.unseen && ids.has(t.id)) { delete t.unseen; ch = true; }
    if (ch) save(); return json(res, 200, { ok: true });
  }

  if (route === 'POST /api/deposit') {
    needUser(); const b = await readBody(req, 5000); const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount < 10000) fail(400, 'Số tiền nạp tối thiểu 10.000 đ.');
    if (amount > MAX_MONEY) fail(400, 'Số tiền quá lớn.');
    if (db.transactions.filter((t) => t.username === me.username && t.status === 'pending').length >= 10) fail(400, 'Bạn đang có quá nhiều yêu cầu chờ duyệt.');
    const tx = { id: uid('tx'), username: me.username, time: Date.now(), type: 'deposit', product: 'Nạp tiền vào ví', amount, status: 'pending', note: 'NAP_' + norm(me.username).toUpperCase() };
    db.transactions.unshift(tx); save();
    push('sync', { admins: true, users: [me.username] });
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/buy') {
    needUser(); const b = await readBody(req, 5000);
    const p = db.products.find((x) => x.id === b.productId); if (!p) fail(404, 'Sản phẩm không tồn tại hoặc đã bị xóa.');
    if (me.balance < p.price) fail(400, `Số dư không đủ. Bạn cần thêm ${new Intl.NumberFormat('vi-VN').format(p.price - me.balance)} đ.`);
    const code = `BX-${p.price}-${norm(me.username)}-${rnd(3)}`;
    me.balance -= p.price; p.sold += 1;
    db.transactions.unshift({ id: uid('tx'), username: me.username, time: Date.now(), type: 'buy', product: `${CATS[p.category]} - ${p.name}`, amount: p.price, status: 'success', code });
    save(); push('sync', { all: true });
    return json(res, 200, { code, balance: me.balance, product: p.name, category: CATS[p.category] });
  }

  /* ----- admin ----- */
  if (route === 'POST /api/admin/approve' || route === 'POST /api/admin/reject') {
    needAdmin(); const b = await readBody(req, 5000);
    const tx = db.transactions.find((t) => t.id === b.id); if (!tx || tx.type !== 'deposit') fail(404, 'Không tìm thấy yêu cầu.');
    if (tx.status !== 'pending') fail(409, 'Yêu cầu này đã được xử lý trước đó.');
    const u = byName(tx.username); if (!u) fail(404, 'Tài khoản không còn tồn tại.');
    if (route.endsWith('approve')) { u.balance += tx.amount; tx.status = 'success'; tx.product = 'Nạp tiền vào ví (Admin duyệt)'; }
    else tx.status = 'rejected';
    tx.unseen = true; tx.doneAt = Date.now(); save();
    push('sync', { admins: true, users: [u.username] });
    return json(res, 200, { ok: true, username: u.username, amount: tx.amount, balance: u.balance });
  }
  if (route === 'POST /api/admin/credit') {
    needAdmin(); const b = await readBody(req, 5000); const u = findUser(String(b.username ?? '').trim());
    if (!u) fail(404, 'Không tìm thấy tài khoản này.');
    const amount = Number(b.amount); if (!isMoney(amount)) fail(400, 'Số tiền không hợp lệ.');
    u.balance += amount;
    db.transactions.unshift({ id: uid('tx'), username: u.username, time: Date.now(), type: 'deposit', product: 'Nạp tiền vào ví (Admin duyệt)', amount, status: 'success', note: 'NAP_' + norm(u.username).toUpperCase(), unseen: true });
    save(); push('sync', { admins: true, users: [u.username] });
    return json(res, 200, { ok: true, username: u.username, balance: u.balance });
  }
  if (route === 'POST /api/admin/settings') {
    needAdmin(); const b = await readBody(req, 50000); const s = db.settings;
    if ('bankName' in b) s.bankName = str(b.bankName, 80) || 'Ngân hàng số';
    if ('bankAccount' in b) s.bankAccount = str(b.bankAccount, 80);
    if ('accountName' in b) s.accountName = str(b.accountName, 80).toUpperCase();
    for (const k of ['qrUrl', 'bannerUrl']) if (k in b) { const v = str(b[k], 2000); if (!imgUrlOk(v)) fail(400, 'URL ảnh không hợp lệ.'); s[k] = v; }
    save(); push('sync', { all: true });
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/admin/upload') {
    needAdmin(); const b = await readBody(req);
    const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl ?? '')); if (!m) fail(400, 'Ảnh không hợp lệ.');
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 8 * 1024 * 1024) fail(413, 'Ảnh quá lớn (tối đa 8MB).');
    const name = crypto.randomBytes(8).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    return json(res, 200, { url: '/uploads/' + name });
  }
  if (route === 'POST /api/admin/product/add') {
    needAdmin(); const b = await readBody(req, 5000);
    const name = str(b.name, 80), price = Number(b.price);
    if (!CATS[b.category]) fail(400, 'Mục không hợp lệ.'); if (!name) fail(400, 'Tên gói không được để trống.'); if (!isMoney(price)) fail(400, 'Giá không hợp lệ.');
    db.products.push({ id: uid('p'), category: b.category, name, price, sold: 0, description: '' }); save(); push('sync', { all: true });
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/admin/product/update') {
    needAdmin(); const b = await readBody(req, 5000); const p = db.products.find((x) => x.id === b.id); if (!p) fail(404, 'Không tìm thấy gói.');
    const name = str(b.name, 80), price = Number(b.price); if (!name) fail(400, 'Tên gói không hợp lệ.'); if (!isMoney(price)) fail(400, 'Giá không hợp lệ.');
    p.name = name; p.price = price; save(); push('sync', { all: true });
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/admin/product/delete') {
    needAdmin(); const b = await readBody(req, 5000); const n = db.products.length;
    db.products = db.products.filter((x) => x.id !== b.id); if (db.products.length === n) fail(404, 'Không tìm thấy gói.');
    save(); push('sync', { all: true }); return json(res, 200, { ok: true });
  }

  /* ----- Edit code ----- */
  if (route === 'GET /api/admin/code') {
    needAdmin(); return json(res, 200, { html: fs.readFileSync(LIVE, 'utf8'), backups: listBackups() });
  }
  if (route === 'POST /api/admin/code') {
    needAdmin(); const b = await readBody(req); const html = b.html;
    if (typeof html !== 'string' || html.length < 50) fail(400, 'Nội dung code không hợp lệ.');
    backupLive('index'); writeLive(html); push('reload', { all: true });
    return json(res, 200, { ok: true, backups: listBackups() });
  }
  if (route === 'POST /api/admin/restore') {
    needAdmin(); const b = await readBody(req, 5000);
    if (!/^[\w.\-]+\.html$/.test(String(b.name))) fail(400, 'Tên bản sao lưu không hợp lệ.');
    const f = path.join(BACKUPS, b.name); if (!fs.existsSync(f)) fail(404, 'Không tìm thấy bản sao lưu.');
    const html = fs.readFileSync(f, 'utf8'); backupLive('before-restore'); writeLive(html); push('reload', { all: true });
    return json(res, 200, { ok: true, html, backups: listBackups() });
  }
  fail(404, 'API không tồn tại.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, LIVE, { 'Cache-Control': 'no-store' });
    if (url.pathname === '/edit') return serveFile(res, path.join(__dirname, 'editor.html'), { 'Cache-Control': 'no-store' });
    let rel; try { rel = decodeURIComponent(url.pathname); } catch { fail(400, 'Bad request'); }
    if (rel.startsWith('/uploads/')) { const f = safeJoin(UPLOADS, rel.slice(9)); if (f) return serveFile(res, f, { 'Cache-Control': 'public, max-age=31536000, immutable' }); }
    else { const f = safeJoin(PUBLIC_DIR, rel.slice(1)); if (f && path.extname(f) && path.extname(f) !== '.html') return serveFile(res, f, { 'Cache-Control': 'public, max-age=300' }); }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Không tìm thấy');
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) json(res, e.code, { error: e.message }); }
    else { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
  }
});
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
server.listen(PORT, () => console.log(`Shop đang chạy: http://localhost:${PORT}  (dữ liệu: ${DATA_DIR})`));
