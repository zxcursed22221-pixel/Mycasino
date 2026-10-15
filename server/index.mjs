import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 3001);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEMO_STARTING_BALANCE = 1000;
const MIN_BET = 10;
const MAX_BET = 500;
const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '🍀', '💎', '7️⃣'];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const users = new Map(); // Development-only memory store. It is intentionally not a real-money wallet.

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://telegram.org'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://webk.telegram.org'],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: 'draft-8', legacyHeaders: false }));

function validateTelegramInitData(rawInitData, botToken) {
  if (!rawInitData || !botToken) throw new Error('Не удалось проверить запуск Telegram');
  const params = new URLSearchParams(rawInitData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) throw new Error('Некорректная подпись Telegram');

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  // Telegram Mini Apps signature validation: use "WebAppData" as the HMAC key for the bot token.
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const received = Buffer.from(receivedHash, 'hex');
  if (received.length !== calculatedHash.length || !crypto.timingSafeEqual(received, calculatedHash)) {
    throw new Error('Подпись Telegram не прошла проверку');
  }

  const authDate = Number(params.get('auth_date'));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > nowSeconds + 60 || nowSeconds - authDate > 86_400) {
    throw new Error('Сессия Telegram устарела — откройте приложение заново');
  }
  const userRaw = params.get('user');
  if (!userRaw) throw new Error('В данных запуска нет пользователя Telegram');
  let user;
  try { user = JSON.parse(userRaw); } catch { throw new Error('Данные пользователя Telegram повреждены'); }
  if (!user?.id) throw new Error('Не удалось определить пользователя Telegram');
  return { id: String(user.id), firstName: String(user.first_name || 'Игрок').slice(0, 64) };
}

function getIdentity(req, res, next) {
  const initData = req.get('X-Telegram-Init-Data') || '';
  try {
    if (BOT_TOKEN) {
      req.playerIdentity = validateTelegramInitData(initData, BOT_TOKEN);
    } else if (IS_PRODUCTION) {
      return res.status(503).json({ error: 'Сервер не настроен: требуется BOT_TOKEN для проверки Telegram' });
    } else {
      // Local-browser fallback for development only. Never available in production.
      req.playerIdentity = { id: 'local-demo-player', firstName: 'Демо-игрок' };
    }
    next();
  } catch (error) {
    return res.status(401).json({ error: error.message || 'Не удалось подтвердить Telegram-сессию' });
  }
}

function getOrCreatePlayer(identity) {
  let player = users.get(identity.id);
  if (!player) {
    player = {
      id: identity.id,
      firstName: identity.firstName,
      balance: DEMO_STARTING_BALANCE,
      history: [],
      bonusClaimed: false,
      mines: null,
    };
    users.set(identity.id, player);
  } else {
    player.firstName = identity.firstName;
  }
  return player;
}

function publicHistory(player) {
  return player.history.slice(0, 10).map((round) => ({ ...round }));
}

function addRound(player, round) {
  const savedRound = {
    id: crypto.randomUUID(),
    game: round.game,
    bet: round.bet,
    payout: round.payout,
    net: round.net,
    outcome: round.outcome,
    createdAt: new Date().toISOString(),
    ...(round.number === undefined ? {} : { number: round.number }),
    ...(round.symbols === undefined ? {} : { symbols: round.symbols }),
  };
  player.history.unshift(savedRound);
  player.history = player.history.slice(0, 10);
  return savedRound;
}

function readBet(value) {
  const bet = Number(value);
  if (!Number.isInteger(bet) || bet < MIN_BET || bet > MAX_BET || bet % 10 !== 0) {
    const error = new Error(`Демо-ставка должна быть от ${MIN_BET} до ${MAX_BET} ₽ с шагом 10`);
    error.status = 400;
    throw error;
  }
  return bet;
}

function requireFunds(player, bet) {
  if (player.balance < bet) {
    const error = new Error('Недостаточно демо-₽. Забери бонус или уменьши ставку.');
    error.status = 400;
    throw error;
  }
}

function rouletteColor(number) {
  if (number === 0) return 'green';
  return RED_NUMBERS.has(number) ? 'red' : 'black';
}

