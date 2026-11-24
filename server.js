'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 96;
const FLOOR_CAPACITY = 4;
const MIN_FLOOR = -3;
const MAX_FLOOR = 24;
const RESERVATION_MS = 24 * 60 * 60 * 1000;
const ADMIN_NAME = 'amirxrax';
const ADMIN_ACCESS_CODE = String(process.env.ADMIN_ACCESS_CODE || '');
const CHAT_MAX_LENGTH = 180;
const CHAT_COOLDOWN_MS = 1200;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'hotel-state.json');

let floor24Unlocked = true; // Admin can lock upper-floor access; enabled by default.
const BANK_ASSETS = [
  { id: 'BTC', name: 'بیت‌کوین هتل', icon: '₿', initialPrice: 120 },
  { id: 'ETH', name: 'اتریوم هتل', icon: '◆', initialPrice: 80 },
  { id: 'DOGE', name: 'داج هتل', icon: 'Ð', initialPrice: 12 }
];
let bankMarket = Object.fromEntries(BANK_ASSETS.map(a => [a.id, { ...a, price: a.initialPrice }]));
const CABINET_GAMES = {
  chess: { name: 'شطرنج', icon: '♟️', gameId: 'puzzle' },
  ludo: { name: 'منچ', icon: '🎲', gameId: 'race' },
  cards: { name: 'کارت‌بازی', icon: '🃏', gameId: 'record' },
  football: { name: 'فوتبال رومیزی', icon: '⚽', gameId: 'football' },
  pingpong: { name: 'پینگ‌پنگ', icon: '🏓', gameId: 'pingpong' },
  basketball: { name: 'بسکتبال رومیزی', icon: '🏀', gameId: 'basketball' }
};

const players = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const SHOP_TYPES = [
  { id: 'phone', name: 'گوشی‌فروشی', icon: '📱' },
  { id: 'butcher', name: 'گوشت‌فروشی', icon: '🥩' },
  { id: 'pets', name: 'حیوانات خانگی', icon: '🐾' },
  { id: 'market', name: 'سوپرمارکت', icon: '🛒' },
  { id: 'school', name: 'مدرسه', icon: '🏫' },
  { id: 'eggs', name: 'تخم‌فروشی', icon: '🥚' },
  { id: 'secondhand', name: 'دست‌دوم‌فروشی', icon: '♻️' },
  { id: 'restaurant', name: 'رستوران', icon: '🍽️' },
  { id: 'weapons', name: 'شمشیر‌فروشی', icon: '🗡️' },
  { id: 'workshop', name: 'کارگاه', icon: '🛠️' },
  { id: 'bank', name: 'بانک و ترید', icon: '🏦' },
  { id: 'park', name: 'پارک سه‌بعدی', icon: '🌳' }
];

let shops = {};
const nameOffers = new Map();
const NAME_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const SHOP_ITEMS = {
  phone: [{id:'phone',name:'گوشی ساده',icon:'📱',price:80,kind:'phone'}],
  butcher: [{id:'meat',name:'گوشت',icon:'🥩',price:12,kind:'food',heal:18,hunger:35},{id:'steak',name:'استیک',icon:'🍖',price:25,kind:'food',heal:35,hunger:60}],
  pets: [{id:'pet_hat',name:'کلاه حیوانات',icon:'🐾',price:30,kind:'clothes'}],
  market: [{id:'bread',name:'نان',icon:'🍞',price:8,kind:'food',heal:8,hunger:25},{id:'apple',name:'سیب',icon:'🍎',price:6,kind:'food',heal:5,hunger:18},{id:'water',name:'آب',icon:'💧',price:5,kind:'food',heal:2,hunger:12}],
  school: [{id:'uniform',name:'لباس مدرسه',icon:'🎓',price:20,kind:'clothes'}],
  eggs: [{id:'egg',name:'تخم‌مرغ',icon:'🥚',price:7,kind:'food',heal:7,hunger:20}],
  secondhand: [{id:'coat',name:'کت دست‌دوم',icon:'🧥',price:18,kind:'clothes'},{id:'cap',name:'کلاه',icon:'🧢',price:10,kind:'clothes'}],
  restaurant: [{id:'meal',name:'وعده غذا',icon:'🍲',price:20,kind:'food',heal:25,hunger:55}],
  weapons: [{id:'hotel_sword',name:'شمشیر هتل',icon:'🗡️',price:65,kind:'weapon',damage:28}],
  workshop: [], bank: [], park: []
};
let pool = null;
let storageMode = 'local';
let saveChain = Promise.resolve();
let lastSaveErrorAt = 0;

function randomShops() {
  const result = {};
  const floors = Array.from({ length: MAX_FLOOR - MIN_FLOOR + 1 }, (_, i) => MIN_FLOOR + i);
  for (let i = floors.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [floors[i], floors[j]] = [floors[j], floors[i]]; }
  // Guarantee that every new venue exists at least once.
  SHOP_TYPES.forEach((shop, index) => { result[floors[index]] = shop; });
  for (const floor of floors.slice(SHOP_TYPES.length)) result[floor] = SHOP_TYPES[crypto.randomInt(SHOP_TYPES.length)];
  return result;
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('صفحه پیدا نشد');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, storage: storageMode, online: onlineCount(), residents: activeResidentCount(), accounts: players.size }));
    return;
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath);
});

const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 10_000,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

function onlineCount() {
  let count = 0;
  for (const player of players.values()) if (player.connected) count += 1;
  return count;
}

function hasActiveReservation(player) {
  return Boolean(player && (player.connected || (player.reservedUntil && player.reservedUntil > Date.now())));
}

function activeResidentCount() {
  let count = 0;
  for (const player of players.values()) if (hasActiveReservation(player)) count += 1;
  return count;
}

function countOnFloor(floor) {
  let count = 0;
  for (const player of players.values()) if (player.floor === floor && hasActiveReservation(player)) count += 1;
  return count;
}

function getOccupancy() {
  const occupancy = {};
  for (let floor = MIN_FLOOR; floor <= MAX_FLOOR; floor += 1) occupancy[floor] = 0;
  for (const player of players.values()) if (hasActiveReservation(player)) occupancy[player.floor] += 1;
  return occupancy;
}

function publicState() {
  return {
    players: [...players.values()].filter((player) => !player.banned && hasActiveReservation(player)).map((player) => ({
      id: player.id,
      name: player.name,
      floor: player.floor,
      maxFloor: player.role === 'admin' ? MAX_FLOOR : (floor24Unlocked ? MAX_FLOOR : (player.homeFloorLimit || player.maxFloor)),
      homeFloorLimit: player.homeFloorLimit || player.maxFloor,
      color: player.color,
      hasKey: player.hasKey,
      health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null, equippedWeapon: player.equippedWeapon || null, hasPhone: Boolean(player.hasPhone), role: player.role || 'resident', jobFloor: Number.isInteger(player.jobFloor) ? player.jobFloor : null,
      online: Boolean(player.connected), hasPassword: Boolean(player.passwordHash),
      cryptoWallet: player.cryptoWallet || { BTC: 0, ETH: 0, DOGE: 0 }, workshopTask: player.workshopTask || null, voiceActive: Boolean(player.voiceActive),
      inPark: Boolean(player.inPark), parkPos: player.parkPos || { x: 10, z: 10 },
      inHouse: Boolean(player.houseRoomId),
      reservedUntil: player.reservedUntil || null
    })),
    occupancy: getOccupancy(),
    online: onlineCount(),
    residents: activeResidentCount(),
    maxPlayers: MAX_PLAYERS,
    floorCapacity: FLOOR_CAPACITY,
    floors: { min: MIN_FLOOR, max: MAX_FLOOR },
    shops,
    shopWorkers: getShopWorkers(),
    floor24Unlocked, bankMarket,
    zombies: zombies.map((zombie) => ({ ...zombie, active: true }))
  };
}

function broadcastState() {
  io.emit('worldState', publicState());
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
}

function cleanChatText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
}

function findShopWorker(floor) {
  return [...players.values()].find((person) => person.connected && person.floor === floor && person.jobFloor === floor) || null;
}

function getShopWorkers() {
  const result = {};
  for (let floor = MIN_FLOOR; floor <= MAX_FLOOR; floor += 1) {
    const worker = findShopWorker(floor);
    if (worker) result[floor] = { id: worker.id, name: worker.name, online: true };
  }
  return result;
}

function chatRoleLabel(player) {
  return player.role === 'admin' ? 'ادمین' : player.role === 'guard' ? 'گارد' : '';
}

function cleanToken(value) {
  if (typeof value !== 'string') return '';
  const token = value.trim();
  return /^[a-f0-9-]{32,40}$/i.test(token) ? token : '';
}

