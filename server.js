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
    type TEXT NOT NULL DEFAULT 'season',
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

// Migration: recreate rate_periods without FK constraint (hotelId=0 = global)
try {
  const hasFK = db.prepare("SELECT sql FROM sqlite_master WHERE name='rate_periods'").get();
  if (hasFK && hasFK.sql && hasFK.sql.includes('FOREIGN KEY')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_periods_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotelId INTEGER DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'season',
        dateFrom TEXT NOT NULL,
        dateTo TEXT NOT NULL,
        prices TEXT DEFAULT '{}',
        surcharge REAL DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
      INSERT INTO rate_periods_new SELECT * FROM rate_periods;
      DROP TABLE rate_periods;
      ALTER TABLE rate_periods_new RENAME TO rate_periods;
    `);
    console.log('Migrated rate_periods: removed FK constraint');
  }
} catch(e) { console.log('rate_periods migration:', e.message); }

// Migration: add mealPlans column to hotels table
try {
  db.prepare("SELECT mealPlans FROM hotels LIMIT 1").get();
} catch(e) {
  db.exec("ALTER TABLE hotels ADD COLUMN mealPlans TEXT DEFAULT '[\"BB\"]'");
  console.log('Migrated hotels: added mealPlans column');
}

// ─── Price Matrix API ───────────────────────────────────────────────

// Helper: normalize flat prices {"SGL":10} → treat as BB: {"BB":{"SGL":10}}
function normalizePrices(raw) {
  let p = {};
  try { p = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch(e){ return {}; }
  if (!p || typeof p !== 'object') return {};
  const keys = Object.keys(p);
  if (keys.length === 0) return {};
  // Check if already nested (first value is object)
  const first = p[keys[0]];
  if (typeof first === 'object' && first !== null) return p;
  // Flat format → wrap as BB
  return { BB: p };
}

// Helper: extract flat prices for a meal plan from nested format
function flatPricesForMeal(nestedPrices, meal) {
  const norm = normalizePrices(nestedPrices);
  return norm[meal] || {};
}

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
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    if (!name || !loc) {
      return res.status(400).json({ error: 'name and loc are required' });
    }
    const result = db.prepare(
      `INSERT INTO hotels (name, loc, region, rating, emoji, photo, address, amenities, desc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, loc, region || 'Southern', rating || 8.0, emoji || '🏨', photo || '', address || '', amenities || '', desc || '', status || 'active');
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(hotel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/hotels/:id', (req, res) => {
  try {
    const { name, loc, region, rating, emoji, photo, address, amenities, desc, status } = req.body;
    const existing = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Hotel not found' });
    }
    db.prepare(
      `UPDATE hotels SET name=?, loc=?, region=?, rating=?, emoji=?, photo=?, address=?, amenities=?, desc=?, status=?
       WHERE id=?`
    ).run(
      name ?? existing.name,
      loc ?? existing.loc,
      region ?? existing.region,
      rating ?? existing.rating,
      emoji ?? existing.emoji,
      photo ?? existing.photo,
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
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    if (!hotelId || !type) {
      return res.status(400).json({ error: 'hotelId and type are required' });
    }
    const pricesJson = typeof prices === 'object' ? JSON.stringify(prices) : (prices || '{}');
    const basePrice = price || (prices && typeof prices === 'object' ? (prices.DBL || prices.SGL || Object.values(prices)[0] || 0) : 0);
    const result = db.prepare(
      `INSERT INTO rooms (hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hotelId, type, view || 'Sea view', beds || 'DBL', basePrice, pricesJson, capacity || 2, minNights || 1, breakfast || 'BB', cancel ?? 1, status || 'active');
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
    const { hotelId, type, view, beds, price, prices, capacity, minNights, breakfast, cancel, status } = req.body;
    const pricesJson = prices ? (typeof prices === 'object' ? JSON.stringify(prices) : prices) : existing.prices;
    const basePrice = price || (prices && typeof prices === 'object' ? (prices.DBL || prices.SGL || Object.values(prices)[0] || 0) : null);
    db.prepare(
      `UPDATE rooms SET hotelId=?, type=?, view=?, beds=?, price=?, prices=?, capacity=?, minNights=?, breakfast=?, cancel=?, status=?
       WHERE id=?`
    ).run(
      hotelId ?? existing.hotelId,
      type ?? existing.type,
      view ?? existing.view,
      beds ?? existing.beds,
      basePrice ?? existing.price,
      pricesJson,
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

// ─── Price Matrix ───────────────────────────────────────────────────
app.get('/api/admin/hotels/:id/price-matrix', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
    const rooms = db.prepare("SELECT * FROM rooms WHERE hotelId = ? AND status = 'active'").all(req.params.id);
    const periods = db.prepare("SELECT * FROM rate_periods WHERE (hotelId = ? OR hotelId = 0) AND status = 'active' ORDER BY dateFrom").all(req.params.id);
    let mealPlans;
    try { mealPlans = JSON.parse(hotel.mealPlans || '["BB"]'); } catch(e) { mealPlans = ['BB']; }

    // Normalize prices to nested meal plan format
    const roomsOut = rooms.map(r => {
      let prices = normalizePrices(r.prices);
      // Fallback: if prices is empty but room has a base price, put it in BB.DBL
      if (Object.keys(prices).length === 0 && r.price > 0) {
        prices = { BB: { DBL: r.price } };
      }
      return { id: r.id, type: r.type, view: r.view, capacity: r.capacity, prices };
    });
    const periodsOut = periods.map(p => ({
      id: p.id, name: p.name, type: p.type,
      dateFrom: p.dateFrom, dateTo: p.dateTo,
      prices: normalizePrices(p.prices),
      surcharge: p.surcharge || 0
    }));

    res.json({ hotel, rooms: roomsOut, periods: periodsOut, mealPlans });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/hotels/:id/price-matrix', (req, res) => {
  try {
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(req.params.id);
    if (!hotel) return res.status(404).json({ error: 'Hotel not found' });

    const { rooms, periods } = req.body;

    const updateRoom = db.prepare('UPDATE rooms SET prices = ?, price = ? WHERE id = ?');
    const updatePeriod = db.prepare('UPDATE rate_periods SET prices = ? WHERE id = ?');

    const tx = db.transaction(() => {
      if (rooms && Array.isArray(rooms)) {
        for (const r of rooms) {
          const pricesJson = JSON.stringify(r.prices || {});
          // Compute base price from BB.DBL or first available
          const norm = r.prices || {};
          const bb = norm.BB || norm[Object.keys(norm)[0]] || {};
          const basePrice = bb.DBL || bb.SGL || Object.values(bb)[0] || 0;
          updateRoom.run(pricesJson, basePrice, r.id);
        }
      }
      if (periods && Array.isArray(periods)) {
        for (const p of periods) {
          const pricesJson = JSON.stringify(p.prices || {});
          updatePeriod.run(pricesJson, p.id);
        }
      }
    });
    tx();

    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Rate Periods ────────────────────────────────────────────────────
app.get('/api/admin/rate-periods', (req, res) => {
  try {
    const periods = db.prepare('SELECT * FROM rate_periods ORDER BY dateFrom').all();
    res.json(periods);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/rate-periods', (req, res) => {
  try {
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    if (!name || !dateFrom || !dateTo) return res.status(400).json({ error: 'name, dateFrom, dateTo required' });
    const pricesJson = typeof prices === 'object' ? JSON.stringify(prices) : (prices || '{}');
    const result = db.prepare(
      `INSERT INTO rate_periods (hotelId, name, type, dateFrom, dateTo, prices, surcharge, status) VALUES (?,?,?,?,?,?,?,?)`
    ).run(hotelId || 0, name, type || 'season', dateFrom, dateTo, pricesJson, surcharge || 0, status || 'active');
    const row = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/rate-periods/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { hotelId, name, type, dateFrom, dateTo, prices, surcharge, status } = req.body;
    const pricesJson = prices ? (typeof prices === 'object' ? JSON.stringify(prices) : prices) : existing.prices;
    db.prepare(
      `UPDATE rate_periods SET hotelId=?, name=?, type=?, dateFrom=?, dateTo=?, prices=?, surcharge=?, status=? WHERE id=?`
    ).run(
      hotelId ?? existing.hotelId, name ?? existing.name, type ?? existing.type,
      dateFrom ?? existing.dateFrom, dateTo ?? existing.dateTo,
      pricesJson, surcharge ?? existing.surcharge, status ?? existing.status, req.params.id
    );
    const row = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/rate-periods/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM rate_periods WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM rate_periods WHERE id = ?').run(req.params.id);
    res.json({ success: true, id: Number(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ─── Price calculation helper ──────────────────────────────────────
function getActivePeriods(hotelId, date) {
  // Returns { season, surcharge } — both can be active simultaneously
  const d = typeof date === 'string' ? date : date.toISOString().split('T')[0];
  const q = "SELECT * FROM rate_periods WHERE (hotelId = ? OR hotelId = 0) AND status = 'active' AND dateFrom <= ? AND dateTo >= ? ORDER BY hotelId DESC";
  const all = db.prepare(q).all(hotelId, d, d);
  // Hotel-specific overrides global; pick best season and best surcharge
  let season = null, surcharge = null;
  for (const p of all) {
    if (p.type === 'season' && !season) season = p;
    if (p.type === 'surcharge' && !surcharge) surcharge = p;
  }
  return { season, surcharge };
}

// Legacy compat wrapper
function getActivePeriod(hotelId, date) {
  const { season, surcharge } = getActivePeriods(hotelId, date);
  return surcharge || season || null;
}

function calcRoomPrice(room, hotelId, date) {
  let rawPrices = {};
  try { rawPrices = JSON.parse(room.prices || '{}'); } catch(e){}

  // Handle both flat and nested formats - extract flat BB prices for backward compat
  const nested = normalizePrices(room.prices);
  const basePrices = nested.BB || {};

  const { season, surcharge } = getActivePeriods(hotelId, date);
  if (!season && !surcharge) return { prices: basePrices, basePrice: room.price, surcharge: 0, periodName: null, periodType: null };

  // Start with base prices
  const effectivePrices = { ...basePrices };

  // If season active and has custom prices, override matching keys
  if (season) {
    const seasonNested = normalizePrices(season.prices);
    const seasonPrices = seasonNested.BB || {};
    if (Object.keys(seasonPrices).length > 0) {
      Object.keys(seasonPrices).forEach(k => { effectivePrices[k] = seasonPrices[k]; });
    }
  }

  const surchargeAmt = surcharge ? (surcharge.surcharge || 0) : 0;
  const basePrice = effectivePrices.DBL || effectivePrices.SGL || Object.values(effectivePrices)[0] || room.price;

  // Display name: prefer surcharge name (holiday), fall back to season
  const displayPeriod = surcharge || season;

  return {
    prices: effectivePrices,
    basePrice: basePrice + surchargeAmt,
    surcharge: surchargeAmt,
    periodName: displayPeriod ? displayPeriod.name : null,
    periodType: displayPeriod ? displayPeriod.type : null,
    seasonName: season ? season.name : null
  };
}

// ─── Public API for landing page (no key required) ─────────────────
app.get('/api/public/hotels', (req, res) => {
  try {
    const hotels = db.prepare('SELECT * FROM hotels WHERE status = ?').all('active');
    const rooms = db.prepare('SELECT * FROM rooms WHERE status = ?').all('active');
    const periods = db.prepare("SELECT * FROM rate_periods WHERE status = 'active' ORDER BY dateFrom").all();
    const checkin = req.query.checkin || new Date().toISOString().split('T')[0];
    
    const result = hotels.map(h => ({
      ...h,
      rooms: rooms.filter(r => r.hotelId === h.id).map(r => {
        let prices = {};
        try { prices = JSON.parse(r.prices || '{}'); } catch(e){}
        const calc = calcRoomPrice(r, h.id, checkin);
        return {
          type: r.type, view: r.view, price: r.price, prices,
          breakfast: r.breakfast, capacity: r.capacity,
          seasonPrice: calc.basePrice, seasonPrices: calc.prices,
          surcharge: calc.surcharge, periodName: calc.periodName, periodType: calc.periodType,
          seasonName: calc.seasonName
        };
      }),
      ratePeriods: periods.filter(p => p.hotelId === h.id || p.hotelId === 0)
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/rate-periods', (req, res) => {
  try {
    const periods = db.prepare("SELECT * FROM rate_periods WHERE status = 'active' ORDER BY dateFrom").all();
    res.json(periods);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