function minesMultiplier(mineCount, pickedCount) {
  if (pickedCount <= 0) return 1;
  let probability = 1;
  for (let i = 0; i < pickedCount; i += 1) probability *= (25 - mineCount - i) / (25 - i);
  return Math.floor((0.96 / probability) * 100) / 100;
}

function publicMines(player) {
  if (!player.mines) return null;
  const game = player.mines;
  const multiplier = minesMultiplier(game.mineCount, game.pickedIndices.length);
  return {
    bet: game.bet,
    mineCount: game.mineCount,
    safeCount: game.pickedIndices.length,
    multiplier,
    potentialPayout: Math.floor(game.bet * multiplier),
    pickedIndices: [...game.pickedIndices],
    gameOver: false,
  };
}

function crashPoint() {
  const random = crypto.randomInt(1, 1_000_001) / 1_000_000;
  return Math.min(100, Math.max(1, Math.floor((0.97 / (1 - random)) * 100) / 100));
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: IS_PRODUCTION ? 'production' : 'demo' }));

app.get('/api/me', getIdentity, (req, res) => {
  const player = getOrCreatePlayer(req.playerIdentity);
  res.json({
    user: { id: player.id, firstName: player.firstName },
    balance: player.balance,
    history: publicHistory(player),
    bonusClaimed: player.bonusClaimed,
    minesGame: publicMines(player),
    demo: true,
  });
});

app.post('/api/demo/bonus', getIdentity, (req, res) => {
  if (IS_PRODUCTION) return res.status(404).json({ error: 'Демо-бонус доступен только в режиме разработки' });
  const player = getOrCreatePlayer(req.playerIdentity);
  if (player.bonusClaimed) return res.status(409).json({ error: 'Демо-бонус уже получен в этой сессии' });
  player.balance += 500;
  player.bonusClaimed = true;
  return res.json({ balance: player.balance, bonusClaimed: true });
});

app.post('/api/slots/spin', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    requireFunds(player, bet);
    player.balance -= bet;
    const symbols = Array.from({ length: 3 }, () => SLOT_SYMBOLS[crypto.randomInt(0, SLOT_SYMBOLS.length)]);
    const allSame = symbols.every((symbol) => symbol === symbols[0]);
    const payoutMultipliers = { '7️⃣': 20, '💎': 10, '🔔': 7, '🍀': 5, '🍒': 4, '🍋': 3 };
    let payout = 0;
    if (allSame) payout = bet * payoutMultipliers[symbols[0]];
    else if (symbols[0] === symbols[1] || symbols[1] === symbols[2] || symbols[0] === symbols[2]) payout = Math.floor(bet * 1.5);
    player.balance += payout;
    const net = payout - bet;
    const description = allSame ? `${symbols[0]} ${symbols[0]} ${symbols[0]} · выплата ×${payoutMultipliers[symbols[0]]}` : payout > 0 ? `${symbols.join(' ')} · пара` : symbols.join(' ');
    const round = addRound(player, { game: 'slots', bet, payout, net, outcome: description, symbols });
    return res.json({ balance: player.balance, history: publicHistory(player), round: { ...round, message: net > 0 ? `Выигрыш +${net} кредитов!` : net === 0 ? 'Ставка возвращена' : 'В следующий раз повезёт' } });
  } catch (error) { return next(error); }
});

app.post('/api/roulette/spin', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    const choice = String(req.body?.choice || '');
    if (!['red', 'black', 'zero', 'even', 'odd'].includes(choice)) {
      const error = new Error('Выберите красное, чёрное, зеро, чётное или нечётное');
      error.status = 400;
      throw error;
    }
    requireFunds(player, bet);
    player.balance -= bet;
    const number = crypto.randomInt(0, 37);
    const color = rouletteColor(number);
    const winning = choice === 'zero' ? number === 0 : choice === 'red' || choice === 'black' ? color === choice : number !== 0 && (choice === 'even' ? number % 2 === 0 : number % 2 === 1);
    const payout = winning ? bet * (choice === 'zero' ? 36 : 2) : 0;
    player.balance += payout;
    const net = payout - bet;
    const outcome = `${number} · ${color === 'red' ? 'красное' : color === 'black' ? 'чёрное' : 'зелёное'}`;
    const round = addRound(player, { game: 'roulette', bet, payout, net, outcome, number });
    return res.json({ balance: player.balance, history: publicHistory(player), round: { ...round, message: net > 0 ? `Попадание! +${net} кредитов` : 'Не в этот раз' } });
  } catch (error) { return next(error); }
});

