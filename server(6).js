'use strict';
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS hotels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    loc TEXT NOT NULL,
    region TEXT DEFAULT 'Southern',
    rating REAL DEFAULT 8.0,
    emoji TEXT DEFAULT '🏨',
    photo TEXT DEFAULT '',
    address TEXT DEFAULT '',
    amenities TEXT DEFAULT '',
    desc TEXT DEFAULT '',
    status TEXT DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotelId INTEGER NOT NULL,
    type TEXT NOT NULL,
    view TEXT DEFAULT 'Sea view',
    beds TEXT DEFAULT 'DBL',
    price REAL NOT NULL,
    prices TEXT DEFAULT '{}',
    capacity INTEGER DEFAULT 2,
    minNights INTEGER DEFAULT 1,
    breakfast TEXT DEFAULT 'BB',
    cancel INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    FOREIGN KEY (hotelId) REFERENCES hotels(id)
  );
  CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    email TEXT NOT NULL,
    key TEXT NOT NULL UNIQUE,
    plan TEXT DEFAULT 'free',
    limitReq INTEGER DEFAULT 1000,
    today INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    webhook TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL,
    hotelName TEXT NOT NULL,
    roomType TEXT NOT NULL,
    guestName TEXT NOT NULL,
    guestEmail TEXT DEFAULT '',
    checkin TEXT NOT NULL,
    checkout TEXT NOT NULL,
    nights INTEGER DEFAULT 1,
    totalUsd REAL DEFAULT 0,
    operator TEXT DEFAULT '',
    status TEXT DEFAULT 'confirmed',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rate_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotelId INTEGER DEFAULT 0,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'season',
    dateFrom TEXT NOT NULL,
    dateTo TEXT NOT NULL,
    prices TEXT DEFAULT '{}',
    surcharge REAL DEFAULT 0,
    status TEXT DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (datetime('now')),
    operator TEXT DEFAULT '',
    method TEXT DEFAULT 'GET',
    endpoint TEXT DEFAULT '',
    statusCode INTEGER DEFAULT 200
  );
