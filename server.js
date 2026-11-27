
const express = require("express");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const app = express();
const db = new Database("seatlock.db");

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
      error: "seatId must be a number."
    });
  }

  const createHold = db.transaction(() => {
    const previous = getSavedRequest(userId, key, "hold");

    if (previous) {
      return JSON.parse(previous.response);
    }

    // Expired holds no longer reserve a seat.
    db.prepare(`
      UPDATE holds SET status = 'released'
      WHERE status = 'active' AND expires_at <= ?
    `).run(Date.now());

    const seat = db.prepare(
      "SELECT id FROM seats WHERE id = ?"
    ).get(seatId);

    if (!seat) {
      return { error: "Seat does not exist.", status: 404 };
    }

    const booked = db.prepare(
      "SELECT id FROM bookings WHERE seat_id = ?"
    ).get(seatId);

    if (booked) {
      return { error: "Seat is already booked.", status: 409 };
    }

    const activeHold = db.prepare(`
      SELECT id FROM holds
      WHERE seat_id = ? AND status = 'active'
    `).get(seatId);

    if (activeHold) {
      return { error: "Seat is already held.", status: 409 };
    }

    const hold = {
      id: randomUUID(),
      seatId,
      userId,
      expiresAt: Date.now() + 5 * 60 * 1000
    };

    db.prepare(`
      INSERT INTO holds (id, seat_id, user_id, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(
      hold.id,
      hold.seatId,
      hold.userId,
      hold.expiresAt
    );

    const response = {
      holdId: hold.id,
      seatId: hold.seatId,
      expiresAt: hold.expiresAt
    };

    saveRequest(userId, key, "hold", response);
    return response;
  });

  try {
    const result = createHold.immediate();

    if (result.error) {
      return res.status(result.status).json(result);
    }

    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({
      error: "Seat is no longer available."
    });
  }
});

// 6. CONFIRM A BOOKING
app.post("/holds/:holdId/confirm", (req, res) => {
  const key = requireRequestKey(req, res);
  if (!key) return;

  const userId = req.userId;
  const holdId = req.params.holdId;

  const confirmBooking = db.transaction(() => {
    const previous = getSavedRequest(
      userId, key, "confirm"
    );

    if (previous) {
      return JSON.parse(previous.response);
    }

    const hold = db.prepare(`
      SELECT * FROM holds
      WHERE id = ? AND user_id = ?
    `).get(holdId, userId);

    // A user cannot confirm another user's hold.
    if (!hold) {
      return { error: "Hold not found.", status: 404 };
    }

    // A confirmed hold returns its existing booking.
    if (hold.status === "confirmed") {
      const booking = db.prepare(
        "SELECT * FROM bookings WHERE hold_id = ?"
      ).get(holdId);

      const response = {
        bookingId: booking.id,
        seatId: booking.seat_id
      };

      saveRequest(userId, key, "confirm", response);
      return response;
    }

    if (
      hold.status !== "active" ||
      hold.expires_at <= Date.now()
    ) {
      return { error: "Hold has expired.", status: 409 };
    }

    const booking = {
      id: randomUUID(),
      seatId: hold.seat_id,
      holdId,
      userId
    };

    // UNIQUE seat_id guarantees that a seat is sold once.
    db.prepare(`
      INSERT INTO bookings (id, seat_id, user_id, hold_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      booking.id,
      booking.seatId,
      booking.userId,
      booking.holdId,
      Date.now()
    );

    db.prepare(`
      UPDATE holds SET status = 'confirmed'
      WHERE id = ?
    `).run(holdId);

    const response = {
      bookingId: booking.id,
      seatId: booking.seatId
    };

    saveRequest(userId, key, "confirm", response);
    return response;
  });

  try {
    const result = confirmBooking.immediate();

    if (result.error) {
      return res.status(result.status).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(409).json({
      error: "Booking could not be confirmed."
    });
  }
});

// 7. RELEASE A HOLD
app.delete("/holds/:holdId", (req, res) => {
  const key = requireRequestKey(req, res);
  if (!key) return;

  const userId = req.userId;
  const holdId = req.params.holdId;

  const releaseHold = db.transaction(() => {
    const previous = getSavedRequest(
      userId, key, "release"
    );

    if (previous) {
      return JSON.parse(previous.response);
    }

    const hold = db.prepare(`
      SELECT * FROM holds
      WHERE id = ? AND user_id = ?
    `).get(holdId, userId);

    if (!hold) {
      return { error: "Hold not found.", status: 404 };
    }

    if (hold.status === "confirmed") {
      return { error: "Booking is already confirmed.", status: 409 };
    }

    db.prepare(`
      UPDATE holds SET status = 'released'
      WHERE id = ? AND user_id = ?
    `).run(holdId, userId);

    const response = { released: true };

    saveRequest(userId, key, "release", response);
    return response;
  });

  const result = releaseHold.immediate();

  if (result.error) {
    return res.status(result.status).json(result);
  }

  res.json(result);
});

// Start the backend.
app.listen(3000, () => {
  console.log("SeatLock is running at http://localhost:3000");
});