function nameKey(value) { return cleanName(value).toLocaleLowerCase('en-US'); }
function findPlayerByName(value, exceptId = null) {
  const key = nameKey(value);
  if (!key) return null;
  return [...players.values()].find((person) => person.id !== exceptId && nameKey(person.name) === key) || null;
}
function makeSecretHash(secret, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return { salt, hash };
}
function verifySecret(secret, salt, expectedHash) {
  if (!salt || !expectedHash || typeof secret !== 'string') return false;
  try {
    const actual = crypto.scryptSync(secret, salt, 64);
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
function makeRecoveryCode() { return crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); }
function normalizeRecoveryCode(code) { return String(code || '').replace(/[^a-f0-9]/gi, '').toUpperCase(); }
function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }
function createCredentials(player, password) {
  const pass = makeSecretHash(password);
  const recoveryCode = makeRecoveryCode();
  const recovery = makeSecretHash(normalizeRecoveryCode(recoveryCode));
  player.passwordSalt = pass.salt; player.passwordHash = pass.hash;
  player.recoverySalt = recovery.salt; player.recoveryHash = recovery.hash;
  return recoveryCode;
}
function pendingOffersFor(playerId) {
  return [...nameOffers.values()].filter((offer) => offer.toId === playerId && offer.status === 'pending' && offer.expiresAt > Date.now()).map((offer) => ({ id: offer.id, fromId: offer.fromId, fromName: players.get(offer.fromId)?.name || offer.buyerNameAtOffer, targetName: offer.offeredName, price: offer.price, expiresAt: offer.expiresAt }));
}
function settleNameOffer(offer, accepted, reason = '') {
  const buyer = players.get(offer.fromId);
  const seller = players.get(offer.toId);
  if (!accepted || !buyer || !seller || nameKey(seller.name) !== nameKey(offer.offeredName) || nameKey(buyer.name) !== nameKey(offer.buyerNameAtOffer)) {
    if (buyer) buyer.coins = (buyer.coins ?? 0) + offer.price;
    nameOffers.delete(offer.id);
    if (buyer?.connected && buyer.socketId) io.to(buyer.socketId).emit('nameOfferResult', { ok: false, message: reason || 'پیشنهاد نام رد شد؛ سکه‌ها به حسابت برگشت.' });
    return false;
  }
  // The two characters exchange names. Their inventories, health, coins, roles and progress stay with their own accounts.
  const buyerOldName = buyer.name;
  buyer.name = seller.name;
  seller.name = buyerOldName;
  seller.coins = (seller.coins ?? 0) + offer.price;
  nameOffers.delete(offer.id);
  if (buyer.socketId) io.to(buyer.socketId).emit('nameOfferResult', { ok: true, message: `خرید نام انجام شد؛ نام جدیدت ${buyer.name} است.` });
  if (seller.socketId) io.to(seller.socketId).emit('playerNotice', { message: `نامت واگذار شد؛ نام جدیدت ${seller.name} است و ${offer.price} سکه گرفتی.` });
  return true;
}
function pruneExpiredNameOffers() {
  const now = Date.now();
  for (const offer of [...nameOffers.values()]) if (offer.expiresAt <= now) settleNameOffer(offer, false, 'مهلت پیشنهاد تمام شد؛ سکه‌ها برگشت داده شد.');
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

const COLORS = ['#ffca74', '#8bd5c6', '#b7a3ef', '#f39bb4', '#8ebcf3', '#b2d58a', '#f2a875', '#a7b6c7'];

const HOUSE_INVITE_TTL_MS = 30_000;
const MINI_GAME_DURATION_MS = 45_000;
const MINI_GAME_COOLDOWN_MS = 350;
const houseRooms = new Map();
const houseInvites = new Map();
const zombies = [
  { id: 'zombie-minus-1', floor: -1, name: 'زامبی راهرو' },
  { id: 'zombie-minus-2', floor: -2, name: 'زامبی زیرزمین' },
  { id: 'zombie-minus-3', floor: -3, name: 'زامبی تاریکی' }
];
const MINI_GAMES = {
  football: { title: 'فوتبال', icon: '⚽', action: 'شوت بزن!', description: 'در ۴۵ ثانیه بیشتر گل بزن.' },
  pingpong: { title: 'پینگ‌پنگ', icon: '🏓', action: 'ضربه بزن!', description: 'توپ را برگردان و امتیاز جمع کن.' },
  race: { title: 'مسابقه ماشین', icon: '🏁', action: 'گاز بده!', description: 'با هر بار گاز دادن جلو می‌روی.' },
  puzzle: { title: 'مسابقه معما', icon: '🧩', action: 'پاسخ بده', description: 'پاسخ درست ۳ امتیاز دارد.' },
  target: { title: 'هدف‌گیری با توپ', icon: '🎯', action: 'توپ پرتاب کن!', description: 'هدف‌های فانتزی را بزن و امتیاز بگیر.' },
  basketball: { title: 'بسکتبال', icon: '🏀', action: 'پرتاب کن!', description: 'هر پرتاب موفق ۲ امتیاز دارد.' },
  record: { title: 'رکوردزنی', icon: '🕹️', action: 'امتیاز بگیر!', description: 'در زمان محدود تا می‌توانی امتیاز جمع کن.' }
};
const PUZZLES = [
  { text: 'حاصل ۲ + ۳ چند می‌شود؟', options: ['۴', '۵', '۶'], answerIndex: 1 },
  { text: 'کدام حیوان میو میو می‌کند؟', options: ['گربه', 'سگ', 'اسب'], answerIndex: 0 },
  { text: 'یک هفته چند روز دارد؟', options: ['۵', '۶', '۷'], answerIndex: 2 },
  { text: 'کدام‌یک وسیلهٔ نقلیه است؟', options: ['صندلی', 'دوچرخه', 'مداد'], answerIndex: 1 },
  { text: 'بعد از عدد ۹ چه عددی می‌آید؟', options: ['۸', '۱۰', '۱۱'], answerIndex: 1 }
];

function connectedPlayer(socket) {
  const playerId = socket.data.playerId;
  const player = playerId ? players.get(playerId) : null;
  if (!player || !player.connected || player.socketId !== socket.id) return null;
  return player;
}

function roomPublicState(room) {
  const members = room.playerIds.map((id) => players.get(id)).filter(Boolean);
  let game = null;
  if (room.game) {
    const scores = members.map((player) => ({
      id: player.id,
      name: player.name,
      score: room.game.scores[player.id] || 0
    }));
    const puzzle = room.game.gameId === 'puzzle' ? PUZZLES[room.game.puzzleIndex % PUZZLES.length] : null;
    game = {
      gameId: room.game.gameId,
      title: MINI_GAMES[room.game.gameId].title,
      icon: MINI_GAMES[room.game.gameId].icon,
      action: MINI_GAMES[room.game.gameId].action,
      description: MINI_GAMES[room.game.gameId].description,
      endsAt: room.game.endsAt,
      ended: room.game.ended,
      winnerId: room.game.winnerId || null,
      resultText: room.game.resultText || '',
      scores,
      question: puzzle ? { text: puzzle.text, options: puzzle.options } : null
    };
  }
  return {
    roomId: room.id,
    floor: room.floor,
    tableGame: room.tableGame || null,
    players: members.map((player) => ({ id: player.id, name: player.name, color: player.color })),
    game
  };
}

function emitHouseRoom(room) {
  if (!room || !houseRooms.has(room.id)) return;
  const state = roomPublicState(room);
  io.to(`house:${room.id}`).emit('houseRoomState', state);
}

function closeHouseRoom(room, message = 'اتاق خانه بسته شد.') {
  if (!room || !houseRooms.has(room.id)) return;
  houseRooms.delete(room.id);
  for (const id of room.playerIds) {
    const player = players.get(id);
    if (!player) continue;
    if (player.socketId) {
      const memberSocket = io.sockets.sockets.get(player.socketId);
      if (memberSocket) {
        memberSocket.leave(`house:${room.id}`);
        memberSocket.emit('houseRoomClosed', { message });
      }
    }
    player.houseRoomId = null;
  }
}

function finishMiniGame(room) {
  if (!room || !houseRooms.has(room.id) || !room.game || room.game.ended) return;
  room.game.ended = true;
  const ranked = room.playerIds.map((id) => ({ id, score: room.game.scores[id] || 0 }));
  const topScore = Math.max(...ranked.map((item) => item.score));
  const winners = ranked.filter((item) => item.score === topScore);
  room.game.winnerId = winners.length === 1 ? winners[0].id : null;
  room.game.resultText = winners.length > 1 ? 'مساوی شد! هر دو عالی بودید.' : `برنده: ${players.get(winners[0].id)?.name || 'بازیکن'} 🎉`;
  emitHouseRoom(room);
}

function removeInvitesFor(playerId) {
  for (const [inviteId, invite] of houseInvites) {
    if (invite.fromId === playerId || invite.toId === playerId) houseInvites.delete(inviteId);
  }
}

function leaveHouseForPlayer(player, message) {
  if (!player?.houseRoomId) return;
  const room = houseRooms.get(player.houseRoomId);
  const roomId = player.houseRoomId;
  player.houseRoomId = null;
  if (!room) return;
  room.playerIds = room.playerIds.filter((id) => id !== player.id);
  if (room.game?.scores) delete room.game.scores[player.id];
  if (room.game?.lastActionAt) delete room.game.lastActionAt[player.id];
  if (player.socketId) {
    const memberSocket = io.sockets.sockets.get(player.socketId);
    if (memberSocket) {
      memberSocket.leave(`house:${roomId}`);
      memberSocket.emit('houseRoomClosed', { message: message || 'از خانه مشترک خارج شدی.' });
    }
  }
  if (room.playerIds.length === 0) {
    if (room.game && !room.game.ended) room.game.ended = true;
    houseRooms.delete(roomId);
    return;
  }
  if (room.game && !room.game.ended && room.playerIds.length === 1) finishMiniGame(room);
  emitHouseRoom(room);
}

function pruneExpiredPlayers() {
  const now = Date.now();
  let changed = false;
  for (const [id, player] of players) {
    if (!player.connected && player.reservedUntil && player.reservedUntil <= now) {
      if (player.passwordHash) {
        player.reservedUntil = null;
        player.disconnectedAt = now;
      } else {
        players.delete(id);
      }
      changed = true;
    }
  }
  return changed;
}

function serializeState() {
  const now = Date.now();
  const savedPlayers = [...players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    passwordSalt: player.passwordSalt || null, passwordHash: player.passwordHash || null, recoverySalt: player.recoverySalt || null, recoveryHash: player.recoveryHash || null,
    floor: player.floor,
    maxFloor: player.maxFloor, homeFloorLimit: player.homeFloorLimit || player.maxFloor, banned: Boolean(player.banned),
    cryptoWallet: player.cryptoWallet || { BTC: 0, ETH: 0, DOGE: 0 }, workshopTask: player.workshopTask || null, lastWorkshopTaskAt: player.lastWorkshopTaskAt || null,
    color: player.color,
    hasKey: player.hasKey,
    health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null, equippedWeapon: player.equippedWeapon || null, hasPhone: Boolean(player.hasPhone), role: player.role || 'resident', jobFloor: Number.isInteger(player.jobFloor) ? player.jobFloor : null,
    connected: Boolean(player.connected),
    disconnectedAt: player.disconnectedAt || null,
    reservedUntil: player.connected ? null : player.reservedUntil,
    lastSeenAt: player.connected ? now : (player.lastSeenAt || player.disconnectedAt || now),
    joinedAt: player.joinedAt
  }));
  return { version: 5.2, players: savedPlayers, shops, nameOffers: [...nameOffers.values()], floor24Unlocked, bankMarket }; 
}

