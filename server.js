const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Initialize tables ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS hotels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    loc TEXT NOT NULL,
    region TEXT DEFAULT 'Southern',
    rating REAL DEFAULT 8.0,
    emoji TEXT DEFAULT '🏨',
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
    beds TEXT DEFAULT 'Double',
    price REAL NOT NULL,
    capacity INTEGER DEFAULT 2,
    minNights INTEGER DEFAULT 1,
    breakfast INTEGER DEFAULT 1,
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

  CREATE TABLE IF NOT EXISTS api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (datetime('now')),
    operator TEXT DEFAULT '',
    method TEXT DEFAULT 'GET',
    endpoint TEXT DEFAULT '',
    statusCode INTEGER DEFAULT 200
  );
`);

// ─── API Key middleware ──────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const row = db.prepare('SELECT * FROM keys WHERE key = ?').get(apiKey);
  if (!row) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  if (row.status !== 'active') {
    return res.status(403).json({ error: 'API key revoked' });
  }
  if (row.today >= row.limitReq) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Increment daily counter
  db.prepare('UPDATE keys SET today = today + 1 WHERE id = ?').run(row.id);

  // Log the request
  db.prepare('INSERT INTO api_log (operator, method, endpoint, statusCode) VALUES (?, ?, ?, ?)').run(
    row.company, req.method, req.originalUrl, 200
  );

  req.apiKey = row;
  next();
}

// ═══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════

// ─── Hotels ──────────────────────────────────────────────────────────
app.get('/api/admin/hotels', (req, res) => {
  try {
    const hotels = db.prepare('SELECT * FROM hotels').all();
    res.json(hotels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/hotels', (req, res) => {
  try {
    const { name, loc, region, rating, emoji, address, amenities, desc, status } = req.body;
    if (!name || !loc) {
      return res.status(400).json({ error: 'name and loc are required' });
    }
    const result = db.prepare(
      `INSERT INTO hotels (name, loc, region, rating, emoji, address, amenities, desc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, loc, region || 'Southern', rating || 8.0, emoji || '🏨', address || '', amenities || '', desc || '', status || 'active');
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(hotel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/hotels/:id', (req, res) => {
  try {
    const { name, loc, region, rating, emoji, address, amenities, desc, status } = req.body;
    const existing = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    db.prepare(
      `UPDATE hotels SET name=?, loc=?, region=?, rating=?, emoji=?, address=?, amenities=?, desc=?, status=?
       WHERE id=?`
    ).run(
      name ?? existing.name,
      loc ?? existing.loc,
      region ?? existing.region,
      rating ?? existing.rating,
      emoji ?? existing.emoji,
      address ?? existing.address,
      amenities ?? existing.amenities,
      desc ?? existing.desc,
      status ?? existing.status,
      req.params.id
    );
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    res.json(hotel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/hotels/:id/toggle', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    const newStatus = hotel.status === 'active' ? 'hidden' : 'active';
    db.prepare('UPDATE hotels SET status = ? WHERE id = ?').run(newStatus, req.params.id);
    const updated = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Rooms ───────────────────────────────────────────────────────────
app.get('/api/admin/rooms', (req, res) => {
  try {
    const rooms = db.prepare('SELECT * FROM rooms').all();
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/rooms', (req, res) => {
  try {
    const { hotelId, type, view, beds, price, capacity, minNights, breakfast, cancel, status } = req.body;
    if (!hotelId || !type || price === undefined) {
      return res.status(400).json({ error: 'hotelId, type, and price are required' });
    }
    const result = db.prepare(
      `INSERT INTO rooms (hotelId, type, view, beds, price, capacity, minNights, breakfast, cancel, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hotelId, type, view || 'Sea view', beds || 'Double', price, capacity || 2, minNights || 1, breakfast ?? 1, cancel ?? 1, status || 'active');
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(room);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/rooms/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const { hotelId, type, view, beds, price, capacity, minNights, breakfast, cancel, status } = req.body;
    db.prepare(
      `UPDATE rooms SET hotelId=?, type=?, view=?, beds=?, price=?, capacity=?, minNights=?, breakfast=?, cancel=?, status=?
       WHERE id=?`
    ).run(
      hotelId ?? existing.hotelId,
      type ?? existing.type,
      view ?? existing.view,
      beds ?? existing.beds,
      price ?? existing.price,
      capacity ?? existing.capacity,
      minNights ?? existing.minNights,
      breakfast ?? existing.breakfast,
      cancel ?? existing.cancel,
      status ?? existing.status,
      req.params.id
    );
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/rooms/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Room not found' });
    }
    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    res.json({ success: true, id: Number(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Keys ────────────────────────────────────────────────────────────
app.get('/api/admin/keys', (req, res) => {
  try {
    const keys = db.prepare('SELECT * FROM keys').all();
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/keys', (req, res) => {
  try {
    const { company, email, key, plan, limitReq, webhook } = req.body;
    if (!company || !email || !key) {
      return res.status(400).json({ error: 'company, email, and key are required' });
    }
    const result = db.prepare(
      `INSERT INTO keys (company, email, key, plan, limitReq, webhook) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(company, email, key, plan || 'free', limitReq || 1000, webhook || '');
    const created = db.prepare('SELECT * FROM keys WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'API key already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/keys/:id/revoke', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Key not found' });
    }
    db.prepare('UPDATE keys SET status = ? WHERE id = ?').run('revoked', req.params.id);
    const updated = db.prepare('SELECT * FROM keys WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bookings ────────────────────────────────────────────────────────
app.get('/api/admin/bookings', (req, res) => {
  try {
    const bookings = db.prepare('SELECT * FROM bookings ORDER BY createdAt DESC').all();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats / Dashboard ──────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  try {
    const hotels = db.prepare('SELECT COUNT(*) as count FROM hotels').get().count;
    const rooms = db.prepare('SELECT COUNT(*) as count FROM rooms').get().count;
    const keys = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
    const bookings = db.prepare('SELECT COUNT(*) as count FROM bookings').get().count;
    res.json({ hotels, rooms, keys, bookings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Log ─────────────────────────────────────────────────────────────
app.get('/api/admin/log', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM api_log ORDER BY id DESC LIMIT 50').all();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/log/stats', (req, res) => {
  try {
    const requests = db.prepare('SELECT COALESCE(SUM(today), 0) as total FROM keys').get().total;
    const operators = db.prepare("SELECT COUNT(*) as count FROM keys WHERE status = 'active'").get().count;
    const bookings = db.prepare('SELECT COUNT(*) as count FROM bookings').get().count;
    const revenue = db.prepare('SELECT COALESCE(SUM(totalUsd), 0) as total FROM bookings').get().total;
    res.json({ requests, operators, bookings, revenue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API (v1) — requires X-API-Key
// ═══════════════════════════════════════════════════════════════════════

app.get('/api/v1', (req, res) => {
  res.json({
    service: 'StayDirect Hotel API',
    version: 'v1',
    status: 'operational',
    endpoints: [
      'GET /api/v1/search',
      'GET /api/v1/hotels',
      'GET /api/v1/hotels/:id/rooms',
      'POST /api/v1/bookings'
    ]
  });
});

app.get('/api/v1/search', requireApiKey, (req, res) => {
  try {
    const { loc, checkin, checkout, guests } = req.query;
    let query = "SELECT * FROM hotels WHERE status = 'active'";
    const params = [];

    if (loc) {
      query += ' AND loc LIKE ?';
      params.push(`%${loc}%`);
    }

    const hotels = db.prepare(query).all(...params);

    const results = hotels.map(hotel => {
      let roomQuery = "SELECT * FROM rooms WHERE hotelId = ? AND status = 'active'";
      const roomParams = [hotel.id];

      if (guests) {
        roomQuery += ' AND capacity >= ?';
        roomParams.push(Number(guests));
      }

      const rooms = db.prepare(roomQuery).all(...roomParams);

      let nights = 1;
      if (checkin && checkout) {
        const d1 = new Date(checkin);
        const d2 = new Date(checkout);
        nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
      }

      return {
        ...hotel,
        rooms: rooms.map(r => ({
          ...r,
          totalPrice: r.price * nights,
          nights
        }))
      };
    }).filter(h => h.rooms.length > 0);

    res.json({ results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/hotels', requireApiKey, (req, res) => {
  try {
    const hotels = db.prepare("SELECT * FROM hotels WHERE status = 'active'").all();
    res.json(hotels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/hotels/:id/rooms', requireApiKey, (req, res) => {
  try {
    const hotel = db.prepare("SELECT * FROM hotels WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    const rooms = db.prepare("SELECT * FROM rooms WHERE hotelId = ? AND status = 'active'").all(req.params.id);
    res.json({ hotel, rooms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/bookings', requireApiKey, (req, res) => {
  try {
    const { hotelId, roomId, guestName, guestEmail, checkin, checkout } = req.body;
    if (!hotelId || !roomId || !guestName || !checkin || !checkout) {
      return res.status(400).json({ error: 'hotelId, roomId, guestName, checkin, and checkout are required' });
    }

    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(hotelId);
    if (!hotel) {
      return res.status(404).json({ error: 'Hotel not found' });
    }

    const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND hotelId = ?').get(roomId, hotelId);
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const d1 = new Date(checkin);
    const d2 = new Date(checkout);
    const nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));

    if (nights < room.minNights) {
      return res.status(400).json({ error: `Minimum ${room.minNights} night(s) required` });
    }

    const totalUsd = room.price * nights;
    const ref = 'SD-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

    const result = db.prepare(
      `INSERT INTO bookings (ref, hotelName, roomType, guestName, guestEmail, checkin, checkout, nights, totalUsd, operator, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')`
    ).run(ref, hotel.name, room.type, guestName, guestEmail || '', checkin, checkout, nights, totalUsd, req.apiKey.company);

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public API for landing page (no key required) ─────────────────
app.get('/api/public/hotels', (req, res) => {
  try {
    const hotels = db.prepare('SELECT * FROM hotels WHERE status = ?').all('active');
    const rooms = db.prepare('SELECT * FROM rooms WHERE status = ?').all('active');
    const result = hotels.map(h => ({
      ...h,
      rooms: rooms.filter(r => r.hotelId === h.id).map(r => ({ type: r.type, price: r.price }))
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HTML routes ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── Start server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StayDirect API running on port ${PORT}`);
});
