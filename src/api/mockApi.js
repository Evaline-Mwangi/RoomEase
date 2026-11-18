// ---------------------------------------------------------------------------
// MOCK API  –  stands in for the real backend (PHP / Node + MySQL "roomease_db").
// Every function is async and returns plain objects shaped like the DB tables.
// When the backend is ready, replace each function body with a fetch() call.
// The endpoint each one should map to is noted above it.
// Data lives in localStorage so it survives page refreshes.
// ---------------------------------------------------------------------------
import { buildSeed } from '../data/seed';
import { addDays, nightsBetween, overlaps, today } from '../lib/format';
//import { ADMIN_ACCESS_CODE } from '../config';

// v2: the demo accounts/bookings of v1 are gone, so old browsers start fresh.
const KEY = 'roomease_db_v2';
// Where the Daraja payment server lives. Empty = same origin (Vite proxies /api to it in development).
const API = import.meta.env.VITE_API_URL || '';
const SESSION = 'roomease_session';
let cache = null;

const delay = (ms = 250) => new Promise((r) => setTimeout(r, ms));

function db() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw);
  } catch { /* storage blocked – fall back to memory */ }
  if (!cache) {
    cache = buildSeed();
    save();
  }
  return cache;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* ignore */ }
}
const nextId = (table, key) => Math.max(0, ...db()[table].map((x) => x[key])) + 1;
const safeUser = ({ password_hash, salt, ...u }) => u; // never send password data to the UI