function persistState() {
  const snapshot = serializeState();
  saveChain = saveChain.then(async () => {
    if (storageMode === 'postgres' && pool) {
      await pool.query(
        `INSERT INTO hotel96_state (id, data, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [JSON.stringify(snapshot)]
      );
      return;
    }
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${LOCAL_STATE_FILE}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(snapshot), 'utf8');
    await fs.promises.rename(tempFile, LOCAL_STATE_FILE);
  }).catch((error) => {
    if (Date.now() - lastSaveErrorAt > 30_000) {
      console.error('HOTEL96 save failed:', error.message);
      lastSaveErrorAt = Date.now();
    }
  });
  return saveChain;
}

async function loadState() {
  let saved = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hotel96_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const result = await pool.query('SELECT data FROM hotel96_state WHERE id = 1');
    if (result.rows[0]) saved = result.rows[0].data;
    storageMode = 'postgres';
    console.log('HOTEL96 persistent storage: PostgreSQL');
  } else {
    try {
      saved = JSON.parse(await fs.promises.readFile(LOCAL_STATE_FILE, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read local save:', error.message);
    }
    storageMode = 'local';
    console.warn('WARNING: DATABASE_URL is not set. Local JSON saves may be lost when deployed on Render.');
  }

  if (saved && Array.isArray(saved.players)) {
    const now = Date.now();
    for (const item of saved.players) {
      if (!item || !item.id || !Number.isInteger(item.floor)) continue;
      const lastSeenAt = Number(item.lastSeenAt) || now;
      let reservedUntil = item.connected ? lastSeenAt + RESERVATION_MS : (Number(item.reservedUntil) || null);
      if (reservedUntil && reservedUntil <= now) {
        if (!item.passwordHash) continue;
        reservedUntil = null;
      }
      players.set(item.id, {
        id: item.id,
        name: cleanName(item.name) || 'بازیکن',
        passwordSalt: item.passwordSalt || null, passwordHash: item.passwordHash || null, recoverySalt: item.recoverySalt || null, recoveryHash: item.recoveryHash || null,
        floor: item.floor,
        maxFloor: ADMIN_ACCESS_CODE && cleanName(item.name).toLowerCase() === ADMIN_NAME ? MAX_FLOOR : (Number.isInteger(item.maxFloor) ? item.maxFloor : item.floor),
        homeFloorLimit: Number.isInteger(item.homeFloorLimit) ? item.homeFloorLimit : (Number.isInteger(item.maxFloor) && item.maxFloor < MAX_FLOOR ? item.maxFloor : item.floor), banned: Boolean(item.banned),
        cryptoWallet: item.cryptoWallet && typeof item.cryptoWallet === 'object' ? item.cryptoWallet : { BTC: 0, ETH: 0, DOGE: 0 }, workshopTask: item.workshopTask || null, lastWorkshopTaskAt: Number(item.lastWorkshopTaskAt) || 0, inPark: false, parkPos: { x: 10, z: 10 }, voiceActive: false,
        color: item.color || COLORS[0],
        hasKey: Boolean(item.hasKey),
        health: Number.isFinite(item.health) ? Math.max(0, Math.min(100,item.health)) : 100, hunger: Number.isFinite(item.hunger) ? Math.max(0, Math.min(100,item.hunger)) : 100, coins: Number.isFinite(item.coins) ? item.coins : 100, inventory: Array.isArray(item.inventory) ? item.inventory : [], equipped: item.equipped || null, equippedWeapon: item.equippedWeapon || null, hasPhone: Boolean(item.hasPhone), role: ADMIN_ACCESS_CODE && cleanName(item.name).toLowerCase() === ADMIN_NAME ? 'admin' : (['resident','guard','admin'].includes(item.role) ? item.role : 'resident'), jobFloor: Number.isInteger(item.jobFloor) ? item.jobFloor : null,
        connected: false,
        socketId: null,
        disconnectedAt: Number(item.disconnectedAt) || lastSeenAt,
        reservedUntil,
        lastSeenAt,
        joinedAt: Number(item.joinedAt) || now
      });
    }
    if (saved.shops && typeof saved.shops === 'object') shops = saved.shops;
    if (typeof saved.floor24Unlocked === 'boolean') floor24Unlocked = saved.floor24Unlocked;
    if (saved.bankMarket && typeof saved.bankMarket === 'object') { for (const asset of BANK_ASSETS) { const price = Number(saved.bankMarket[asset.id]?.price); if (Number.isFinite(price) && price > 0) bankMarket[asset.id].price = Math.round(price * 100) / 100; } }
    if (Array.isArray(saved.nameOffers)) for (const offer of saved.nameOffers) if (offer && offer.id && offer.status === 'pending') nameOffers.set(offer.id, offer);
  }
  if (!shops || Object.keys(shops).length === 0) shops = randomShops();
  // Older saves predate the weapon shop; add one without changing existing shop assignments.
  const migrationFloors = Array.from({ length: MAX_FLOOR - MIN_FLOOR + 1 }, (_, i) => MIN_FLOOR + i);
  for (const requiredId of ['weapons', 'workshop', 'bank', 'park']) {
    if (!Object.values(shops).some((shop) => shop && shop.id === requiredId)) {
      const pick = crypto.randomInt(migrationFloors.length);
      const floor = migrationFloors.splice(pick, 1)[0];
      shops[floor] = SHOP_TYPES.find((shop) => shop.id === requiredId);
    }
  }
  pruneExpiredPlayers();
  pruneExpiredNameOffers();
  await persistState();
}

function enterPlayer(socket, player, callback, resumed, extra = {}) {
  player.connected = true;
  player.socketId = socket.id;
  player.disconnectedAt = null;
  player.reservedUntil = null;
  player.lastSeenAt = Date.now();
  socket.data.playerId = player.id;
  socket.join(`floor:${player.floor}`);
  reply(callback, {
    ok: true,
    resumed,
    playerId: player.id,
    player: {
      id: player.id,
      name: player.name,
      floor: player.floor,
      maxFloor: player.role === 'admin' ? MAX_FLOOR : (floor24Unlocked ? MAX_FLOOR : (player.homeFloorLimit || player.maxFloor)),
      homeFloorLimit: player.homeFloorLimit || player.maxFloor,
      color: player.color,
      hasKey: player.hasKey,
      health: player.health ?? 100, hunger: player.hunger ?? 100, coins: player.coins ?? 100, inventory: player.inventory || [], equipped: player.equipped || null, equippedWeapon: player.equippedWeapon || null, hasPhone: Boolean(player.hasPhone), role: player.role || 'resident', jobFloor: Number.isInteger(player.jobFloor) ? player.jobFloor : null, hasPassword: Boolean(player.passwordHash),
      online: true, cryptoWallet: player.cryptoWallet || { BTC: 0, ETH: 0, DOGE: 0 }, workshopTask: player.workshopTask || null
    }, nameOffers: pendingOffersFor(player.id), ...extra
  });
  void persistState();
  broadcastState();
}

io.on('connection', (socket) => {
  socket.emit('worldState', publicState());

  socket.on('accountRegister', (payload = {}, callback) => {
    pruneExpiredPlayers();
    const name = cleanName(payload.name);
    const password = String(payload.password || '');
    const requestedFloor = Number(payload.floor);
    if (name.length < 2) return reply(callback, { ok: false, message: 'اسم باید حداقل ۲ حرف داشته باشد.' });
    if (!validPassword(password)) return reply(callback, { ok: false, message: 'رمز باید حداقل ۸ نویسه داشته باشد.' });
    if (findPlayerByName(name)) return reply(callback, { ok: false, message: 'این نام قبلاً ثبت شده؛ وارد حسابش شو یا نام دیگری انتخاب کن.' });
    if (!Number.isInteger(requestedFloor) || requestedFloor < 1 || requestedFloor > 24) return reply(callback, { ok: false, message: 'طبقه باید بین ۱ تا ۲۴ باشد.' });
    if (activeResidentCount() >= MAX_PLAYERS) return reply(callback, { ok: false, message: 'ظرفیت کل هتل پر شده است.' });
    if (countOnFloor(requestedFloor) >= FLOOR_CAPACITY) return reply(callback, { ok: false, message: `طبقه ${requestedFloor} پر است؛ طبقه دیگری انتخاب کن.` });
    const wantsAdmin = name.toLowerCase() === ADMIN_NAME;
    if (wantsAdmin && (!ADMIN_ACCESS_CODE || String(payload.adminCode || '') !== ADMIN_ACCESS_CODE)) return reply(callback, { ok: false, message: !ADMIN_ACCESS_CODE ? 'مدیر سرور باید ADMIN_ACCESS_CODE را در Render تنظیم کند.' : 'رمز ادمین درست نیست.' });
    const id = crypto.randomUUID();
    const player = { id, name, floor: requestedFloor, maxFloor: wantsAdmin ? MAX_FLOOR : requestedFloor, homeFloorLimit: requestedFloor, cryptoWallet: { BTC: 0, ETH: 0, DOGE: 0 }, banned: false, inPark: false, parkPos: { x: 10, z: 10 }, voiceActive: false, color: COLORS[crypto.randomInt(COLORS.length)], hasKey: false, health: 100, hunger: 100, coins: 100, inventory: [], equipped: null, equippedWeapon: null, hasPhone: false, role: wantsAdmin ? 'admin' : 'resident', jobFloor: null, connected: false, socketId: null, disconnectedAt: null, reservedUntil: null, lastSeenAt: Date.now(), joinedAt: Date.now() };
    const recoveryCode = createCredentials(player, password);
    players.set(id, player);
    enterPlayer(socket, player, callback, false, { recoveryCode });
  });

  socket.on('accountLogin', (payload = {}, callback) => {
    pruneExpiredPlayers();
    const name = cleanName(payload.name);
    const player = findPlayerByName(name);
    if (player?.banned) return reply(callback, { ok: false, message: 'این حساب توسط ادمین مسدود شده است.' });
    if (!player || !player.passwordHash || !verifySecret(String(payload.password || ''), player.passwordSalt, player.passwordHash)) return reply(callback, { ok: false, message: 'نام کاربری یا رمز عبور نادرست است.' });
    if (player.connected && player.socketId !== socket.id) return reply(callback, { ok: false, message: 'این حساب هم‌اکنون روی دستگاه دیگری آنلاین است.' });
    const floor = Number(payload.floor);
    if (!hasActiveReservation(player)) {
      if (!Number.isInteger(floor) || floor < 1 || floor > 24) return reply(callback, { ok: false, message: 'یک طبقه معتبر انتخاب کن.' });
      if (activeResidentCount() >= MAX_PLAYERS || countOnFloor(floor) >= FLOOR_CAPACITY) return reply(callback, { ok: false, message: 'این طبقه یا ظرفیت هتل پر است؛ طبقه دیگری انتخاب کن.' });
      player.floor = floor;
      if (!['guard', 'admin'].includes(player.role)) player.maxFloor = floor;
    }
    enterPlayer(socket, player, callback, true);
  });

  socket.on('accountSecure', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (player.passwordHash) return reply(callback, { ok: false, message: 'حساب تو از قبل رمز دارد.' });
    const password = String(payload.password || '');
    if (!validPassword(password)) return reply(callback, { ok: false, message: 'رمز باید حداقل ۸ نویسه داشته باشد.' });
    const recoveryCode = createCredentials(player, password);
    reply(callback, { ok: true, recoveryCode, message: 'حساب با رمز محافظت شد.' });
    void persistState(); broadcastState();
  });

  socket.on('accountRecover', (payload = {}, callback) => {
    const player = findPlayerByName(payload.name);
    const recovery = normalizeRecoveryCode(payload.recoveryCode);
    const newPassword = String(payload.newPassword || '');
    if (!player || !player.recoveryHash || !verifySecret(recovery, player.recoverySalt, player.recoveryHash)) return reply(callback, { ok: false, message: 'نام کاربری یا کد بازیابی درست نیست.' });
    if (!validPassword(newPassword)) return reply(callback, { ok: false, message: 'رمز جدید باید حداقل ۸ نویسه داشته باشد.' });
    const recoveryCode = createCredentials(player, newPassword);
    if (player.connected) { leaveHouseForPlayer(player, 'حساب در حال بازیابی است.'); removeInvitesFor(player.id); }
    if (player.connected && player.socketId) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) { oldSocket.data.playerId = null; oldSocket.leave(`floor:${player.floor}`); oldSocket.emit('accountSessionEnded', { message: 'رمز حساب تغییر کرد؛ دوباره وارد شو.' }); }
      player.connected = false; player.socketId = null; player.disconnectedAt = Date.now(); player.reservedUntil = Date.now() + RESERVATION_MS;
    }
    reply(callback, { ok: true, recoveryCode, message: 'رمزت تغییر کرد. کد بازیابی جدید را نگه دار.' });
    void persistState(); broadcastState();
  });

  socket.on('logout', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'حساب فعالی پیدا نشد.' });
    if (!player.passwordHash) return reply(callback, { ok: false, message: 'برای خروج امن، اول از دکمه «امنیت حساب» رمز و کد بازیابی بساز.' });
    if (player.voiceActive) io.to(`floor:${player.floor}`).emit('voicePresence', { playerId: player.id, name: player.name, active: false });
    player.voiceActive = false; player.inPark = false; socket.leave('hotel-park');
    leaveHouseForPlayer(player, `${player.name} از بازی خارج شد.`); removeInvitesFor(player.id);
    player.connected = false; player.socketId = null; player.disconnectedAt = Date.now(); player.reservedUntil = Date.now() + RESERVATION_MS; player.lastSeenAt = Date.now();
    socket.leave(`floor:${player.floor}`); socket.data.playerId = null;
    reply(callback, { ok: true, message: 'از حساب خارج شدی؛ برای ورود دوباره نام و رمزت را وارد کن.' });
    void persistState(); broadcastState();
  });

  socket.on('nameMarketList', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const entries = [...players.values()].filter((person) => !person.banned && person.id !== player.id && person.role !== 'admin' && nameKey(person.name) !== ADMIN_NAME).map((person) => ({ id: person.id, name: person.name, online: Boolean(person.connected), floor: hasActiveReservation(person) ? person.floor : null }));
    reply(callback, { ok: true, entries });
  });

  socket.on('nameOfferCreate', (payload = {}, callback) => {
    pruneExpiredPlayers(); pruneExpiredNameOffers();
    const buyer = connectedPlayer(socket); const target = players.get(String(payload.targetId || ''));
    const price = Math.floor(Number(payload.price));
    if (!buyer || !target || buyer.id === target.id || target.role === 'admin' || nameKey(target.name) === ADMIN_NAME) return reply(callback, { ok: false, message: 'صاحب این نام برای معامله در دسترس نیست.' });
    if (!Number.isSafeInteger(price) || price < 1 || price > 100000000) return reply(callback, { ok: false, message: 'قیمت باید بین ۱ تا ۱۰۰٬۰۰۰٬۰۰۰ سکه باشد.' });
    if (price > (buyer.coins ?? 0)) return reply(callback, { ok: false, message: 'سکه کافی نداری.' });
    if (nameKey(buyer.name) === nameKey(target.name)) return reply(callback, { ok: false, message: 'این نام همین حالا متعلق به خودت است.' });
    if (nameOffers.size >= 250) return reply(callback, { ok: false, message: 'بازار پیشنهادهای فعال زیادی دارد؛ بعداً دوباره تلاش کن.' });
    if ([...nameOffers.values()].some((offer) => offer.status === 'pending' && [offer.fromId, offer.toId].some((id) => id === buyer.id || id === target.id))) return reply(callback, { ok: false, message: 'یکی از این دو حساب در معامله دیگری است؛ اول پاسخ آن پیشنهاد مشخص شود.' });
    buyer.coins -= price;
    const offer = { id: crypto.randomUUID(), fromId: buyer.id, toId: target.id, buyerNameAtOffer: buyer.name, offeredName: target.name, price, createdAt: Date.now(), expiresAt: Date.now() + NAME_OFFER_TTL_MS, status: 'pending' };
    nameOffers.set(offer.id, offer);
    if (target.connected && target.socketId) io.to(target.socketId).emit('nameOfferReceived', { id: offer.id, fromId: buyer.id, fromName: buyer.name, targetName: target.name, price: offer.price, expiresAt: offer.expiresAt });
    reply(callback, { ok: true, message: `پیشنهاد ${price} سکه‌ای برای ${target.name} ارسال شد؛ سکه تا جواب صاحب نام رزرو است.` });
    void persistState(); broadcastState();
  });

  socket.on('nameOfferRespond', (payload = {}, callback) => {
    const seller = connectedPlayer(socket);
    pruneExpiredNameOffers();
    const offer = nameOffers.get(String(payload.offerId || ''));
    if (!seller || !offer || offer.toId !== seller.id || offer.status !== 'pending') return reply(callback, { ok: false, message: 'این پیشنهاد دیگر معتبر نیست.' });
    if (payload.accept) {
      const buyer = players.get(offer.fromId);
      const collision = findPlayerByName(offer.buyerNameAtOffer, buyer?.id) || findPlayerByName(offer.offeredName, seller.id);
      if (!buyer || collision || nameKey(seller.name) !== nameKey(offer.offeredName) || nameKey(buyer.name) !== nameKey(offer.buyerNameAtOffer)) {
        settleNameOffer(offer, false, 'نام یکی از طرفین تغییر کرده یا دیگر قابل انتقال نیست؛ سکه‌ها برگشت خورد.');
        void persistState(); broadcastState();
        return reply(callback, { ok: false, message: 'این معامله قابل انجام نیست؛ پیشنهاد لغو و سکه‌ها برگشت داده شد.' });
      }
      settleNameOffer(offer, true);
      reply(callback, { ok: true, message: `معامله انجام شد؛ ${offer.price} سکه گرفتی و نام جدیدت ${seller.name} است.` });
    } else {
      settleNameOffer(offer, false, 'صاحب نام پیشنهاد را رد کرد؛ سکه‌ها برگشت داده شد.');
      reply(callback, { ok: true, message: 'پیشنهاد رد شد و سکه‌ها به خریدار برگشت.' });
    }
    void persistState(); broadcastState();
  });

  socket.on('join', (payload = {}, callback) => {
    pruneExpiredPlayers();
    const token = cleanToken(payload.token);
    const existing = token ? players.get(token) : null;

    if (payload.resumeOnly) {
      if (existing?.banned) { reply(callback, { ok: false, expired: true, message: 'این حساب توسط ادمین مسدود شده است.' }); return; }
      if (!existing || (existing.passwordHash && !existing.connected && !hasActiveReservation(existing))) {
        reply(callback, { ok: false, expired: true, message: 'برای ورود دوباره، نام کاربری و رمز حسابت را وارد کن.' });
        return;
      }
      if (existing.connected && existing.socketId !== socket.id) {
        reply(callback, { ok: false, message: 'این شخصیت هم‌اکنون در دستگاه دیگری آنلاین است.' });
        return;
      }
      enterPlayer(socket, existing, callback, true);
      return;
    }

    if (existing) {
      if (existing.banned) { reply(callback, { ok: false, expired: true, message: 'این حساب توسط ادمین مسدود شده است.' }); return; }
      if (existing.connected && existing.socketId !== socket.id) {
        reply(callback, { ok: false, message: 'این شخصیت هم‌اکنون در دستگاه دیگری آنلاین است.' });
        return;
      }
      enterPlayer(socket, existing, callback, true);
      return;
    }

    const name = cleanName(payload.name);
    const requestedFloor = Number(payload.floor);
    if (!token) {
      reply(callback, { ok: false, message: 'شناسه بازیکن معتبر نیست؛ صفحه را تازه‌سازی کن.' });
      return;
    }
    if (name.length < 2) {
      reply(callback, { ok: false, message: 'اسم باید حداقل ۲ حرف داشته باشد.' });
      return;
    }
    if (findPlayerByName(name)) { reply(callback, { ok: false, message: 'این نام قبلاً انتخاب شده است؛ نام دیگری وارد کن.' }); return; }
    const wantsAdmin = name.toLowerCase() === ADMIN_NAME;
    if (wantsAdmin && (!ADMIN_ACCESS_CODE || String(payload.adminCode || '') !== ADMIN_ACCESS_CODE)) {
      reply(callback, { ok: false, message: !ADMIN_ACCESS_CODE ? 'برای فعال شدن ادمین، مدیر سرور باید ADMIN_ACCESS_CODE را در Environment سرویس Render تنظیم کند.' : 'رمز ادمین درست نیست.' });
      return;
    }
    if (!Number.isInteger(requestedFloor) || requestedFloor < 1 || requestedFloor > 24) {
      reply(callback, { ok: false, message: 'طبقه باید بین ۱ تا ۲۴ باشد.' });
      return;
    }
    if (activeResidentCount() >= MAX_PLAYERS) {
      reply(callback, { ok: false, message: 'ظرفیت کل هتل پر شده است؛ فعلاً نمی‌توانی وارد شوی.' });
      return;
    }
    if (countOnFloor(requestedFloor) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${requestedFloor} پر است! نمی‌توانی وارد شوی؛ یک طبقه دیگر انتخاب کن.` });
      return;
    }

    const player = {
      id: token,
      name,
      floor: requestedFloor,
      maxFloor: wantsAdmin ? MAX_FLOOR : requestedFloor,
      homeFloorLimit: requestedFloor, cryptoWallet: { BTC: 0, ETH: 0, DOGE: 0 }, banned: false, inPark: false, parkPos: { x: 10, z: 10 }, voiceActive: false,
      color: COLORS[crypto.randomInt(COLORS.length)],
      hasKey: false,
      passwordSalt: null, passwordHash: null, recoverySalt: null, recoveryHash: null,
      health: 100, hunger: 100, coins: 100, inventory: [], equipped: null, equippedWeapon: null, hasPhone: false, role: wantsAdmin ? 'admin' : 'resident', jobFloor: null,
      connected: false,
      socketId: null,
      disconnectedAt: null,
      reservedUntil: null,
      lastSeenAt: Date.now(),
      joinedAt: Date.now()
    };
    players.set(token, player);
    enterPlayer(socket, player, callback, false);
  });

  socket.on('moveFloor', (payload = {}, callback) => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (!player || !player.connected || player.socketId !== socket.id) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }

    if (player.houseRoomId) {
      reply(callback, { ok: false, message: 'اول از خانه مشترک خارج شو، بعد آسانسور را استفاده کن.' });
      return;
    }
    const target = Number(payload.floor);
    if (!Number.isInteger(target) || target < MIN_FLOOR || target > MAX_FLOOR) {
      reply(callback, { ok: false, message: 'این طبقه وجود ندارد.' });
      return;
    }
    if (target === player.floor) {
      reply(callback, { ok: false, message: 'الان همین طبقه هستی.' });
      return;
    }
    const personalLimit = Number.isInteger(player.homeFloorLimit) ? player.homeFloorLimit : player.maxFloor;
    if (player.role !== 'admin' && !floor24Unlocked && target > personalLimit) {
      reply(callback, { ok: false, canBecomeGuard: true, message: `قفل طبقات بالایی فعال است؛ حد مجاز تو طبقه ${personalLimit} است.` });
      return;
    }
    if (target < 0 && !player.hasKey) {
      reply(callback, { ok: false, message: 'برای رفتن به زیرزمین اول باید کلید طبقه صفر را برداری.' });
      return;
    }
    if (target < 0 && player.floor > 0) {
      reply(callback, { ok: false, message: 'اول باید از طبقه ۱ وارد طبقه صفر شوی.' });
      return;
    }
    if (target === 0 && !player.hasKey) {
      reply(callback, { ok: false, message: 'درِ طبقه صفر قفل است. اول در طبقه ۱ کلید را پیدا کن.' });
      return;
    }
    if (countOnFloor(target) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${target} پر است! یک طبقه دیگر را امتحان کن.` });
      return;
    }

    const oldFloor = player.floor;
    if (player.voiceActive) { player.voiceActive = false; io.to(`floor:${oldFloor}`).emit('voicePresence', { playerId: player.id, name: player.name, active: false }); }
    player.inPark = false; socket.leave('hotel-park');
    socket.leave(`floor:${oldFloor}`);
    player.floor = target;
    socket.join(`floor:${target}`);
    player.lastSeenAt = Date.now();
    reply(callback, { ok: true, message: `از طبقه ${oldFloor} به طبقه ${target} رفتی.` });
    void persistState();
    broadcastState();
  });

  socket.on('collectKey', (_payload, callback) => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (!player || !player.connected || player.socketId !== socket.id) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }
    if (player.floor !== 1) {
      reply(callback, { ok: false, message: 'جعبه کلید فقط در طبقه ۱ قرار دارد.' });
      return;
    }
    if (player.hasKey) {
      reply(callback, { ok: true, message: 'کلید را قبلاً برداشته‌ای.' });
      return;
    }
    player.hasKey = true;
    player.lastSeenAt = Date.now();
    reply(callback, { ok: true, message: 'کلید طبقه صفر را پیدا کردی! حالا در باز می‌شود.' });
    void persistState();
    broadcastState();
  });

  socket.on('shopWorkStart', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (!shops[player.floor] || shops[player.floor].id === 'park') return reply(callback, { ok: false, message: 'این مکان فروشگاه استخدامی نیست.' });
    const current = findShopWorker(player.floor);
    if (current && current.id !== player.id) return reply(callback, { ok: false, message: `${current.name} مسئول این فروشگاه است.` });
    if (player.jobFloor !== null && player.jobFloor !== undefined && player.jobFloor !== player.floor) {
      return reply(callback, { ok: false, message: 'اول از کار قبلی استعفا بده.' });
    }
    player.jobFloor = player.floor;
    reply(callback, { ok: true, message: `از حالا مسئول فروشگاه ${shops[player.floor].name} هستی.` });
    void persistState();
    broadcastState();
  });

  socket.on('shopWorkQuit', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (player.jobFloor === null || player.jobFloor === undefined) return reply(callback, { ok: false, message: 'الان شغل فروشگاهی نداری.' });
    const oldFloor = player.jobFloor;
    player.jobFloor = null; player.workshopTask = null;
    reply(callback, { ok: true, message: 'از کار فروشگاه استعفا دادی؛ فروشگاه تا استخدام کارمند جدید بسته می‌ماند.' });
    void persistState();
    broadcastState();
  });

  socket.on('shopBuy', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const shop = shops[player.floor];
    const worker = findShopWorker(player.floor);
    if (!worker) return reply(callback, { ok: false, message: 'فروشگاه بسته است؛ اول باید یک بازیکن در این فروشگاه مشغول به کار شود.' });
    if (worker.id === player.id) return reply(callback, { ok: false, message: 'کارمند فروشگاه نمی‌تواند از فروشگاه خودش خرید کند.' });
    const item = (SHOP_ITEMS[shop?.id] || []).find((x) => x.id === payload.itemId);
    if (!item) return reply(callback, { ok: false, message: 'این کالا در فروشگاه این طبقه نیست.' });
    if ((player.coins ?? 100) < item.price) return reply(callback, { ok: false, message: 'سکه کافی نداری.' });
    player.coins -= item.price;
    player.inventory ||= [];
    player.inventory.push({ id: item.id, name: item.name, icon: item.icon, kind: item.kind, heal: item.heal || 0, hunger: item.hunger || 0, damage: item.damage || 0 });
    worker.coins = (worker.coins ?? 100) + 3;
    if (worker.socketId) io.to(worker.socketId).emit('playerNotice', { message: `یک خرید انجام شد؛ ۳ سکه دستمزد گرفتی! 🪙` });
    reply(callback, { ok: true, message: `${item.name} خریدی! کارمند فروشگاه هم ۳ سکه گرفت.` });
    void persistState();
    broadcastState();
  });

  socket.on('workshopTaskStart', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const shop = shops[player.floor];
    if (shop?.id !== 'workshop' || player.jobFloor !== player.floor) return reply(callback, { ok: false, message: 'برای انجام کار باید کارمند کارگاه همین طبقه باشی.' });
    const now = Date.now();
    if (player.workshopTask) return reply(callback, { ok: false, message: player.workshopTask.endsAt > now ? 'هنوز مشغول انجام سفارش قبلی هستی.' : 'سفارش آماده است؛ اول آن را تحویل بده.' });
    if (player.lastWorkshopTaskAt && now - player.lastWorkshopTaskAt < 10_000) return reply(callback, { ok: false, message: 'برای سفارش بعدی چند لحظه صبر کن.' });
    const taskCatalog = {
      lamp: { label: 'تعمیر چراغ مطالعه', duration: 6000, reward: 14 },
      chair: { label: 'ساخت یک صندلی کوچک', duration: 10000, reward: 22 },
      cart: { label: 'تعمیر چرخ‌دستی', duration: 8000, reward: 18 },
      shelf: { label: 'ساخت قفسه چوبی', duration: 14000, reward: 30 }
    };
    const chosenTask = taskCatalog[String(_payload.taskId || '')];
    if (!chosenTask) return reply(callback, { ok: false, message: 'نوع سفارش را از فهرست کارگاه انتخاب کن.' });
    player.workshopTask = { ...chosenTask, endsAt: now + chosenTask.duration };
    player.lastWorkshopTaskAt = now;
    reply(callback, { ok: true, task: player.workshopTask, message: `سفارش شروع شد: ${player.workshopTask.label}. حدود ${Math.ceil(chosenTask.duration / 1000)} ثانیه بعد تحویل بده.` });
    void persistState(); broadcastState();
  });

  socket.on('workshopTaskFinish', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const task = player.workshopTask;
    if (shops[player.floor]?.id !== 'workshop' || player.jobFloor !== player.floor) return reply(callback, { ok: false, message: 'برای تحویل سفارش باید در همان کارگاه مشغول باشی.' });
    if (!task || Date.now() < task.endsAt) return reply(callback, { ok: false, message: 'سفارش هنوز آماده نشده است.' });
    player.coins = (player.coins || 0) + task.reward;
    player.workshopTask = null;
    reply(callback, { ok: true, message: `سفارش تحویل شد؛ ${task.reward} سکه دستمزد گرفتی!` });
    void persistState(); broadcastState();
  });

  socket.on('bankTrade', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (shops[player.floor]?.id !== 'bank' || !findShopWorker(player.floor)) return reply(callback, { ok: false, message: 'بانک بسته است؛ اول یک کارمند آنلاین استخدام شود.' });
    const assetId = String(payload.asset || '').toUpperCase();
    const asset = bankMarket[assetId];
    const quantity = Math.floor(Number(payload.quantity));
    const side = payload.side === 'sell' ? 'sell' : 'buy';
    if (!asset || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) return reply(callback, { ok: false, message: 'ارز یا تعداد معامله معتبر نیست (۱ تا ۱۰۰ واحد).' });
    const bankWorker = findShopWorker(player.floor);
    const wallet = player.cryptoWallet || (player.cryptoWallet = { BTC: 0, ETH: 0, DOGE: 0 });
    const total = Math.round(asset.price * quantity * 100) / 100;
    if (side === 'buy') {
      if ((player.coins || 0) < total) return reply(callback, { ok: false, message: `برای این خرید ${total} سکه نیاز داری.` });
      player.coins -= total; wallet[assetId] = Math.round(((wallet[assetId] || 0) + quantity) * 100) / 100;
    } else {
      if ((wallet[assetId] || 0) < quantity) return reply(callback, { ok: false, message: `فقط ${wallet[assetId] || 0} واحد از این ارز داری.` });
      wallet[assetId] = Math.round((wallet[assetId] - quantity) * 100) / 100; player.coins = Math.round(((player.coins || 0) + total) * 100) / 100;
    }
    if (bankWorker && bankWorker.id !== player.id) { bankWorker.coins = (bankWorker.coins || 0) + 3; if (bankWorker.socketId) io.to(bankWorker.socketId).emit('playerNotice', { message: 'یک معامله بانکی انجام شد؛ ۳ سکه کارمزد گرفتی.' }); }
    reply(callback, { ok: true, message: side === 'buy' ? `${quantity} واحد ${asset.name} خریدی؛ ${total} سکه پرداخت شد.` : `${quantity} واحد ${asset.name} فروختی؛ ${total} سکه گرفتی.`, coins: player.coins, wallet });
    void persistState(); broadcastState();
  });

  socket.on('useItem', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const index = (player.inventory || []).findIndex((x) => x.id === payload.itemId);
    if (index < 0) return reply(callback, { ok: false, message: 'این وسیله در کیف نیست.' });
    const item = player.inventory[index];
    if (item.kind === 'food') {
      player.health = Math.min(100, (player.health ?? 100) + (item.heal || 0));
      player.hunger = Math.min(100, (player.hunger ?? 100) + (item.hunger || 0));
      player.inventory.splice(index, 1);
    } else if (item.kind === 'clothes') {
      player.equipped = item.id;
    } else if (item.kind === 'phone') {
      player.hasPhone = true;
    } else if (item.kind === 'weapon') {
      player.equippedWeapon = item.id;
    } else {
      return reply(callback, { ok: false, message: 'این وسیله فعلاً قابل استفاده نیست.' });
    }
    const message = item.kind === 'food' ? 'غذا خوردی و وضعیتت بهتر شد.' : item.kind === 'clothes' ? 'لباست را پوشیدی.' : item.kind === 'phone' ? 'گوشی فعال شد؛ حالا می‌توانی پیام‌های طبقه را ببینی.' : 'شمشیرت را آماده کردی!';
    reply(callback, { ok: true, message });
    void persistState();
    broadcastState();
  });

  socket.on('attackPlayer', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const target = players.get(String(payload.targetId || ''));
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (!target || !target.connected || target.floor !== player.floor || target.id === player.id) return reply(callback, { ok: false, message: 'بازیکن مناسبی برای حمله پیدا نشد.' });
    const now = Date.now();
    if (player.lastAttackAt && now - player.lastAttackAt < 1800) return reply(callback, { ok: false, message: 'کمی صبر کن.' });
    player.lastAttackAt = now;
    const damage = player.equippedWeapon === 'hotel_sword' ? 28 : 12;
    target.health = Math.max(0, (target.health ?? 100) - damage);
    if (target.health === 0) {
      target.health = 35;
      const priorFloor = target.floor;
      target.floor = Math.max(1, Math.min(target.maxFloor, target.floor));
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket && priorFloor !== target.floor) { targetSocket.leave(`floor:${priorFloor}`); targetSocket.join(`floor:${target.floor}`); }
      target.hunger = Math.max(0, (target.hunger ?? 100) - 10);
      io.to(target.socketId).emit('playerNotice', { message: 'در بازی بیهوش شدی و به خانه برگشتی؛ کمی از جونت برگشت.' });
    }
    reply(callback, { ok: true, message: player.equippedWeapon === 'hotel_sword' ? `با شمشیر به ${target.name} ضربه زدی.` : `با دست به ${target.name} ضربه زدی.` });
    if (target.socketId) io.to(target.socketId).emit('playerNotice', { message: `${player.name} در بازی به تو ضربه زد!` });
    void persistState();
    broadcastState();
  });

  socket.on('guardPromotion', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (player.role === 'admin' || player.role === 'guard') return reply(callback, { ok: true, message: 'نقش ویژه‌ات از قبل فعال است.' });
    if (player.floor !== player.maxFloor) return reply(callback, { ok: false, message: 'برای درخواست گارد باید در بالاترین طبقه مجاز خودت باشی.' });
    player.role = 'guard';
    player.maxFloor = MAX_FLOOR;
    reply(callback, { ok: true, message: 'به گارد هتل ارتقا پیدا کردی! حالا می‌توانی تا طبقه ۲۴ بروی.' });
    void persistState();
    broadcastState();
  });

  socket.on('parkEnter', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (player.houseRoomId) return reply(callback, { ok: false, message: 'اول از خانه خارج شو.' });
    player.inPark = true; player.parkPos = player.parkPos || { x: 10, z: 10 };
    socket.join('hotel-park');
    reply(callback, { ok: true, message: 'به پارک رسیدی؛ با WASD یا دکمه‌های جهت حرکت کن.' });
    broadcastState();
  });

  socket.on('parkMove', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player || !player.inPark) return reply(callback, { ok: false, message: 'اول وارد پارک شو.' });
    const now = Date.now();
    if (player.lastParkMoveAt && now - player.lastParkMoveAt < 70) return reply(callback, { ok: false, message: 'کمی آهسته‌تر حرکت کن.' });
    player.lastParkMoveAt = now;
    const x = Number(payload.x), z = Number(payload.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return reply(callback, { ok: false, message: 'مختصات حرکت معتبر نیست.' });
    player.parkPos = { x: Math.max(1, Math.min(19, x)), z: Math.max(1, Math.min(19, z)) };
    reply(callback, { ok: true });
    broadcastState();
  });

  socket.on('parkLeave', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'حساب فعالی پیدا نشد.' });
    player.inPark = false; socket.leave('hotel-park');
    reply(callback, { ok: true }); broadcastState();
  });

  socket.on('voicePresence', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const active = Boolean(payload.active);
    player.voiceActive = active;
    io.to(`floor:${player.floor}`).emit('voicePresence', { playerId: player.id, name: player.name, active });
    reply(callback, { ok: true, active });
    broadcastState();
  });

  socket.on('voiceSignal', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const target = players.get(String(payload.targetId || ''));
    if (!player || !target || !target.connected || !target.socketId) return reply(callback, { ok: false, message: 'بازیکن صدا پیدا نشد.' });
    const sameFloor = player.floor === target.floor;
    const sameHouse = player.houseRoomId && player.houseRoomId === target.houseRoomId;
    if (!sameFloor && !sameHouse) return reply(callback, { ok: false, message: 'چت صوتی فقط برای هم‌طبقه‌ای‌ها یا هم‌خانه‌ای‌ها فعال است.' });
    const signal = {};
    if (payload.description && typeof payload.description === 'object') signal.description = payload.description;
    if (payload.candidate && typeof payload.candidate === 'object') signal.candidate = payload.candidate;
    io.to(target.socketId).emit('voiceSignal', { fromId: player.id, fromName: player.name, ...signal });
    reply(callback, { ok: true });
  });

  socket.on('chatSend', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    const message = cleanChatText(payload.message);
    if (!message) return reply(callback, { ok: false, message: 'پیامت خالی است.' });
    const now = Date.now();
    if (player.lastChatAt && now - player.lastChatAt < CHAT_COOLDOWN_MS) return reply(callback, { ok: false, message: 'برای فرستادن پیام بعدی کمی صبر کن.' });
    player.lastChatAt = now;
    const packet = { id: crypto.randomUUID(), name: player.name, role: chatRoleLabel(player), message, floor: player.floor, at: now };
    io.to(`floor:${player.floor}`).emit('chatMessage', packet);
    reply(callback, { ok: true });
  });

  socket.on('escapeAttempt', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول وارد بازی شو.' });
    if (player.role === 'guard' || player.role === 'admin') return reply(callback, { ok: false, message: 'گاردها و ادمین‌ها نمی‌توانند مخفیانه از هتل خارج شوند.' });
    if (player.floor !== 1) return reply(callback, { ok: false, message: 'برای خروج مخفیانه باید در طبقه ۱ باشی.' });
    const guards = [...players.values()].filter((person) => person.connected && person.role === 'guard' && person.floor === 1);
    const caught = guards.length ? Math.random() < 0.72 : Math.random() < 0.32;
    if (caught) {
      player.health = Math.max(1, (player.health ?? 100) - 8);
      for (const guard of guards) if (guard.socketId) io.to(guard.socketId).emit('playerNotice', { message: `نگهبانی متوجه تلاش ${player.name} برای خروج شد!` });
      reply(callback, { ok: false, caught: true, message: '🚨 گارد متوجه شد و جلوی خروجت را گرفت! ۸ واحد از جونت کم شد؛ دوباره تلاش کن.' });
      void persistState();
      broadcastState();
      return;
    }
    if (player.voiceActive) io.to(`floor:${player.floor}`).emit('voicePresence', { playerId: player.id, name: player.name, active: false });
    player.voiceActive = false; player.inPark = false; socket.leave('hotel-park');
    leaveHouseForPlayer(player, 'بازیکن از هتل خارج شد.');
    removeInvitesFor(player.id);
    const now = Date.now();
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = now;
    player.reservedUntil = now + RESERVATION_MS;
    player.lastSeenAt = now;
    socket.leave(`floor:${player.floor}`);
    socket.data.playerId = null;
    reply(callback, { ok: true, message: '🌙 با موفقیت مخفیانه از هتل خارج شدی. شخصیتت تا ۲۴ ساعت رزرو می‌ماند.' });
    void persistState();
    broadcastState();
  });

  socket.on('adminFillStat', (payload = {}, callback) => {
    const admin = connectedPlayer(socket);
    if (!admin || admin.role !== 'admin') return reply(callback, { ok: false, message: 'فقط ادمین اجازه دارد.' });
    const target = players.get(String(payload.targetId || ''));
    if (!target) return reply(callback, { ok: false, message: 'بازیکن هدف پیدا نشد.' });
    const stat = payload.stat === 'hunger' ? 'hunger' : 'health';
    target[stat] = 100;
    if (target.socketId) io.to(target.socketId).emit('playerNotice', { message: stat === 'hunger' ? 'ادمین نوار غذا را کامل کرد! 🍖' : 'ادمین جونت را کامل کرد! ❤️' });
    reply(callback, { ok: true, message: stat === 'hunger' ? `غذای ${target.name} پر شد.` : `جون ${target.name} پر شد.` });
    void persistState(); broadcastState();
  });

  socket.on('adminFloor24Toggle', (payload = {}, callback) => {
    const admin = connectedPlayer(socket);
    if (!admin || admin.role !== 'admin') return reply(callback, { ok: false, message: 'فقط ادمین اجازه دارد.' });
    floor24Unlocked = Boolean(payload.unlocked);
    reply(callback, { ok: true, unlocked: floor24Unlocked, message: floor24Unlocked ? 'طبقات تا ۲۴ برای همه باز شد.' : 'قفل طبقات بالایی فعال شد؛ هر بازیکن تا حد مجاز خودش می‌رود.' });
    void persistState(); broadcastState();
  });

  socket.on('adminBan', (payload = {}, callback) => {
    const admin = connectedPlayer(socket);
    if (!admin || admin.role !== 'admin') return reply(callback, { ok: false, message: 'فقط ادمین اجازه دارد.' });
    const target = players.get(String(payload.targetId || ''));
    if (!target || target.id === admin.id || target.role === 'admin') return reply(callback, { ok: false, message: 'این بازیکن را نمی‌توان مسدود کرد.' });
    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : null;
    if (target.voiceActive) io.to(`floor:${target.floor}`).emit('voicePresence', { playerId: target.id, name: target.name, active: false });
    target.banned = true; target.connected = false; target.socketId = null; target.inPark = false; target.voiceActive = false;
    target.disconnectedAt = Date.now(); target.reservedUntil = null;
    leaveHouseForPlayer(target, 'یکی از بازیکنان مسدود شد.'); removeInvitesFor(target.id);
    if (targetSocket) { targetSocket.data.playerId = null; targetSocket.emit('adminNotice', { message: 'حسابت توسط ادمین مسدود شد.' }); targetSocket.disconnect(true); }
    reply(callback, { ok: true, message: `${target.name} مسدود شد.` });
    void persistState(); broadcastState();
  });

  socket.on('adminKick', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player || player.role !== 'admin') return reply(callback, { ok: false, message: 'فقط ادمین می‌تواند این کار را انجام دهد.' });
    const target = players.get(String(payload.targetId || ''));
    if (!target || !target.connected || target.id === player.id) return reply(callback, { ok: false, message: 'بازیکن هدف پیدا نشد.' });
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (target.voiceActive) io.to(`floor:${target.floor}`).emit('voicePresence', { playerId: target.id, name: target.name, active: false });
    target.voiceActive = false; target.inPark = false;
    leaveHouseForPlayer(target, 'ادمین بازیکن را از بازی خارج کرد.');
    removeInvitesFor(target.id);
    if (targetSocket) {
      targetSocket.emit('adminNotice', { message: 'ادمین تو را از این دور بازی خارج کرد.' });
      targetSocket.data.playerId = null;
      targetSocket.leave(`floor:${target.floor}`);
    }
    target.connected = false;
    target.socketId = null;
    target.disconnectedAt = Date.now();
    target.reservedUntil = Date.now() + RESERVATION_MS;
    target.lastSeenAt = Date.now();
    reply(callback, { ok: true, message: `${target.name} از بازی خارج شد.` });
    void persistState();
    broadcastState();
  });


  socket.on('houseInvite', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    if (!player) return reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
    const currentRoom = player.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    if (player.houseRoomId && (!currentRoom || currentRoom.playerIds.length >= 4)) return reply(callback, { ok: false, message: 'خانه مشترک پر است؛ حداکثر ۴ نفر می‌توانند وارد شوند.' });
    const target = players.get(String(payload.targetId || ''));
    if (!target || !target.connected || target.floor !== player.floor || target.id === player.id) return reply(callback, { ok: false, message: 'فقط می‌توانی یک بازیکن آنلاین از طبقه خودت را دعوت کنی.' });
    if (target.houseRoomId) return reply(callback, { ok: false, message: 'این بازیکن داخل یک خانه دیگر است.' });
    const inviteId = crypto.randomUUID();
    houseInvites.set(inviteId, { fromId: player.id, toId: target.id, floor: player.floor, roomId: currentRoom?.id || null, createdAt: Date.now() });
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) targetSocket.emit('houseInviteReceived', { inviteId, from: { id: player.id, name: player.name, floor: player.floor }, groupInvite: Boolean(currentRoom) });
    const timer = setTimeout(() => houseInvites.delete(inviteId), HOUSE_INVITE_TTL_MS);
    timer.unref?.();
    reply(callback, { ok: true, message: `دعوت برای ${target.name} فرستاده شد.` });
  });

  socket.on('houseInviteRespond', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const inviteId = String(payload.inviteId || '');
    const invite = houseInvites.get(inviteId);
    if (!player || !invite || invite.toId !== player.id || Date.now() - invite.createdAt > HOUSE_INVITE_TTL_MS) {
      houseInvites.delete(inviteId);
      reply(callback, { ok: false, message: 'این دعوت منقضی شده است.' });
      return;
    }
    houseInvites.delete(inviteId);
    const inviter = players.get(invite.fromId);
    if (!inviter || !inviter.connected || inviter.floor !== player.floor || invite.floor !== player.floor) return reply(callback, { ok: false, message: 'بازیکن دعوت‌کننده دیگر در طبقه شما نیست.' });
    if (!payload.accept) {
      if (inviter.socketId) io.to(inviter.socketId).emit('houseInviteResult', { message: `${player.name} دعوت خانه را نپذیرفت.` });
      return reply(callback, { ok: true, message: 'دعوت رد شد.' });
    }
    if (player.houseRoomId) return reply(callback, { ok: false, message: 'تو همین حالا داخل خانه دیگری هستی.' });
    let room = invite.roomId ? houseRooms.get(invite.roomId) : null;
    if (invite.roomId && (!room || !room.playerIds.includes(inviter.id) || room.playerIds.length >= 4)) return reply(callback, { ok: false, message: 'خانه دعوت‌کننده دیگر ظرفیت ندارد.' });
    if (!invite.roomId) {
      if (inviter.houseRoomId) return reply(callback, { ok: false, message: 'دعوت‌کننده وارد خانه دیگری شده است.' });
      room = { id: crypto.randomUUID(), floor: player.floor, playerIds: [inviter.id], game: null, tableGame: null };
      houseRooms.set(room.id, room);
      inviter.houseRoomId = room.id;
      const inviterSocket = inviter.socketId ? io.sockets.sockets.get(inviter.socketId) : null;
      if (inviterSocket) inviterSocket.join(`house:${room.id}`);
    }
    room.playerIds.push(player.id); player.houseRoomId = room.id;
    socket.join(`house:${room.id}`);
    reply(callback, { ok: true, message: 'وارد خانه سه‌بعدی مشترک شدید!' });
    if (inviter.socketId) io.to(inviter.socketId).emit('houseInviteResult', { message: `${player.name} وارد خانه شد.` });
    emitHouseRoom(room);
  });

  socket.on('houseCabinetPlace', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    const game = CABINET_GAMES[String(payload.gameId || '')];
    if (!player || !room || !game) return reply(callback, { ok: false, message: 'این بازی در کابینت خانه پیدا نشد.' });
    if (room.game && !room.game.ended) return reply(callback, { ok: false, message: 'اول بازی در حال اجرا را تمام کنید.' });
    room.tableGame = { id: String(payload.gameId), ...game };
    room.game = null;
    reply(callback, { ok: true, message: `${game.name} را روی میز گذاشتی.` });
    emitHouseRoom(room);
  });

  socket.on('houseCabinetRemove', (_payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    if (!player || !room) return reply(callback, { ok: false, message: 'داخل خانه نیستی.' });
    if (room.game && !room.game.ended) return reply(callback, { ok: false, message: 'تا پایان بازی نمی‌توانی وسیله را از میز برداری.' });
    room.tableGame = null; room.game = null;
    reply(callback, { ok: true, message: 'بازی را به کابینت برگرداندی.' });
    emitHouseRoom(room);
  });

  socket.on('houseLeave', (_payload, callback) => {
    const player = connectedPlayer(socket);
    if (!player) {
      reply(callback, { ok: false, message: 'ابتدا وارد بازی شو.' });
      return;
    }
    leaveHouseForPlayer(player, `${player.name} از خانه خارج شد.`);
    reply(callback, { ok: true, message: 'از خانه خارج شدی.' });
  });

  socket.on('miniGameStart', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    const gameId = String(payload.gameId || '');
    if (!room || !room.playerIds.includes(player.id)) {
      reply(callback, { ok: false, message: 'برای بازی باید داخل خانه مشترک باشی.' });
      return;
    }
    if (!room.tableGame) {
      reply(callback, { ok: false, message: 'اول از کابینت یک بازی بردار و روی میز بگذار.' });
      return;
    }
    if (room.tableGame.gameId !== gameId) {
      reply(callback, { ok: false, message: 'باید همان بازی‌ای را شروع کنی که روی میز قرار دارد.' });
      return;
    }
    if (!MINI_GAMES[gameId]) {
      reply(callback, { ok: false, message: 'این مینی‌گیم شناخته نشد.' });
      return;
    }
    if (room.game && !room.game.ended) {
      reply(callback, { ok: false, message: 'اول دور فعلی تمام شود.' });
      return;
    }
    room.game = {
      gameId,
      startedAt: Date.now(),
      endsAt: Date.now() + MINI_GAME_DURATION_MS,
      ended: false,
      winnerId: null,
      resultText: '',
      scores: Object.fromEntries(room.playerIds.map((id) => [id, 0])),
      lastActionAt: {},
      puzzleIndex: 0
    };
    const timer = setTimeout(() => finishMiniGame(room), MINI_GAME_DURATION_MS);
    timer.unref?.();
    reply(callback, { ok: true, message: `شروع شد: ${MINI_GAMES[gameId].title}` });
    emitHouseRoom(room);
  });

  socket.on('miniGameAction', (payload = {}, callback) => {
    const player = connectedPlayer(socket);
    const room = player?.houseRoomId ? houseRooms.get(player.houseRoomId) : null;
    const game = room?.game;
    if (!room || !game || game.ended || Date.now() >= game.endsAt || !room.playerIds.includes(player.id)) {
      reply(callback, { ok: false, message: 'الان دور فعالی برای بازی وجود ندارد.' });
      return;
    }
    const now = Date.now();
    if (now - (game.lastActionAt[player.id] || 0) < MINI_GAME_COOLDOWN_MS) {
      reply(callback, { ok: false, message: 'کمی صبر کن و دوباره بزن.' });
      return;
    }
    game.lastActionAt[player.id] = now;
    let message = 'ادامه بده!';
    switch (game.gameId) {
      case 'football':
        if (Math.random() < 0.42) { game.scores[player.id] += 1; message = 'گللل! ⚽'; }
        else message = 'این یکی گل نشد!';
        break;
      case 'pingpong':
        if (Math.random() < 0.55) { game.scores[player.id] += 1; message = 'امتیاز پینگ‌پنگ! 🏓'; }
        else message = 'توپ برگشت خورد؛ دوباره تلاش کن.';
        break;
      case 'race':
        game.scores[player.id] += 1;
        message = 'ماشینت جلو رفت! 🏁';
        break;
      case 'puzzle': {
        const puzzle = PUZZLES[game.puzzleIndex % PUZZLES.length];
        const answerIndex = Number(payload.answerIndex);
        if (Number.isInteger(answerIndex) && answerIndex === puzzle.answerIndex) {
          game.scores[player.id] += 3;
          game.puzzleIndex += 1;
          message = 'پاسخ درست بود! +۳ امتیاز 🧩';
        } else {
          message = 'این جواب درست نبود؛ دوباره فکر کن.';
        }
        break;
      }
      case 'target':
        if (Math.random() < 0.65) { game.scores[player.id] += 1; message = 'به هدف خورد! 🎯'; }
        else message = 'نزدیک بود! یک بار دیگر.';
        break;
      case 'basketball':
        if (Math.random() < 0.52) { game.scores[player.id] += 2; message = 'توپ داخل سبد! +۲ 🏀'; }
        else message = 'توپ به حلقه خورد؛ دوباره پرتاب کن.';
        break;
      case 'record':
        game.scores[player.id] += 1;
        message = 'رکوردت بهتر شد! +۱';
        break;
      default:
        reply(callback, { ok: false, message: 'این بازی هنوز آماده نیست.' });
        return;
    }
    reply(callback, { ok: true, message });
    emitHouseRoom(room);
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    const player = playerId ? players.get(playerId) : null;
    if (player && player.socketId === socket.id) {
      if (player.voiceActive) io.to(`floor:${player.floor}`).emit('voicePresence', { playerId: player.id, name: player.name, active: false });
      player.voiceActive = false; player.inPark = false;
      leaveHouseForPlayer(player, `${player.name} از بازی خارج شد؛ خانه مشترک بسته شد.`);
      removeInvitesFor(player.id);
      const now = Date.now();
      player.connected = false;
      player.socketId = null;
      player.disconnectedAt = now;
      player.reservedUntil = now + RESERVATION_MS;
      player.lastSeenAt = now;
      void persistState();
      broadcastState();
    }
  });
});

setInterval(() => {
  let changed=false;
  for (const player of players.values()) if (player.connected) {
    const old=player.hunger??100; player.hunger=Math.max(0,old-1);
    if(player.hunger===0) player.health=Math.max(1,(player.health??100)-2);
    if(player.hunger!==old) changed=true;
  }
  if(changed) { broadcastState(); void persistState(); }
}, 60_000);

async function start() {
  await loadState();
  server.listen(PORT, HOST, () => {
    console.log(`HOTEL 96 v5.2 is running at http://${HOST}:${PORT}`);
    console.log(`Residents: ${activeResidentCount()}/${MAX_PLAYERS}; accounts: ${players.size}; online: ${onlineCount()}`);
  });
}

const marketTimer = setInterval(() => {
  for (const asset of BANK_ASSETS) {
    const current = bankMarket[asset.id].price;
    const drift = 1 + ((Math.random() - 0.5) * 0.06);
    bankMarket[asset.id].price = Math.max(1, Math.round(current * drift * 100) / 100);
  }
  broadcastState(); void persistState();
}, 60_000);
marketTimer.unref?.();

const cleanupTimer = setInterval(() => {
  pruneExpiredNameOffers();
  if (pruneExpiredPlayers()) {
    void persistState();
    broadcastState();
  } else {
    void persistState();
  }
}, 60_000);
cleanupTimer.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  await persistState();
  if (pool) await pool.end().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

start().catch((error) => {
  console.error('HOTEL96 could not start:', error);
  process.exit(1);
});
