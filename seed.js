const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data.db');
const seedPath = path.join(__dirname, 'seed_data.json');

if (!fs.existsSync(seedPath)) {
  console.error('seed_data.json not found');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables if they don't exist
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
    beds TEXT DEFAULT 'Double',
    price REAL NOT NULL,
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

  CREATE TABLE IF NOT EXISTS api_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT DEFAULT (datetime('now')),
    operator TEXT DEFAULT '',
    method TEXT DEFAULT 'GET',
    endpoint TEXT DEFAULT '',
    statusCode INTEGER DEFAULT 200
  );
`);

// Check if already seeded
const count = db.prepare('SELECT COUNT(*) as count FROM hotels').get().count;
if (count > 0) {
  console.log('Database already seeded, skipping.');
  db.close();
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));

const insertHotel = db.prepare(
  `INSERT INTO hotels (id, name, loc, region, rating, emoji, photo, address, amenities, desc, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertRoom = db.prepare(
  `INSERT INTO rooms (id, hotelId, type, view, beds, price, capacity, minNights, breakfast, cancel, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertKey = db.prepare(
  `INSERT INTO keys (id, company, email, key, plan, limitReq, today, status, webhook)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertBooking = db.prepare(
  `INSERT INTO bookings (ref, hotelName, roomType, guestName, guestEmail, checkin, checkout, nights, totalUsd, operator, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const seedAll = db.transaction(() => {
  // Hotels
  for (const h of data.hotels || []) {
    insertHotel.run(h.id, h.name, h.loc, h.region || 'Southern', h.rating || 8.0, h.emoji || '🏨', h.photo || '', h.address || '', h.amenities || '', h.desc || '', h.status || 'active');
  }

  // Rooms
  for (const r of data.rooms || []) {
    insertRoom.run(r.id, r.hotelId, r.type, r.view || 'Sea view', r.beds || 'DBL', r.price, r.capacity || 2, r.minNights || 1, r.breakfast || 'BB', r.cancel ?? 1, r.status || 'active');
  }

  // Keys — map `limit` from seed data to `limitReq` column
  for (const k of data.keys || []) {
    insertKey.run(k.id, k.company, k.email, k.key, k.plan || 'free', k.limit || k.limitReq || 1000, k.today || 0, k.status || 'active', k.webhook || '');
  }

  // Bookings
  for (const b of data.bookings || []) {
    insertBooking.run(b.ref, b.hotelName, b.roomType, b.guestName, b.guestEmail || '', b.checkin, b.checkout, b.nights || 1, b.totalUsd || 0, b.operator || '', b.status || 'confirmed');
  }
});

seedAll();

const hotels = db.prepare('SELECT COUNT(*) as count FROM hotels').get().count;
const rooms = db.prepare('SELECT COUNT(*) as count FROM rooms').get().count;
const keys = db.prepare('SELECT COUNT(*) as count FROM keys').get().count;
const bookings = db.prepare('SELECT COUNT(*) as count FROM bookings').get().count;

console.log(`Seeded: ${hotels} hotels, ${rooms} rooms, ${keys} keys, ${bookings} bookings`);

db.close();