app.post('/api/crash/play', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    const cashoutAt = Number(req.body?.cashoutAt);
    if (!Number.isFinite(cashoutAt) || cashoutAt < 1.1 || cashoutAt > 5 || Math.round(cashoutAt * 10) !== cashoutAt * 10) {
      const error = new Error('Автовыход должен быть от 1,1× до 5,0× с шагом 0,1'); error.status = 400; throw error;
    }
    requireFunds(player, bet);
    const bustedAt = crashPoint();
    const won = bustedAt > cashoutAt;
    const payout = won ? Math.floor(bet * cashoutAt) : 0;
    player.balance -= bet;
    player.balance += payout;
    const net = payout - bet;
    const outcome = won ? `Автовыход ${cashoutAt.toFixed(2)}× · краш ${bustedAt.toFixed(2)}×` : `Краш на ${bustedAt.toFixed(2)}×`;
    const round = addRound(player, { game: 'crash', bet, payout, net, outcome });
    return res.json({ balance: player.balance, history: publicHistory(player), round: {
      ...round, won, cashoutAt, crashAt: bustedAt,
      message: won ? `Успел забрать на ${cashoutAt.toFixed(2)}× · ${payout.toLocaleString('ru-RU')} демо-₽` : `Краш на ${bustedAt.toFixed(2)}× — в следующий раз повезёт`,
    } });
  } catch (error) { return next(error); }
});

app.post('/api/dice/play', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    const target = Number(req.body?.target);
    const side = String(req.body?.side || 'over');
    if (!Number.isInteger(target) || target < 10 || target > 90 || !['over', 'under'].includes(side)) {
      const error = new Error('Выбери порог от 10 до 90 и направление'); error.status = 400; throw error;
    }
    requireFunds(player, bet);
    const roll = crypto.randomInt(0, 100);
    const wins = side === 'over' ? roll > target : roll < target;
    const winChance = side === 'over' ? 99 - target : target;
    const multiplier = Math.floor((0.96 * 100 / winChance) * 100) / 100;
    const payout = wins ? Math.floor(bet * multiplier) : 0;
    player.balance -= bet;
    player.balance += payout;
    const net = payout - bet;
    const outcome = `Выпало ${String(roll).padStart(2, '0')} · ${side === 'over' ? 'больше' : 'меньше'} ${target}`;
    const round = addRound(player, { game: 'dice', bet, payout, net, outcome, number: roll });
    return res.json({ balance: player.balance, history: publicHistory(player), round: {
      ...round, roll, target, side, multiplier,
      message: wins ? `Попал! Выплата ${payout.toLocaleString('ru-RU')} демо-₽ · ×${multiplier.toFixed(2)}` : `Выпало ${String(roll).padStart(2, '0')} — мимо`,
    } });
  } catch (error) { return next(error); }
});

app.post('/api/coinflip/play', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    const choice = String(req.body?.choice || 'heads');
    if (!['heads', 'tails'].includes(choice)) {
      const error = new Error('Выбери орла или решку'); error.status = 400; throw error;
    }
    requireFunds(player, bet);
    const result = crypto.randomInt(0, 2) === 0 ? 'heads' : 'tails';
    const won = result === choice;
    const payout = won ? Math.floor(bet * 1.95) : 0;
    player.balance -= bet;
    player.balance += payout;
    const net = payout - bet;
    const outcome = `Выпала ${result === 'heads' ? 'орёл' : 'решка'} · ставка на ${choice === 'heads' ? 'орла' : 'решку'}`;
    const round = addRound(player, { game: 'coinflip', bet, payout, net, outcome });
    return res.json({ balance: player.balance, history: publicHistory(player), round: {
      ...round, result, won,
      message: won ? `Угадал сторону · выплата ${payout.toLocaleString('ru-RU')} демо-₽` : `Выпала ${result === 'heads' ? 'орёл' : 'решка'} — не совпало`,
    } });
  } catch (error) { return next(error); }
});