`);

// ── HELPERS ──────────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key header' });
  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(apiKey);
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  if (row.status !== 'active') return res.status(403).json({ error: 'API key revoked' });
  if (row.today >= row.limitReq) return res.status(429).json({ error: 'Rate limit exceeded' });
  db.prepare('UPDATE keys SET today = today + 1 WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO api_log (operator, method, endpoint, statusCode) VALUES (?, ?, ?, 200)').run(row.company, req.method, req.originalUrl);
  req.apiKey = row;
  next();
}

// ── ADMIN: HOTELS ─────────────────────────────────────────────────────────────
app.get('/api/admin/hotels', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM hotels').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/hotels', (req, res) => {
  try {
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    if (!name || !loc) return res.status(400).json({ error: 'name and loc required' });
    const r = db.prepare('INSERT INTO hotels (name,loc,region,rating,emoji,photo,address,amenities,desc,status) VALUES (?,?,?,?,?,?,?,?,?,?)').run(name, loc, region||'Southern', rating||8.0, emoji||'🏨', photo||'', address||'', amenities||'', desc||'', status||'active');
    res.status(201).json(db.prepare('SELECT * FROM hotels WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/hotels/:id', (req, res) => {
  try {
    const h = db.prepare('SELECT * FROM hotels WHERE id=?').get(req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    db.prepare('UPDATE hotels SET name=?,loc=?,region=?,rating=?,emoji=?,photo=?,address=?,amenities=?,desc=?,status=? WHERE id=?').run(name??h.name, loc??h.loc, region??h.region, rating??h.rating, emoji??h.emoji, photo??h.photo, address??h.address, amenities??h.amenities, desc??h.desc, status??h.status, req.params.id);
    res.json(db.prepare('SELECT * FROM hotels WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/hotels/:id/toggle', (req, res) => {
  try {
    const h = db.prepare('SELECT * FROM hotels WHERE id=?').get(req.params.id);
    if (!h) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE hotels SET status=? WHERE id=?').run(h.status==='active'?'hidden':'active', req.params.id);
    res.json(db.prepare('SELECT * FROM hotels WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/hotels/:id', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM hotels WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM rooms WHERE hotelId=?').run(req.params.id);
    db.prepare('DELETE FROM hotels WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: ROOMS ──────────────────────────────────────────────────────────────
app.get('/api/admin/rooms', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM rooms').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/rooms', (req, res) => {
  try {
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    if (!hotelId || !type) return res.status(400).json({ error: 'hotelId and type required' });
    const pj = typeof prices === 'object' ? JSON.stringify(prices) : (prices||'{}');
    const r = db.prepare('INSERT INTO rooms (hotelId,type,view,beds,price,prices,capacity,minNights,breakfast,cancel,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(hotelId, type, view||'Sea view', beds||'DBL', price||0, pj, capacity||2, minNights||1, breakfast||'BB', cancel??1, status||'active');
    res.status(201).json(db.prepare('SELECT * FROM rooms WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/rooms/:id', (req, res) => {
  try {
    const rm = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
    if (!rm) return res.status(404).json({ error: 'Not found' });
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    const pj = prices ? (typeof prices==='object' ? JSON.stringify(prices) : prices) : rm.prices;
    db.prepare('UPDATE rooms SET hotelId=?,type=?,view=?,beds=?,price=?,prices=?,capacity=?,minNights=?,breakfast=?,cancel=?,status=? WHERE id=?').run(hotelId??rm.hotelId, type??rm.type, view??rm.view, beds??rm.beds, price??rm.price, pj, capacity??rm.capacity, minNights??rm.minNights, breakfast??rm.breakfast, cancel??rm.cancel, status??rm.status, req.params.id);
    res.json(db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: KEYS ───────────────────────────────────────────────────────────────
app.get('/api/admin/keys', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM keys').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/keys', (req, res) => {
  try {
    const { company, email, key, plan, limitReq, webhook } = req.body;
    if (!company || !email || !key) return res.status(400).json({ error: 'company, email, key required' });
    const r = db.prepare('INSERT INTO keys (company,email,key,plan,limitReq,webhook) VALUES (?,?,?,?,?,?)').run(company, email, key, plan||'free', limitReq||1000, webhook||'');
    res.status(201).json(db.prepare('SELECT * FROM keys WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Key already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/admin/keys/:id/revoke', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM keys WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE keys SET status=? WHERE id=?').run('revoked', req.params.id);
    res.json(db.prepare('SELECT * FROM keys WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: BOOKINGS ───────────────────────────────────────────────────────────
app.get('/api/admin/bookings', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM bookings ORDER BY createdAt DESC').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: RATE PERIODS ───────────────────────────────────────────────────────
app.get('/api/admin/rate-periods', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM rate_periods ORDER BY dateFrom').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/rate-periods', (req, res) => {
  try {
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    if (!name || !dateFrom || !dateTo) return res.status(400).json({ error: 'name, dateFrom, dateTo required' });
    const pj = typeof prices==='object' ? JSON.stringify(prices) : (prices||'{}');
    const r = db.prepare('INSERT INTO rate_periods (hotelId,name,type,dateFrom,dateTo,prices,surcharge,status) VALUES (?,?,?,?,?,?,?,?)').run(hotelId||0, name, type||'season', dateFrom, dateTo, pj, surcharge||0, status||'active');
    res.status(201).json(db.prepare('SELECT * FROM rate_periods WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/rate-periods/:id', (req, res) => {
  try {
    const rp = db.prepare('SELECT * FROM rate_periods WHERE id=?').get(req.params.id);
    if (!rp) return res.status(404).json({ error: 'Not found' });
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    const pj = prices ? (typeof prices==='object' ? JSON.stringify(prices) : prices) : rp.prices;
    db.prepare('UPDATE rate_periods SET hotelId=?,name=?,type=?,dateFrom=?,dateTo=?,prices=?,surcharge=?,status=? WHERE id=?').run(hotelId??rp.hotelId, name??rp.name, type??rp.type, dateFrom??rp.dateFrom, dateTo??rp.dateTo, pj, surcharge??rp.surcharge, status??rp.status, req.params.id);
    res.json(db.prepare('SELECT * FROM rate_periods WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/rate-periods/:id', (req, res) => {
  try {
    if (!db.prepare('SELECT id FROM rate_periods WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM rate_periods WHERE id=?').run(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: STATS & LOG ────────────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  try {
    res.json({
      hotels: db.prepare('SELECT COUNT(*) as c FROM hotels').get().c,
      rooms: db.prepare('SELECT COUNT(*) as c FROM rooms').get().c,
      keys: db.prepare('SELECT COUNT(*) as c FROM keys').get().c,
      bookings: db.prepare('SELECT COUNT(*) as c FROM bookings').get().c
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/log', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM api_log ORDER BY id DESC LIMIT 100').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/log/stats', (req, res) => {
  try {
    res.json({
      requests: db.prepare('SELECT COALESCE(SUM(today),0) as t FROM keys').get().t,
      operators: db.prepare("SELECT COUNT(*) as c FROM keys WHERE status='active'").get().c,
      bookings: db.prepare('SELECT COUNT(*) as c FROM bookings').get().c,
      revenue: db.prepare('SELECT COALESCE(SUM(totalUsd),0) as t FROM bookings').get().t
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUBLIC API ────────────────────────────────────────────────────────────────
app.get('/api/v1', (req, res) => {
  res.json({ service: 'StayDirect Hotel API', version: 'v1', status: 'operational' });
});

app.get('/api/v1/hotels', requireApiKey, (req, res) => {
  try { res.json(db.prepare("SELECT * FROM hotels WHERE status='active'").all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/hotels/:id/rooms', requireApiKey, (req, res) => {
  try {
    const hotel = db.prepare("SELECT * FROM hotels WHERE id=? AND status='active'").get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    res.json({ hotel, rooms: db.prepare("SELECT * FROM rooms WHERE hotelId=? AND status='active'").all(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/bookings', requireApiKey, (req, res) => {
  try {
    const { hotelId, roomId, guestName, guestEmail, checkin, checkout } = req.body;
    if (!hotelId || !roomId || !guestName || !checkin || !checkout) return res.status(400).json({ error: 'Missing required fields' });
    const hotel = db.prepare('SELECT * FROM hotels WHERE id=?').get(hotelId);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const room = db.prepare('SELECT * FROM rooms WHERE id=? AND hotelId=?').get(roomId, hotelId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const nights = Math.max(1, Math.round((new Date(checkout) - new Date(checkin)) / 86400000));
    const ref = 'SD-' + Date.now().toString(36).toUpperCase();
    const r = db.prepare("INSERT INTO bookings (ref,hotelName,roomType,guestName,guestEmail,checkin,checkout,nights,totalUsd,operator) VALUES (?,?,?,?,?,?,?,?,?,?)").run(ref, hotel.name, room.type, guestName, guestEmail||'', checkin, checkout, nights, room.price*nights, req.apiKey.company);
    res.status(201).json(db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/hotels', (req, res) => {
  try {
    const hotels = db.prepare("SELECT * FROM hotels WHERE status='active'").all();
    const rooms = db.prepare("SELECT * FROM rooms WHERE status='active'").all();
    res.json(hotels.map(h => ({ ...h, rooms: rooms.filter(r => r.hotelId === h.id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAGES ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log('StayDirect running on port ' + PORT));
