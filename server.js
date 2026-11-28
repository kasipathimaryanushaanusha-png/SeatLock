const express = require("express");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const app = express();
const db = new Database("/tmp/seats.db");

app.use(express.json());

// SQLite must serialize write transactions.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// 1. DATABASE: Define what exists and what is allowed.
db.exec(`
  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS holds (
    id TEXT PRIMARY KEY,
    seat_id INTEGER NOT NULL REFERENCES seats(id),
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'confirmed', 'released'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    seat_id INTEGER NOT NULL UNIQUE REFERENCES seats(id),
    user_id TEXT NOT NULL,
    hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    user_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    action TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY (user_id, request_key, action)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_hold_per_seat
  ON holds(seat_id)
  WHERE status = 'active';
`);

// Add the 10 seats only when the database is first created.
// Existing seats are never overwritten or recreated.
const seatCount = db.prepare(
  "SELECT COUNT(*) AS count FROM seats"
).get().count;

if (seatCount === 0) {
  const insertSeat = db.prepare(
    "INSERT INTO seats (label) VALUES (?)"
  );

  const createSeats = db.transaction(() => {
    for (let i = 1; i <= 10; i++) {
      insertSeat.run(`Seat ${i}`);
    }
  });

  createSeats();
}
// PAGE: serve index.html without sign-in
app.get("/",(req, res) => {
res.sendFile(__dirname + "/index.html");
})
// 2. DEMO IDENTITY
// Replace this with real login/session authentication
// before allowing public users to access the system.
app.use((req, res, next) => {
  const userId = req.get("X-User-Id");

  if (!userId) {
    return res.status(401).json({
      error: "Please sign in first."
    });
  }

  req.userId = userId;
  next();
});

// 3. HELPER: Save successful request results.
// Retrying the same request key returns the same result.
function getSavedRequest(userId, key, action) {
  return db.prepare(`
    SELECT response FROM requests
    WHERE user_id = ? AND request_key = ? AND action = ?
  `).get(userId, key, action);
}

function saveRequest(userId, key, action, response) {
  db.prepare(`
    INSERT INTO requests (user_id, request_key, action, response)
    VALUES (?, ?, ?, ?)
  `).run(userId, key, action, JSON.stringify(response));
}

function requireRequestKey(req, res) {
  const key = req.get("Idempotency-Key");

  if (!key || key.length > 100) {
    res.status(400).json({
      error: "Provide an Idempotency-Key header."
    });
    return null;
  }

  return key;
}

// HELPER: Cross out old holds whose 5 minutes are up,
// so they no longer block the seat.
function expireOldHolds() {
  db.prepare(`
    UPDATE holds SET status = 'released'
    WHERE status = 'active' AND expires_at <= ?
  `).run(Date.now());
}

// 4. LIST SEATS
app.get("/seats", (req, res) => {
  const seats = db.prepare(`
    SELECT
      s.id,
      s.label,
      CASE
        WHEN b.id IS NOT NULL THEN 'booked'
        WHEN h.id IS NOT NULL THEN 'held'
        ELSE 'available'
      END AS status
    FROM seats s
    LEFT JOIN bookings b ON b.seat_id = s.id
    LEFT JOIN holds h
      ON h.seat_id = s.id
      AND h.status = 'active'
      AND h.expires_at > ?
    ORDER BY s.id
  `).all(Date.now());

  res.json(seats);
});

// 5. HOLD A SEAT
app.post("/holds", (req, res) => {
  const key = requireRequestKey(req, res);
  if (!key) return;

  const { seatId } = req.body;
  const userId = req.userId;

  if (!Number.isInteger(seatId)) {
    return res.status(400).json({