app.post('/api/mines/start', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const bet = readBet(req.body?.bet);
    const mineCount = Number(req.body?.mines ?? 3);
    if (![3, 5, 8].includes(mineCount)) {
      const error = new Error('Количество мин: 3, 5 или 8'); error.status = 400; throw error;
    }
    if (player.mines) {
      const error = new Error('Сначала закончи текущий раунд Mines'); error.status = 409; throw error;
    }
    requireFunds(player, bet);
    const minePositions = new Set();
    while (minePositions.size < mineCount) minePositions.add(crypto.randomInt(0, 25));
    player.balance -= bet;
    player.mines = { bet, mineCount, minePositions, pickedIndices: [] };
    return res.json({ balance: player.balance, minesGame: publicMines(player), message: 'Поле готово. Выбери первую клетку.' });
  } catch (error) { return next(error); }
});

app.post('/api/mines/pick', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const game = player.mines;
    if (!game) { const error = new Error('Сначала начни раунд Mines'); error.status = 409; throw error; }
    const index = Number(req.body?.index);
    if (!Number.isInteger(index) || index < 0 || index > 24) { const error = new Error('Некорректная клетка'); error.status = 400; throw error; }
    if (game.pickedIndices.includes(index)) { const error = new Error('Эта клетка уже открыта'); error.status = 409; throw error; }
    if (game.minePositions.has(index)) {
      const revealedIndices = [...game.minePositions];
      const round = addRound(player, { game: 'mines', bet: game.bet, payout: 0, net: -game.bet, outcome: `Мина найдена · безопасных клеток: ${game.pickedIndices.length}` });
      player.mines = null;
      return res.json({ balance: player.balance, history: publicHistory(player), minesGame: { gameOver: true, revealedIndices }, round: { ...round, message: `Бум! Потеряно ${game.bet.toLocaleString('ru-RU')} демо-₽` } });
    }
    game.pickedIndices.push(index);
    const multiplier = minesMultiplier(game.mineCount, game.pickedIndices.length);
    return res.json({ balance: player.balance, minesGame: publicMines(player), message: `Безопасно! Сейчас ${multiplier.toFixed(2)}× · можешь продолжить или забрать приз.` });
  } catch (error) { return next(error); }
});

app.post('/api/mines/cashout', getIdentity, (req, res, next) => {
  try {
    const player = getOrCreatePlayer(req.playerIdentity);
    const game = player.mines;
    if (!game) { const error = new Error('Нет активного раунда Mines'); error.status = 409; throw error; }
    if (!game.pickedIndices.length) { const error = new Error('Открой хотя бы одну безопасную клетку перед выводом приза'); error.status = 400; throw error; }
    const multiplier = minesMultiplier(game.mineCount, game.pickedIndices.length);
    const payout = Math.floor(game.bet * multiplier);
    player.balance += payout;
    const net = payout - game.bet;
    const outcome = `Забрал на ${multiplier.toFixed(2)}× · клеток: ${game.pickedIndices.length}`;
    const round = addRound(player, { game: 'mines', bet: game.bet, payout, net, outcome });
    player.mines = null;
    return res.json({ balance: player.balance, history: publicHistory(player), minesGame: null, round: { ...round, message: `Приз забран: ${payout.toLocaleString('ru-RU')} демо-₽` } });
  } catch (error) { return next(error); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint не найден' }));

const distDir = path.join(rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.status(200).send('NIGHT CLUB API is running. Start the Vite client with `npm run dev`.'));
}

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : error.message });
});

app.listen(PORT, () => {
  console.log(`NIGHT CLUB API listening on http://localhost:${PORT} (${IS_PRODUCTION ? 'production' : 'demo mode'})`);
  if (!BOT_TOKEN) console.log('BOT_TOKEN is not set: local demo identity enabled only outside production.');
});
