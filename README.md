# SeatLock
A system that temporarily locks selected seats for users during the booking process. It ensures that only the user who owns a particular seat hold can confirm, release, or modify it.
## How to run
1. Install Node.js.
2. Open a terminal in the project folder.
3. Run: npm install
4. Run: node server.js
5. Open http://localhost:3000 in your browser.

## Design decisions
- Only real seats: the database has a fixed list of seats, and every hold must point to one of them.
- No overbooking: holds and bookings are saved inside database transactions, and each seat can have only one booking.
- Safe retries: every request carries an Idempotency-Key. The server saves its answer, so a repeated request gets the same answer instead of booking twice.
- Own holds only: the server finds a hold by its id AND its user, so nobody can confirm, release or change someone else's hold.
- Holds expire: a held seat is given back automatically if it is not confirmed in time.