// Passwords are salted + hashed (SHA-256) before being stored, so they are not kept as plain text.
// MOCK ONLY: the real backend must use bcrypt or argon2 (NFR2).
async function hashPassword(password, salt) {
  if (!globalThis.crypto?.subtle) return 'plain:' + password; // insecure context (http on a LAN address)
  const bytes = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fail = (message) => { throw new Error(message); };

async function backendGet(params) {
  const query = new URLSearchParams(params);
  const response = await fetch(`/backend/api.php?${query}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not load data from the database.');
  return data;
}

async function backendWrite(method, params, body) {
  const query = new URLSearchParams(params);
  const response = await fetch(`/backend/api.php?${query}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'The database request failed.');
  return data;
}

function audit(user_id, action, entity, entity_id) {
  db().audit_logs.push({ log_id: nextId('audit_logs', 'log_id'), user_id, action, entity, entity_id, logged_at: today() });
}

const BLOCKING = ['pending', 'approved']; // cancelled bookings free the room

function bookedRanges(room_id, ignoreBookingId) {
  return db().bookings
    .filter((b) => b.room_id === room_id && BLOCKING.includes(b.status) && b.booking_id !== ignoreBookingId)
    .map((b) => ({ check_in: b.check_in, check_out: b.check_out }));
}
const isFree = (room_id, check_in, check_out) =>
  !bookedRanges(room_id).some((r) => overlaps(check_in, check_out, r.check_in, r.check_out));

const withType = (room) => ({ ...room, type_name: db().room_types.find((t) => t.type_id === room.type_id)?.type_name });

const hydrateBooking = (b) => ({
  ...b,
  room: withType(db().rooms.find((r) => r.room_id === b.room_id) || {}),
  student: safeUser(db().users.find((u) => u.user_id === b.user_id) || {}),
  payment: db().payments.filter((p) => p.booking_id === b.booking_id).sort((a, z) => z.payment_id - a.payment_id)[0] || null,
});

/* ------------------------------ AUTH (FR1) ------------------------------ */

// GET session


export function getSession() {
  try {
    const savedUser = localStorage.getItem(SESSION);

    if (!savedUser) return null;

    const user = JSON.parse(savedUser);

    if (
      !user ||
      typeof user !== 'object' ||
      !user.full_name ||
      !user.user_id
    ) {
      localStorage.removeItem(SESSION);
      return null;
    }

    return user;
  } catch {
    localStorage.removeItem(SESSION);
    return null;
  }
}



// POST /api/auth/register   { full_name, email?, phone?, password, role: 'student' | 'admin', admin_code? }

export async function login(identifier, password) {
  const user = await backendWrite('POST', {
    resource: 'auth-login',
  }, {
    identifier,
    password,
  });

  try {
    localStorage.setItem(SESSION, JSON.stringify(user));
  } catch {
    // Ignore storage errors
  }

  return user;
}



export async function register({
  full_name,
  email,
  phone,
  password,
  role = 'student',
  admin_code = '',
}) {
  const user = await backendWrite('POST', {
    resource: 'auth-register',
  }, {
    full_name,
    email,
    phone,
    password,
    role,
    admin_code,
  });

  try {
    localStorage.setItem(SESSION, JSON.stringify(user));
  } catch {
    // Ignore storage errors
  }

  return user;
}


export function logout() {
  try { localStorage.removeItem(SESSION); } catch { /* ignore */ }
}

// POST /api/auth/forgot-password
export async function forgotPassword() {
  await delay(500);
  return { ok: true };
}

/* --------------------------- ROOM SEARCH (FR2) --------------------------- */

// GET /api/room-types
export async function listRoomTypes() {
  return backendGet({ resource: 'room-types' });
}

// GET /api/rooms?type_id=&max_price=&check_in=&check_out=
export async function searchRooms({ type_id, max_price, check_in, check_out } = {}) {
  return backendGet({ resource: 'rooms', type_id: type_id || '', max_price: max_price || '', check_in: check_in || '', check_out: check_out || '' });
}

// GET /api/rooms/:id
export async function getRoom(id) {
  return backendGet({ resource: 'room', id: String(id) });
}

/* ------------------------ BOOKING & PAYMENT (FR3) ------------------------ */

// POST /api/bookings   { room_id, check_in, check_out }   (user comes from the auth token)
export async function createBooking({ user_id, room_id, check_in, check_out }) {
  return backendWrite('POST', { resource: 'bookings' }, { user_id, room_id, check_in, check_out });
}

// GET /api/bookings/:id
export async function getBooking(id, user) {
  return backendGet({ resource: 'booking', id: String(id), user_id: String(user.user_id), role: user.role });
}

// GET /api/bookings/mine   (booking history)
export async function myBookings(user_id) {
  return backendGet({ resource: 'my-bookings', user_id: String(user_id) });
}

// PATCH /api/bookings/:id/cancel
export async function cancelMyBooking(booking_id, user_id) {
  return backendWrite('PATCH', { resource: 'my-booking', id: String(booking_id), user_id: String(user_id) }, {});
}

// Talks to our own Daraja server (server/index.js). The Safaricom keys live ONLY on that server.
async function callPaymentServer(path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail('Cannot reach the payment server. Start it with "npm run server" (or "npm run dev:all") and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Our server always answers errors with a JSON "message". A 5xx without one means the dev proxy
    // could not reach the server at all (it is switched off).
    if (!data.message && res.status >= 500) fail('Cannot reach the payment server. Start it with "npm run server" (or "npm run dev:all") and try again.');
    fail(data.message || 'The payment request failed. Please try again.');
  }
  return data;
}

// POST /api/mpesa/stkpush   { phone, amount, reference }   → Daraja M-Pesa Express (STK Push)

// Keep the checkout request ID while the checkout page is polling.
const paymentCheckouts = new Map();

// POST: Create a MySQL payment record, then send the M-Pesa STK Push.
export async function startPayment(booking_id, phone_number) {
  const payment = await backendWrite(
    'POST',
    { resource: 'payment' },
    { booking_id, phone_number }
  );

  try {
    const res = await callPaymentServer('/api/mpesa/stkpush', {
      phone: phone_number,
      amount: Number(payment.amount),
      reference: `ROOM${booking_id}`,
    });

    paymentCheckouts.set(payment.payment_id, res.checkoutRequestId);

    return {
      ...payment,
      checkout_request_id: res.checkoutRequestId,
      customerMessage: res.customerMessage,
    };
  } catch (error) {
    await backendWrite(
      'PATCH',
      { resource: 'payment', id: String(payment.payment_id) },
      { outcome: 'failed' }
    );
    throw error;
  }
}

// GET: Check the actual M-Pesa payment status.
export async function checkPayment(payment_id) {
  const checkoutRequestId = paymentCheckouts.get(payment_id);

  if (!checkoutRequestId) {
    fail('Payment session not found. Please start the payment again.');
  }

  const result = await callPaymentServer(
    `/api/mpesa/status/${checkoutRequestId}`
  );

  if (result.status === 'pending') {
    return { payment_id, status: 'pending' };
  }

  const payment = await backendWrite(
    'PATCH',
    { resource: 'payment', id: String(payment_id) },
    {
      outcome: result.status,
      mpesa_receipt_no: result.receipt || null,
    }
  );

  paymentCheckouts.delete(payment_id);

  return {
    ...payment,
    message: result.message,
  };
}

// Handle the student's decision to stop waiting.
export async function cancelPayment(payment_id) {
  const checkoutRequestId = paymentCheckouts.get(payment_id);

  if (checkoutRequestId) {
    paymentCheckouts.delete(payment_id);
  }

  return backendWrite(
    'PATCH',
    { resource: 'payment', id: String(payment_id) },
    { outcome: 'failed' }
  );
}


/* ---------------------------- ADMIN (FR4, FR5) ---------------------------- */

// GET /api/admin/rooms
export async function adminListRooms() {
  return backendGet({ resource: 'admin-rooms' });
}

// POST /api/admin/rooms  |  PUT /api/admin/rooms/:id
export async function adminSaveRoom(room, adminId) {
  const method = room.room_id ? 'PUT' : 'POST';
  return backendWrite(method, { resource: 'admin-rooms' }, room);
}

// DELETE /api/admin/rooms/:id
export async function adminDeleteRoom(room_id, adminId) {
  return backendWrite('DELETE', { resource: 'admin-rooms', id: String(room_id) }, null);
}

// GET /api/admin/bookings?status=
export async function adminListBookings(status) {
  return backendGet({ resource: 'admin-bookings', status: status || '' });
}

// PATCH /api/admin/bookings/:id   { status: 'approved' | 'cancelled' }
export async function adminSetBookingStatus(booking_id, status, adminId) {
  return backendWrite('PATCH', { resource: 'admin-booking', id: String(booking_id) }, { status, admin_id: adminId });
}

// GET /api/admin/stats
export async function adminStats() {
  await delay(250);
  const t = today();
  const active = db().rooms.filter((r) => r.status === 'active');
  const occupied = new Set(
    db().bookings
      .filter((b) => b.status === 'approved' && b.check_in <= t && t < b.check_out)
      .map((b) => b.room_id),
  );
  return {
    totalRooms: db().rooms.length,
    activeRooms: active.length,
    pending: db().bookings.filter((b) => b.status === 'pending').length,
    occupancy: active.length ? Math.round((occupied.size / active.length) * 100) : 0,
    recent: [...db().bookings].sort((a, z) => z.booking_id - a.booking_id).slice(0, 5).map(hydrateBooking),
    logs: [...db().audit_logs].sort((a, z) => z.log_id - a.log_id).slice(0, 5).map((l) => ({
      ...l, who: db().users.find((u) => u.user_id === l.user_id)?.full_name || 'System',
    })),
  };
}

// GET /api/admin/reports/rooms/:roomId?from=&to=      (one room at a time)
export async function adminRoomReport(room_id, from, to) {
  await delay(300);
  const room = db().rooms.find((r) => r.room_id === Number(room_id));
  if (!room) fail('Please choose a room.');
  const days = nightsBetween(from, to);
  if (days < 1) fail('The end date must be after the start date.');

  const bookings = db().bookings
    .filter((b) => b.room_id === room.room_id && overlaps(b.check_in, b.check_out, from, to))
    .map((b) => {
      const h = hydrateBooking(b);
      const s = b.check_in > from ? b.check_in : from;
      const e = b.check_out < to ? b.check_out : to;
      const nights = nightsBetween(s, e);
      return {
        booking_id: b.booking_id,
        student: h.student.full_name,
        contact: h.student.email || (h.student.phone ? '+' + h.student.phone : ''),
        check_in: b.check_in, check_out: b.check_out,
        nights_in_range: nights,
        status: b.status,
        payment: h.payment ? (h.payment.status === 'success' ? 'paid' : h.payment.status) : 'unpaid',
        receipt: h.payment?.mpesa_receipt_no || '',
        total_amount: b.total_amount,
        revenue_in_range: nights * room.price_per_night,
      };
    })
    .sort((a, z) => a.check_in.localeCompare(z.check_in));

  const approved = bookings.filter((b) => b.status === 'approved');
  const nights = approved.reduce((sum, b) => sum + b.nights_in_range, 0);
  return {
    room: withType(room), from, to, days, bookings, nights,
    occupancy: Math.round((nights / days) * 100),
    revenue: approved.reduce((sum, b) => sum + b.revenue_in_range, 0),
    counts: {
      approved: approved.length,
      pending: bookings.filter((b) => b.status === 'pending').length,
      cancelled: bookings.filter((b) => b.status === 'cancelled').length,
    },
  };
}

export function defaultReportRange() {
  return { from: addDays(today(), -30), to: addDays(today(), 30) };
}

// Handy while developing: wipe localStorage back to the demo data
export function resetDemoData() {
  cache = null;
  try { localStorage.removeItem(KEY); localStorage.removeItem(SESSION); } catch { /* ignore */ }
  db();
}
