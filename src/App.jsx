import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const tg = window.Telegram?.WebApp;
const MIN_BET = 10;
const MAX_BET = 500;
const BET_STEP = 10;
const SYMBOLS = ['ruby', 'lemon', 'bell', 'clover', 'gem', 'seven'];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const GAME_LIST = [
  { id: 'slots', title: 'Midnight Slots', subtitle: 'Классические барабаны', tag: 'CLASSIC' },
  { id: 'roulette', title: 'Roulette Noir', subtitle: 'Европейская рулетка', tag: 'TABLE' },
  { id: 'crash', title: 'Neon Crash', subtitle: 'Успей забрать выигрыш', tag: 'FEATURED' },
  { id: 'dice', title: 'Dice Protocol', subtitle: 'Выше или ниже числа', tag: 'QUICK PLAY' },
  { id: 'coinflip', title: 'Double Flip', subtitle: 'Орёл или решка', tag: '50 / 50' },
  { id: 'mines', title: 'Gem Hunt', subtitle: 'Открывай безопасные клетки', tag: 'STRATEGY' },
];
const LEGACY_SYMBOLS = { '🍒': 'ruby', '🍋': 'lemon', '🔔': 'bell', '🍀': 'clover', '💎': 'gem', '7️⃣': 'seven' };
const normalizeSlotSymbol = (symbol) => LEGACY_SYMBOLS[symbol] || symbol || 'gem';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': tg?.initData || '',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос');
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatNumber = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value ?? 0);
const formatDemoRub = (value) => `${formatNumber(value)} ₽`;

function App() {
  const [view, setView] = useState('slots');
  const [balance, setBalance] = useState(1000);
  const [player, setPlayer] = useState({ firstName: 'Игрок' });
  const [history, setHistory] = useState([]);
  const [bet, setBet] = useState(50);
  const [reels, setReels] = useState(['ruby', 'gem', 'seven']);
  const [rouletteNumber, setRouletteNumber] = useState(null);
  const [message, setMessage] = useState('Выбери игру и испытай удачу');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bonusClaimed, setBonusClaimed] = useState(false);
  const [error, setError] = useState('');
  const [lastNet, setLastNet] = useState(null);
  const [crashVisual, setCrashVisual] = useState(1);
  const [crashTarget, setCrashTarget] = useState(2);
  const [diceTarget, setDiceTarget] = useState(50);
  const [diceSide, setDiceSide] = useState('over');
  const [diceVisual, setDiceVisual] = useState(50);
  const [coinSide, setCoinSide] = useState('heads');
  const [coinVisual, setCoinVisual] = useState('О');
  const [mineCount, setMineCount] = useState(3);
  const [minesGame, setMinesGame] = useState(null);
  const [mineReveal, setMineReveal] = useState([]);
  const [rouletteSpinning, setRouletteSpinning] = useState(false);
  const [roundCount, setRoundCount] = useState(0);
  const slotsTimer = useRef(null);
  const diceTimer = useRef(null);

  const loadMe = useCallback(async () => {
    try {
      const data = await api('/api/me');
      setBalance(data.balance);
      setPlayer(data.user || { firstName: 'Игрок' });
      setHistory(data.history || []);
      setBonusClaimed(Boolean(data.bonusClaimed));
      setMinesGame(data.minesGame || null);
      if (data.minesGame?.pickedIndices) setMineReveal(data.minesGame.pickedIndices);
      setError('');
    } catch (err) {
      setError(err.message || 'Сервер недоступен');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    tg?.ready?.();
    tg?.expand?.();
    tg?.setHeaderColor?.('#0a0d12');
    tg?.setBackgroundColor?.('#0a0d12');
    loadMe();
    return () => {
      if (slotsTimer.current) clearInterval(slotsTimer.current);
      if (diceTimer.current) clearInterval(diceTimer.current);
    };
  }, [loadMe]);

  const selectedGame = useMemo(() => GAME_LIST.find((game) => game.id === view) || GAME_LIST[0], [view]);
  const rouletteColor = useMemo(() => {
    if (rouletteNumber === null) return 'ОЖИДАЕМ РАУНД';
    if (rouletteNumber === 0) return 'ЗЕЛЁНОЕ';
    return RED_NUMBERS.has(rouletteNumber) ? 'КРАСНОЕ' : 'ЧЁРНОЕ';
  }, [rouletteNumber]);

  const updateRound = (data) => {
    if (typeof data.balance === 'number') setBalance(data.balance);
    if (data.history) setHistory(data.history);
    if (data.round) {
      setLastNet(data.round.net ?? null);
      setMessage(data.round.message || data.round.outcome || 'Раунд завершён');
      setRoundCount((count) => count + 1);
      tg?.HapticFeedback?.notificationOccurred?.(data.round.net > 0 ? 'success' : 'warning');
    }
  };

  const doRound = async (path, payload, wait = 450, beforeMessage = 'Раунд запущен…', after) => {
    if (busy) return null;
    setBusy(true);
    setMessage(beforeMessage);
    setLastNet(null);
    setError('');
    tg?.HapticFeedback?.impactOccurred?.('medium');
    try {
      const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
      if (wait) await sleep(wait);
      after?.(data);
      if (data.message && !data.round) setMessage(data.message);
      updateRound(data);
      return data;
    } catch (err) {
      setError(err.message || 'Не удалось завершить раунд');
      setMessage('Раунд не принят');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const spinSlots = async () => {
    if (busy || loading || balance < bet) return;
    setBusy(true);
    setMessage('Барабаны набирают скорость…');
    setLastNet(null);
    setError('');
    tg?.HapticFeedback?.impactOccurred?.('medium');
    slotsTimer.current = setInterval(() => {
      setReels(Array.from({ length: 3 }, () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]));
    }, 75);
    try {
      const data = await api('/api/slots/spin', { method: 'POST', body: JSON.stringify({ bet }) });
      await sleep(900);
      clearInterval(slotsTimer.current);
      slotsTimer.current = null;
      setReels(data.round.symbols.map(normalizeSlotSymbol));
      updateRound(data);
    } catch (err) {
      clearInterval(slotsTimer.current);
      slotsTimer.current = null;
      setError(err.message);
      setMessage('Ставка не принята');
    } finally {
      setBusy(false);
    }
  };

  const spinRoulette = async (choice) => {
    setRouletteSpinning(true);
    await doRound('/api/roulette/spin', { bet, choice }, 1150, 'Колесо вращается…', (data) => setRouletteNumber(data.round.number));
    setRouletteSpinning(false);
  };

  const playCrash = async () => {
    if (busy || loading || balance < bet) return;
    setCrashVisual(1);
    const dataPromise = api('/api/crash/play', { method: 'POST', body: JSON.stringify({ bet, cashoutAt: crashTarget }) });
    setBusy(true); setLastNet(null); setError(''); setMessage('Множитель растёт…');
    tg?.HapticFeedback?.impactOccurred?.('medium');
    try {
      const data = await dataPromise;
      const endAt = data.round.won ? data.round.cashoutAt : data.round.crashAt;
      const duration = 1600;
      const start = performance.now();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          const progress = Math.min(1, (performance.now() - start) / duration);
          const value = Math.exp(Math.log(Math.max(1.01, endAt)) * progress);
          setCrashVisual(Math.min(endAt, value));
          if (progress >= 1) { clearInterval(timer); resolve(); }
        }, 30);
      });
      updateRound(data);
    } catch (err) {
      setError(err.message); setMessage('Раунд не принят');
    } finally {
      setBusy(false);
    }
  };

  const playDice = async () => {
    if (busy || loading || balance < bet) return;
    setBusy(true); setLastNet(null); setError(''); setMessage('Кости бросаются…');
    const animation = setInterval(() => setDiceVisual(Math.floor(Math.random() * 100)), 60);
    diceTimer.current = animation;
    try {
      const data = await api('/api/dice/play', { method: 'POST', body: JSON.stringify({ bet, target: diceTarget, side: diceSide }) });
      await sleep(700);
      clearInterval(animation); diceTimer.current = null;
      setDiceVisual(data.round.roll);
      updateRound(data);
    } catch (err) {
      clearInterval(animation); diceTimer.current = null;
      setError(err.message); setMessage('Раунд не принят');
    } finally { setBusy(false); }
  };

  const playCoinflip = async () => {
    const data = await doRound('/api/coinflip/play', { bet, choice: coinSide }, 800, 'Монета в воздухе…', (response) => setCoinVisual(response.round.result === 'heads' ? 'О' : 'Р'));
    if (data) setCoinVisual(data.round.result === 'heads' ? 'О' : 'Р');
  };

  const startMines = async () => {
    if (busy || loading || balance < bet) return;
    const data = await doRound('/api/mines/start', { bet, mines: mineCount }, 350, 'Подготавливаем поле…');
    if (data) { setMinesGame(data.minesGame); setMineReveal([]); setMineCount(data.minesGame.mineCount); }
  };

  const pickMineCell = async (index) => {
    if (busy || !minesGame || mineReveal.includes(index) || minesGame.gameOver) return;
    const data = await doRound('/api/mines/pick', { index }, 300, 'Проверяем клетку…');
    if (!data) return;
    if (data.minesGame?.gameOver) {
      setMineReveal(data.minesGame.revealedIndices || [...mineReveal, index]);
      setMinesGame(null);
    } else {
      setMinesGame(data.minesGame);
      setMineReveal(data.minesGame.pickedIndices || [...mineReveal, index]);
    }
  };

  const cashoutMines = async () => {
    const data = await doRound('/api/mines/cashout', {}, 350, 'Забираем выигрыш…');
    if (data) { setMinesGame(null); setMineReveal(data.minesGame?.revealedIndices || mineReveal); }
  };

  const claimBonus = async () => {
    try {
      const data = await api('/api/demo/bonus', { method: 'POST', body: JSON.stringify({}) });
      setBalance(data.balance); setBonusClaimed(true); setMessage('Демо-бонус начислен'); setError('');
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch (err) { setError(err.message); }
  };

  const adjustBet = (delta) => setBet((current) => Math.min(MAX_BET, Math.max(MIN_BET, current + delta)));
function Icon({ name }) {
  const path = {
    play: <path d="m9 6 10 6-10 6z" fill="currentColor" stroke="none" />,
    arrow: <><path d="M4 12h15"/><path d="m13 5 7 7-7 7"/></>,
    wallet: <><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 9h18M16 14h.01" strokeWidth="2.5"/></>,
    gift: <><path d="M3 10h18v11H3zM2 6h20v4H2zM12 6v15M12 6H8.5a2.5 2.5 0 1 1 2.2-3.7L12 4l1.3-1.7A2.5 2.5 0 1 1 15.5 6Z"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
    spark: <><path d="m12 2 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    up: <><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>,
  }[name];
  return <svg className={`ui-icon icon-${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path || <path d="m12 2 2 7 7 3-7 2-2 8-2-8-7-2 7-3 2-7Z"/>}</svg>;
}

function BrandCrown() {
  return <svg className="crown-svg" viewBox="0 0 56 44" fill="none" aria-hidden="true"><path d="M7 13 17 22 27 7 37 22 49 11 45 34H11L7 13Z" fill="url(#nc-gold)" stroke="#f7dda0" strokeWidth="1.5" strokeLinejoin="round"/><path d="M12 29h33M15 38h30" stroke="#936229" strokeWidth="1.5" strokeLinecap="round"/><circle cx="7" cy="12" r="3" fill="#ffe6a8"/><circle cx="27" cy="6" r="3" fill="#ffe6a8"/><circle cx="49" cy="10" r="3" fill="#ffe6a8"/><defs><linearGradient id="nc-gold" x1="10" y1="8" x2="45" y2="35" gradientUnits="userSpaceOnUse"><stop stopColor="#fff2c5"/><stop offset=".36" stopColor="#e8bd65"/><stop offset=".72" stopColor="#98602a"/><stop offset="1" stopColor="#f8db91"/></linearGradient></defs></svg>;
}

function GameArt({ type, className = '' }) {
  const props = { className: `game-art art-${type} ${className}`, viewBox: '0 0 160 160', fill: 'none', 'aria-hidden': true };
  if (type === 'slots') return <svg {...props}><defs><linearGradient id="machine-gold" x1="20" y1="15" x2="138" y2="142"><stop stopColor="#fff0ba"/><stop offset=".23" stopColor="#b37a36"/><stop offset=".5" stopColor="#3f2325"/><stop offset=".78" stopColor="#b7803b"/><stop offset="1" stopColor="#ffeab0"/></linearGradient><linearGradient id="machine-screen" x1="30" y1="35" x2="120" y2="125"><stop stopColor="#512530"/><stop offset="1" stopColor="#101520"/></linearGradient></defs><ellipse cx="81" cy="139" rx="47" ry="9" fill="#e8a84c" opacity=".18"/><g className="art-object"><path d="M29 40 43 21h76l13 19v88l-14 14H43l-14-14V40Z" fill="#0a0d14" stroke="url(#machine-gold)" strokeWidth="4"/><path d="M37 42 49 29h66l9 13v80l-10 10H47l-10-10V42Z" fill="url(#machine-screen)" stroke="#e5bd72"/><rect x="43" y="49" width="74" height="55" rx="7" fill="#05080d" stroke="#ad8144" strokeWidth="2"/><g fill="#171f2b" stroke="#6d4c38"><rect x="48" y="54" width="20" height="45" rx="3"/><rect x="70" y="54" width="20" height="45" rx="3"/><rect x="92" y="54" width="20" height="45" rx="3"/></g><g fill="url(#slot-red)" stroke="#ffe2a0" strokeWidth=".7" fontSize="31" fontWeight="900" fontFamily="Georgia,serif"><text x="48" y="86">7</text><text x="70" y="86">7</text><text x="92" y="86">7</text></g><defs><linearGradient id="slot-red" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fff0bd"/><stop offset=".32" stopColor="#ffbd57"/><stop offset=".65" stopColor="#e6543a"/><stop offset="1" stopColor="#8a2634"/></linearGradient></defs><path d="M49 113h64" stroke="#f2d28b" strokeWidth="2" strokeLinecap="round"/><circle cx="81" cy="123" r="5" fill="#e9bf67" stroke="#fff0b7"/><path d="M44 17 49 10h66l5 7" stroke="#fff1c0" strokeWidth="2" strokeLinecap="round"/></g></svg>;
  if (type === 'roulette') return <svg {...props}><defs><radialGradient id="wheel-gold"><stop stopColor="#fff0b7"/><stop offset=".31" stopColor="#d7a54d"/><stop offset=".62" stopColor="#76501f"/><stop offset=".9" stopColor="#e9c16e"/><stop offset="1" stopColor="#3b2515"/></radialGradient><radialGradient id="wheel-green"><stop stopColor="#1d3a31"/><stop offset="1" stopColor="#060c10"/></radialGradient></defs><ellipse cx="80" cy="137" rx="58" ry="10" fill="#d3a452" opacity=".18"/><g className="art-object"><circle cx="80" cy="78" r="64" fill="#070a10" stroke="url(#wheel-gold)" strokeWidth="5"/><circle cx="80" cy="78" r="56" fill="url(#wheel-green)" stroke="#d0a85f" strokeWidth="2"/><circle cx="80" cy="78" r="48" fill="#141a1c" stroke="#8f6a35" strokeWidth="2"/><circle cx="80" cy="78" r="43" fill="none" stroke="#d0a557" strokeWidth="14" strokeDasharray="7.2 .02"/><circle cx="80" cy="78" r="33" fill="#08100f" stroke="#9d763e" strokeWidth="2"/><circle cx="80" cy="78" r="25" fill="url(#wheel-gold)"/><circle cx="80" cy="78" r="16" fill="#15171c" stroke="#f6d791" strokeWidth="1.5"/><path d="M80 62 84 74 96 78 84 82 80 94 76 82 64 78 76 74Z" fill="#ffe6a0"/><circle cx="80" cy="78" r="5" fill="#fff2bd"/><path d="M80 13 85 24h-10l5-11Z" fill="#fff0b5"/><path d="M35 31a59 59 0 0 1 81-1" stroke="#fff3d3" strokeWidth="1.5" opacity=".5"/></g></svg>;
  if (type === 'crash') return <svg {...props}><defs><linearGradient id="rocket-metal" x1="40" y1="20" x2="115" y2="130"><stop stopColor="#fff4d2"/><stop offset=".3" stopColor="#b5c4d7"/><stop offset=".65" stopColor="#536a90"/><stop offset="1" stopColor="#17273c"/></linearGradient><linearGradient id="rocket-fire" x1="75" y1="78" x2="76" y2="151"><stop stopColor="#fff5a9"/><stop offset=".5" stopColor="#ff9f4e"/><stop offset="1" stopColor="#ff4b61" stopOpacity="0"/></linearGradient></defs><circle cx="83" cy="79" r="69" fill="#bd7dff" opacity=".08"/><path d="M18 122c33-11 34-37 66-40s35-20 62-46" stroke="#5ec7ff" strokeWidth="2" strokeDasharray="3 8" opacity=".6"/><g className="art-object" transform="rotate(38 80 80)"><path d="M69 99c0 18-10 27-15 35 16-4 25-9 31-23L69 99Z" fill="url(#rocket-fire)"/><path d="M66 70c7-21 21-39 38-51 9 25 7 47-8 65L66 70Z" fill="url(#rocket-metal)" stroke="#fff0cb" strokeWidth="1.5"/><path d="m66 70-16 10c-7 5-9 13-9 20l26-7m29-9 4 20c2 8 8 13 14 16l1-30" fill="#c34d5d" stroke="#f3c984" strokeWidth="1.5"/><circle cx="84" cy="65" r="9" fill="#132a43" stroke="#f5dda4" strokeWidth="2"/><circle cx="84" cy="65" r="4.5" fill="#5cd0ff"/><path d="M75 78 95 59" stroke="#fff" strokeWidth="2" opacity=".8"/></g></svg>;
  if (type === 'dice') return <svg {...props}><defs><linearGradient id="dice-top" x1="30" y1="30" x2="103" y2="80"><stop stopColor="#fff8e3"/><stop offset=".5" stopColor="#d0d8e4"/><stop offset="1" stopColor="#8d9ab2"/></linearGradient><linearGradient id="dice-side" x1="25" y1="55" x2="70" y2="125"><stop stopColor="#bdc9d8"/><stop offset="1" stopColor="#46516d"/></linearGradient></defs><ellipse cx="80" cy="135" rx="49" ry="10" fill="#87aaff" opacity=".18"/><g className="art-object" transform="rotate(-9 80 80)"><path d="M24 57 61 35 104 54 65 77Z" fill="url(#dice-top)" stroke="#fff3d9" strokeWidth="1.5"/><path d="M24 57 65 77V121L24 99Z" fill="url(#dice-side)" stroke="#d7e3f2" strokeWidth="1.3"/><path d="M65 77 104 54V99L65 121Z" fill="#7f8ca2" stroke="#d7e3f2" strokeWidth="1.3"/><g fill="#1a273f"><circle cx="42" cy="53" r="3.5"/><circle cx="54" cy="60" r="3.5"/><circle cx="65" cy="45" r="3.5"/><circle cx="82" cy="48" r="3.5"/><circle cx="91" cy="57" r="3.5"/><circle cx="42" cy="75" r="3.5"/><circle cx="42" cy="89" r="3.5"/><circle cx="52" cy="97" r="3.5"/><circle cx="76" cy="88" r="3.5"/><circle cx="90" cy="77" r="3.5"/></g><path d="M33 59 57 73M73 80l26-18" stroke="#fff" strokeWidth="1.6" opacity=".45"/></g><g className="art-object" transform="translate(45 16) rotate(10 50 55)"><path d="M21 60 49 43 80 59 50 77Z" fill="#f8dca0" stroke="#fff0cf" strokeWidth="1.3"/><path d="M21 60 50 77v31L21 92Z" fill="#92734c" stroke="#f2d39b"/><path d="M50 77 80 59v33L50 108Z" fill="#4f3a2f" stroke="#d0a66d"/><g fill="#201a20"><circle cx="36" cy="60" r="3"/><circle cx="48" cy="68" r="3"/><circle cx="59" cy="62" r="3"/><circle cx="31" cy="75" r="3"/><circle cx="31" cy="85" r="3"/><circle cx="62" cy="84" r="3"/></g></g></svg>;
  if (type === 'coinflip') return <svg {...props}><defs><linearGradient id="coin-metal" x1="30" y1="20" x2="125" y2="135"><stop stopColor="#fff2c1"/><stop offset=".22" stopColor="#f0c46a"/><stop offset=".52" stopColor="#946025"/><stop offset=".82" stopColor="#eec66e"/><stop offset="1" stopColor="#6b411d"/></linearGradient></defs><ellipse cx="80" cy="137" rx="44" ry="9" fill="#e2a949" opacity=".2"/><g className="art-object" transform="rotate(-13 80 78)"><ellipse cx="80" cy="82" rx="53" ry="57" fill="#563619" stroke="url(#coin-metal)" strokeWidth="6"/><ellipse cx="80" cy="77" rx="50" ry="55" fill="url(#coin-metal)" stroke="#fff0b5" strokeWidth="2"/><ellipse cx="80" cy="77" rx="41" ry="46" fill="none" stroke="#87531f" strokeWidth="2.5"/><ellipse cx="80" cy="77" rx="35" ry="40" fill="none" stroke="#fff0ba" strokeWidth="1.2"/><path d="M80 48 87 65 105 69 91 81 94 99 80 89 66 99 69 81 55 69 73 65Z" fill="#fff0b6"/><circle cx="80" cy="76" r="10" fill="#8e5b24"/><circle cx="80" cy="76" r="6" fill="#ffe6a0"/><path d="M43 43c9-10 19-14 31-17" stroke="#fff" strokeWidth="2.5" opacity=".7" strokeLinecap="round"/></g></svg>;
  return <svg {...props}><defs><linearGradient id="gem-green" x1="30" y1="25" x2="120" y2="125"><stop stopColor="#caffed"/><stop offset=".22" stopColor="#4af0b4"/><stop offset=".7" stopColor="#137b62"/><stop offset="1" stopColor="#063a36"/></linearGradient><linearGradient id="mine-panel" x1="25" y1="20" x2="130" y2="135"><stop stopColor="#214640"/><stop offset="1" stopColor="#0b171e"/></linearGradient></defs><circle cx="80" cy="80" r="60" fill="#2ce2aa" opacity=".08"/><g className="art-object" transform="translate(20 23)"><rect width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#4a8473"/><rect x="42" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect x="84" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect y="42" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect x="42" y="42" width="35" height="35" rx="7" fill="#153c32" stroke="#69f6c3" strokeWidth="1.5"/><rect x="84" y="42" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect y="84" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect x="42" y="84" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><rect x="84" y="84" width="35" height="35" rx="7" fill="url(#mine-panel)" stroke="#305e55"/><path d="m60 48 12 9-4 15H54l-6-14 12-10Z" fill="url(#gem-green)" stroke="#b7ffdf" strokeWidth="1.5"/><path d="m60 48-1 24m13-15H48" stroke="#e1fff1" opacity=".8"/></g></svg>;
}

function SlotSymbol({ kind = 'gem' }) {
  const safe = normalizeSlotSymbol(kind);
  if (safe === 'seven') return <span className="slot-symbol slot-seven">7</span>;
  if (safe === 'ruby') return <svg className="slot-symbol" viewBox="0 0 60 60" aria-hidden="true"><defs><linearGradient id="sym-ruby" x1="8" y1="8" x2="48" y2="51"><stop stopColor="#ffc0a6"/><stop offset=".4" stopColor="#ec4d5c"/><stop offset="1" stopColor="#711b38"/></linearGradient></defs><circle cx="22" cy="36" r="13" fill="url(#sym-ruby)" stroke="#ffc1ac"/><circle cx="40" cy="35" r="13" fill="url(#sym-ruby)" stroke="#ffc1ac"/><path d="M22 23c0-8 6-13 13-14M40 22c-1-8 2-11 7-13M27 14c7-5 12-3 16 1" stroke="#83d58f" strokeWidth="3" strokeLinecap="round"/></svg>;
  if (safe === 'lemon') return <svg className="slot-symbol" viewBox="0 0 60 60" aria-hidden="true"><defs><linearGradient id="sym-lemon" x1="10" y1="15" x2="49" y2="46"><stop stopColor="#fff3a0"/><stop offset=".5" stopColor="#f7c94c"/><stop offset="1" stopColor="#bf7d23"/></linearGradient></defs><path d="M10 31C17 12 38 11 48 28 39 48 19 51 10 31Z" fill="url(#sym-lemon)" stroke="#fff0ae"/><path d="M16 29c8-10 19-11 28-3" stroke="#fff" strokeWidth="2" opacity=".6" strokeLinecap="round"/></svg>;
  if (safe === 'bell') return <svg className="slot-symbol" viewBox="0 0 60 60" aria-hidden="true"><defs><linearGradient id="sym-bell" x1="15" y1="9" x2="45" y2="52"><stop stopColor="#fff3bd"/><stop offset=".35" stopColor="#e7b65b"/><stop offset="1" stopColor="#955b25"/></linearGradient></defs><path d="M15 40c4-5 4-11 4-18a11 11 0 0 1 22 0c0 7 0 13 4 18H15Z" fill="url(#sym-bell)" stroke="#fff0b8"/><path d="M12 41h36v5H12z" fill="#bb7b2c" stroke="#f5d38b"/><circle cx="30" cy="49" r="4.5" fill="#e8ba61" stroke="#fff0b8"/></svg>;
  if (safe === 'clover') return <svg className="slot-symbol" viewBox="0 0 60 60" aria-hidden="true"><defs><linearGradient id="sym-clover" x1="8" y1="9" x2="43" y2="49"><stop stopColor="#c7ffd6"/><stop offset=".42" stopColor="#53d783"/><stop offset="1" stopColor="#147348"/></linearGradient></defs><g fill="url(#sym-clover)" stroke="#bdffd0"><circle cx="22" cy="20" r="10"/><circle cx="38" cy="20" r="10"/><circle cx="22" cy="35" r="10"/><circle cx="38" cy="35" r="10"/></g><path d="M31 29 28 50l9-9" fill="#58be75" stroke="#b9ffcb" strokeWidth="2"/></svg>;
  return <svg className="slot-symbol" viewBox="0 0 60 60" aria-hidden="true"><defs><linearGradient id="sym-gem" x1="9" y1="9" x2="48" y2="52"><stop stopColor="#d0fcff"/><stop offset=".32" stopColor="#70d8f6"/><stop offset=".68" stopColor="#5079dd"/><stop offset="1" stopColor="#292e89"/></linearGradient></defs><path d="M15 14h30l9 13-24 26L6 27l9-13Z" fill="url(#sym-gem)" stroke="#d1fbff" strokeWidth="1.5"/><path d="M15 14 21 27h18l6-13M21 27l9 26 9-26M6 27h48" fill="none" stroke="#e4fdff" strokeWidth="1.4" opacity=".75"/></svg>;
}
function MineGlyph() { return <svg className="mine-glyph" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="8" fill="#d85761" stroke="#ffadb3" strokeWidth="1.5"/><path d="m16 2v5m0 18v5M2 16h5m18 0h5M6 6l4 4m12 12 4 4M26 6l-4 4M10 22l-4 4" stroke="#fa8790" strokeWidth="2" strokeLinecap="round"/><circle cx="13" cy="13" r="2" fill="#ffe4df"/></svg>; }

  const disabled = busy || loading || balance < bet;
  const betControls = <div className="bet-row"><div className="bet-label"><span>РАЗМЕР СТАВКИ</span><small>Только тестовые кредиты</small></div><div className="bet-control"><button onClick={() => adjustBet(-BET_STEP)} disabled={busy || bet <= MIN_BET} aria-label="Уменьшить ставку">−</button><strong>{formatNumber(bet)} <span>₽</span></strong><button onClick={() => adjustBet(BET_STEP)} disabled={busy || bet >= MAX_BET} aria-label="Увеличить ставку">＋</button></div></div>;
  const actionButton = (label, onClick, isDisabled = disabled) => <button className="primary-action" onClick={onClick} disabled={isDisabled}><span className="button-shine"/><span className="action-content"><span className="action-glyph"><Icon name="play"/></span>{busy ? 'РАУНД В ПРОЦЕССЕ…' : label}</span><span className="action-arrow"><Icon name="arrow"/></span></button>;
  const jumpToGame = (gameId, shouldScroll = false) => { setView(gameId); setMessage('Настрой ставку и начинай раунд'); setLastNet(null); if (shouldScroll) window.setTimeout(() => document.getElementById('game-arena')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };

  return (
    <main className="app-shell">
      <div className="background-orb orb-a"/><div className="background-orb orb-b"/><div className="background-grain"/>
      <header className="topbar">
        <button className="brand-lockup" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="NIGHT CLUB — наверх"><span className="brand-mark"><BrandCrown/></span><span className="brand-copy"><span className="brand-name">NIGHT<span>CLUB</span></span><span className="brand-subtitle">PRIVATE GAME ROOM</span></span></button>
        <nav className="topbar-nav" aria-label="Основная навигация"><a className="nav-item active" href="#games">Игровой зал</a><a className="nav-item" href="#game-arena">Стол</a><a className="nav-item" href="#history">История</a></nav>
        <div className="topbar-right"><div className="live-chip"><span className="live-pulse"/><span>СЕРВЕР АКТИВЕН</span></div><div className="wallet-chip"><span className="wallet-icon"><Icon name="wallet"/></span><span className="wallet-copy"><small>ДЕМО-БАЛАНС</small><strong>{loading ? '••••' : `${formatNumber(balance)} ₽`}</strong></span><span className="wallet-demo">DEMO</span></div><div className="avatar" title={player.firstName || 'Игрок'}>{(player.firstName || 'И').slice(0,1).toUpperCase()}</div></div>
      </header>

      <div className="page-content">
        <section className="hero-banner">
          <div className="hero-content"><div className="hero-kicker"><span className="kicker-line"/> THE AFTER DARK ARCADE <span className="kicker-year">EST. 2026</span></div><h1>Ночь создана<br/>для <em>большой игры.</em></h1><p className="hero-description">Шесть авторских режимов. Атмосфера закрытого клуба. Твой личный игровой зал — прямо в Telegram.</p>
            <div className="hero-actions"><button className="hero-primary" onClick={() => jumpToGame('crash', true)}><span>Войти в игру</span><span className="hero-button-arrow"><Icon name="arrow"/></span></button><button className="hero-secondary" onClick={claimBonus} disabled={bonusClaimed || loading}><span className="gift-icon"><Icon name="gift"/></span><span><strong>{bonusClaimed ? 'Бонус получен' : 'Забрать +500'}</strong><small>бесплатные демо-кредиты</small></span></button></div>
            <div className="hero-proof-row"><div className="proof-item"><span className="proof-icon"><Icon name="layers"/></span><span><strong>06</strong><small>РЕЖИМОВ</small></span></div><span className="proof-divider"/><div className="proof-item"><span className="proof-icon"><Icon name="shield"/></span><span><strong>100%</strong><small>DEMO PLAY</small></span></div><span className="proof-divider"/><div className="proof-item"><span className="proof-icon"><Icon name="spark"/></span><span><strong>24/7</strong><small>В ИГРОВОМ ЗАЛЕ</small></span></div></div>
          </div>
          <div className="hero-art-area" aria-hidden="true"><div className="hero-art-glow"/><div className="hero-art-grid"/><div className="hero-orbit orbit-large"/><div className="hero-orbit orbit-small"/><div className="hero-hero-chip chip-back"><GameArt type="coinflip"/></div><div className="hero-main-art"><GameArt type="roulette"/></div><div className="hero-floating-gem"><GameArt type="mines"/></div><div className="hero-floating-dice"><GameArt type="dice"/></div><div className="hero-art-caption"><span className="caption-line"/><span>CRAFTED FOR THE NIGHT</span><span className="caption-star">✦</span></div><div className="hero-balance-card"><span className="balance-mini-icon"><Icon name="wallet"/></span><span className="hero-balance-label"><small>ТВОЙ БАЛАНС</small><strong>{loading ? '••••' : formatNumber(balance)} ₽</strong></span><span className="balance-status">DEMO</span></div></div><div className="hero-bottom-glow"/>
        </section>

        <section className="status-rail"><div className="status-rail-label"><span className="status-gem"><Icon name="spark"/></span><span>СЕГОДНЯ В КЛУБЕ</span></div><div className="status-feature"><span className="feature-number">01</span><span><strong>Серверная игровая логика</strong><small>Результат не подменяется интерфейсом</small></span></div><div className="status-feature"><span className="feature-number">02</span><span><strong>Мгновенные раунды</strong><small>Быстрый переход между режимами</small></span></div><div className="status-feature"><span className="feature-number">03</span><span><strong>Только демо-очки</strong><small>Без депозитов и вывода денег</small></span></div></section>

        <section id="games" className="games-section"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/> THE COLLECTION <span className="section-index">/ 001—006</span></div><h2>Выбирай свою <em>атмосферу.</em></h2><p>Каждый стол — со своим характером.</p></div><div className="collection-counter"><strong>06</strong><span>ИГР В КОЛЛЕКЦИИ</span></div></div>
          <nav className="game-lobby" aria-label="Выбор режима">{GAME_LIST.map((game,index) => <button key={game.id} className={`lobby-card lobby-${game.id} ${view === game.id ? 'selected' : ''}`} onClick={() => jumpToGame(game.id)} style={{'--i': index}} aria-pressed={view === game.id}><span className="card-topline"><span className="card-index">0{index+1} / GAME</span><span className={`card-status ${game.id === 'crash' ? 'status-hot' : ''}`}>{game.tag}</span></span><span className="lobby-art-wrap"><GameArt type={game.id} className="lobby-art"/><span className="art-ground"/></span><span className="lobby-copy"><strong>{game.title}</strong><small>{game.subtitle}</small></span><span className="lobby-arrow"><Icon name="arrow"/></span><span className="card-corner-light"/></button>)}</nav>
        </section>

        <section id="game-arena" className={`game-panel active-panel ${view}-panel`} key={view}>
          <div className="arena-topbar"><div className="arena-heading"><div className="eyebrow"><span className="eyebrow-dot"/> THE MAIN TABLE <span className="section-index">/ {String(GAME_LIST.findIndex((game)=>game.id===view)+1).padStart(3,'0')}</span></div><h2>{selectedGame.title}<span className="title-period">.</span></h2><p>{selectedGame.subtitle}<span className="text-divider"> / </span>демо-режим</p></div><div className="arena-top-right"><span className="table-live"><span/> TABLE ONLINE</span><span className="table-separator"/><span className="table-rounds">РАУНДЫ <strong>{String(roundCount).padStart(2,'0')}</strong></span></div></div>

          {view === 'slots' && <div className="game-layout slots-layout"><div className="game-scene slots-scene"><div className="scene-topline"><span>NC / SLOT MACHINE</span><span className="scene-number">№ 001</span></div><div className="scene-light scene-light-gold"/><div className="slot-machine"><div className="machine-top"><span className="machine-crown"><BrandCrown/></span><span>NIGHT JACKPOT</span><span className="machine-light"/></div><div className={busy ? 'reels spinning' : 'reels'}>{reels.map((symbol,index)=><div className="reel" key={index} style={{'--reel-i':index}}><span className="reel-highlight"/><SlotSymbol kind={normalizeSlotSymbol(symbol)}/></div>)}</div><div className="machine-bottom"><span>LUCK IS AN ART</span><span className="machine-bottom-mark">✦</span><span>HAVE FUN</span></div></div><div className="scene-caption"><span className="scene-caption-dot"/> ТВОЙ СЛЕДУЮЩИЙ СПИН МОЖЕТ БЫТЬ ОСОБЕННЫМ</div><div className="slot-paytable"><span><SlotSymbol kind="seven"/><small>7 / 7 / 7</small><strong>×20</strong></span><span><SlotSymbol kind="gem"/><small>3 камня</small><strong>×10</strong></span><span><SlotSymbol kind="bell"/><small>3 колокола</small><strong>×7</strong></span><span><SlotSymbol kind="clover"/><small>3 клевера</small><strong>×5</strong></span></div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / СТАВКА</span><span className="control-card-sub">ДЕМО-КРЕДИТЫ</span></div>{betControls}<div className="bet-presets"><span>БЫСТРО</span>{[50,100,250,500].map((amount)=><button key={amount} className={bet===amount?'preset-active':''} onClick={()=>setBet(amount)} disabled={busy||loading||amount>balance}>{amount}</button>)}</div>{actionButton('Крутить барабаны',spinSlots)}<div className="control-note"><Icon name="shield"/><span>Исход раунда определяется сервером</span></div></div><div className="side-info-card"><div className="side-info-title"><span className="tiny-spark">✦</span> КАК ИГРАТЬ</div><p>Совпали два символа — небольшой приз. Три одинаковых символа дают выплату по таблице слева.</p><div className="side-info-foot"><span>THE CLASSICS</span><span>01 — 06</span></div></div></div></div>}

          {view === 'roulette' && <div className="game-layout roulette-layout"><div className="game-scene roulette-scene"><div className="scene-topline"><span>NC / EUROPEAN ROULETTE</span><span className="scene-number">№ 002</span></div><div className="roulette-atmosphere"/><div className={`roulette-wheel ${rouletteSpinning?'wheel-spinning':''}`}><div className="wheel-gold-rim"/><div className="wheel-track"><div className="wheel-numbers">{Array.from({length:37},(_,index)=>{const order=[0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];const number=order[index];return <span key={number} className={number===0?'wheel-zero':RED_NUMBERS.has(number)?'wheel-red':'wheel-black'} style={{transform:`rotate(${index*(360/37)}deg) translateY(-89px) rotate(${-index*(360/37)}deg)`}}>{number}</span>})}</div><div className="wheel-inner-ring"/><div className="wheel-hub"><BrandCrown/></div></div><div className="wheel-pointer"/></div><div className="roulette-result"><span className="roulette-result-label">ПОСЛЕДНИЙ РЕЗУЛЬТАТ</span><strong className={rouletteNumber===null?'':rouletteNumber===0?'result-green':RED_NUMBERS.has(rouletteNumber)?'result-red':'result-black'}>{rouletteNumber===null?'— —':String(rouletteNumber).padStart(2,'0')}</strong><span className="roulette-result-color">{rouletteColor}</span></div><div className="scene-caption"><span className="scene-caption-dot"/> ЕВРОПЕЙСКОЕ КОЛЕСО · 37 СЕКТОРОВ</div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / СТАВКА</span><span className="control-card-sub">ДЕМО-КРЕДИТЫ</span></div>{betControls}<div className="roulette-choices"><button className="choice red-choice" onClick={()=>spinRoulette('red')} disabled={disabled}><span className="choice-swatch"/><span>Красное<small>Выплата ×2</small></span></button><button className="choice black-choice" onClick={()=>spinRoulette('black')} disabled={disabled}><span className="choice-swatch"/><span>Чёрное<small>Выплата ×2</small></span></button><button className="choice green-choice" onClick={()=>spinRoulette('zero')} disabled={disabled}><span className="choice-swatch">0</span><span>Зеро<small>Выплата ×36</small></span></button><button className="choice neutral-choice" onClick={()=>spinRoulette('even')} disabled={disabled}><span className="choice-swatch">2−</span><span>Чётное<small>Выплата ×2</small></span></button><button className="choice neutral-choice" onClick={()=>spinRoulette('odd')} disabled={disabled}><span className="choice-swatch">2+</span><span>Нечётное<small>Выплата ×2</small></span></button></div><div className="control-note"><Icon name="shield"/><span>Выбери исход, колесо решит остальное</span></div></div><div className="side-info-card"><div className="side-info-title"><span className="tiny-spark">✦</span> EUROPEAN CLASSIC</div><p>Одно зелёное зеро. Для всех ставок результат рассчитывает сервер.</p><div className="side-info-foot"><span>WHEEL 0—36</span><span>02 — 06</span></div></div></div></div>}

          {view === 'crash' && <div className="game-layout crash-layout"><div className={`game-scene crash-scene ${busy?'crash-live':''} ${lastNet>0?'crash-win':''}`}><div className="scene-topline"><span>NC / NEON ASCENT</span><span className="scene-number">№ 003</span></div><div className="crash-sky-grid"/><div className="crash-stars"><i/><i/><i/><i/><i/><i/></div><svg className="crash-chart" viewBox="0 0 600 350" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#d2ad68" stopOpacity=".25"/><stop offset="100%" stopColor="#d2ad68" stopOpacity="0"/></linearGradient><linearGradient id="chart-line" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stopColor="#bb8a43"/><stop offset="100%" stopColor="#ffe1a0"/></linearGradient></defs><path d="M0 335 C70 328 78 294 146 302 S240 253 285 255 S360 185 410 195 S500 90 600 25 L600 350 L0 350Z" fill="url(#chart-fill)"/><path className="chart-line" d="M0 335 C70 328 78 294 146 302 S240 253 285 255 S360 185 410 195 S500 90 600 25" fill="none" stroke="url(#chart-line)" strokeWidth="3" strokeLinecap="round"/></svg><div className="crash-data-top"><span className="crash-live-label"><span/> LIVE MULTIPLIER</span><span className="crash-last">AUTO EXIT <strong>{crashTarget.toFixed(2)}×</strong></span></div><div className="crash-multiplier">{crashVisual.toFixed(2)}<span>×</span></div><div className="crash-rocket"><GameArt type="crash" className="rocket-illustration"/></div><div className="crash-bottom"><span>ТВОЙ ЦЕЛЕВОЙ ВЫХОД</span><strong>{crashTarget.toFixed(2)}×</strong></div><div className="crash-history-strip"><span>RECENT MULTIPLIERS</span><div>{(history.filter((round)=>round.game==='crash').slice(0,5).length?history.filter((round)=>round.game==='crash').slice(0,5):[{id:'x1',outcome:'1.24×',net:-1},{id:'x2',outcome:'2.18×',net:1},{id:'x3',outcome:'1.05×',net:-1},{id:'x4',outcome:'3.72×',net:1},{id:'x5',outcome:'1.66×',net:1}]).map((round,index)=><span key={round.id||index} className={round.net>0?'multiplier-win':''}>{String(round.outcome).match(/[0-9]+(?:\.[0-9]+)?×?/)?.[0]||'1.00×'}</span>)}</div></div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / AUTO EXIT</span><span className="control-card-sub">1.10× — 5.00×</span></div><div className="target-readout"><span>АВТОВЫХОД</span><strong>{crashTarget.toFixed(2)}<small>×</small></strong></div><input className="premium-range" type="range" min="1.1" max="5" step="0.1" value={crashTarget} disabled={busy} onChange={(event)=>setCrashTarget(Number(event.target.value))} style={{'--range-progress':`${((crashTarget-1.1)/3.9)*100}%`}}/><div className="range-labels"><span>1.10× · спокойнее</span><span>5.00× · рискованнее</span></div>{betControls}<div className="potential-card"><span>ВОЗМОЖНАЯ ВЫПЛАТА</span><strong>{formatDemoRub(Math.floor(bet*crashTarget))}</strong><small>при достижении цели</small></div>{actionButton('Запустить Crash',playCrash)}<div className="control-note"><Icon name="shield"/><span>Результат рассчитывается сервером</span></div></div><div className="side-info-card"><div className="side-info-title"><span className="tiny-spark">✦</span> KNOW YOUR LIMITS</div><p>Чем выше целевой множитель, тем рискованнее раунд. Здесь используются только демо-очки.</p><div className="side-info-foot"><span>RISK / REWARD</span><span>03 — 06</span></div></div></div></div>}

          {view === 'dice' && <div className="game-layout dice-layout"><div className="game-scene dice-scene"><div className="scene-topline"><span>NC / DICE PROTOCOL</span><span className="scene-number">№ 004</span></div><div className="dice-pedestal"><div className="dice-scene-glow"/><GameArt type="dice" className={`dice-art ${busy?'dice-tumbling':''}`}/><div className="dice-readout"><small>RESULT</small><strong>{diceVisual.toString().padStart(2,'0')}</strong><span>OUT OF 99</span></div></div><div className="dice-track-area"><div className="dice-track-caption"><span>CHANCE RANGE</span><strong>{diceSide==='over'?`>${diceTarget}`:`<${diceTarget}`}</strong></div><div className={`dice-track ${busy?'track-active':''}`}><span style={{left:`${diceVisual}%`}}/></div><div className="dice-numbers"><span>00</span><span>25</span><span>50</span><span>75</span><span>99</span></div></div><div className="scene-caption"><span className="scene-caption-dot"/> НАЙДИ БАЛАНС МЕЖДУ ШАНСОМ И МНОЖИТЕЛЕМ</div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / YOUR PREDICTION</span><span className="control-card-sub">0 — 99</span></div><div className="target-readout"><span>ПОРОГ</span><strong>{diceTarget}<small> / 99</small></strong></div><input className="premium-range" type="range" min="10" max="90" step="1" value={diceTarget} disabled={busy} onChange={(event)=>setDiceTarget(Number(event.target.value))} style={{'--range-progress':`${((diceTarget-10)/80)*100}%`}}/><div className="range-labels"><span>Проще попасть</span><span>Выше множитель</span></div><div className="side-selector"><button className={diceSide==='under'?'selected':''} onClick={()=>setDiceSide('under')} disabled={busy}><span>МЕНЬШЕ</span><strong>{diceTarget}</strong></button><button className={diceSide==='over'?'selected':''} onClick={()=>setDiceSide('over')} disabled={busy}><span>БОЛЬШЕ</span><strong>{diceTarget}</strong></button></div>{betControls}{actionButton('Бросить кости',playDice)}<div className="control-note"><Icon name="shield"/><span>Сервер генерирует итоговое число</span></div></div></div></div>}

          {view === 'coinflip' && <div className="game-layout coinflip-layout"><div className="game-scene coinflip-scene"><div className="scene-topline"><span>NC / DOUBLE FLIP</span><span className="scene-number">№ 005</span></div><div className="coin-atmosphere"/><div className={`coin-stage ${busy?'coin-stage-busy':''}`}><div className={`coin ${busy?'coin-flipping':''} ${coinVisual==='Р'?'coin-show-back':''}`}><div className="coin-edge"/><div className="coin-face coin-front"><BrandCrown/></div><div className="coin-face coin-back"><span>NC</span><i>EST. 2026</i></div></div><div className="coin-shadow"/></div><div className="coin-result-label">{busy?'МОНЕТА В ПОЛЁТЕ…':`ПОСЛЕДНИЙ ИСХОД: ${coinVisual==='Р'?'РЕШКА':'ОРЁЛ'}`}</div><div className="scene-caption"><span className="scene-caption-dot"/> ОДИН БРОСОК. ДВА ВОЗМОЖНЫХ ИСХОДА.</div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / ВЫБЕРИ СТОРОНУ</span><span className="control-card-sub">×1.95</span></div><div className="side-selector coin-selector"><button className={coinSide==='heads'?'selected':''} onClick={()=>setCoinSide('heads')} disabled={busy}><span className="coin-choice-visual"><BrandCrown/></span><span><strong>Орёл</strong><small>Сторона с короной</small></span><span className="choice-check">{coinSide==='heads'?'✓':''}</span></button><button className={coinSide==='tails'?'selected':''} onClick={()=>setCoinSide('tails')} disabled={busy}><span className="coin-choice-visual reverse">NC</span><span><strong>Решка</strong><small>Сторона NIGHT CLUB</small></span><span className="choice-check">{coinSide==='tails'?'✓':''}</span></button></div>{betControls}<div className="potential-card"><span>ВЫПЛАТА ПРИ ПОБЕДЕ</span><strong>{formatDemoRub(Math.floor(bet*1.95))}</strong><small>с учётом демо-ставки</small></div>{actionButton('Подбросить монету',playCoinflip)}<p className="game-hint">Угадай сторону. Выплата при победе — ×1,95 от демо-ставки.</p></div></div></div>}

          {view === 'mines' && <div className="game-layout mines-layout"><div className="game-scene mines-scene"><div className="scene-topline"><span>NC / GEM HUNT</span><span className="scene-number">№ 006</span></div><div className="mines-showcase"><div className="mines-showcase-title"><span className="gem-orbit"><GameArt type="mines"/></span><div><small>THE HIDDEN TREASURE</small><strong>{minesGame?'Охота началась':'Найди свой камень'}</strong><p>{minesGame?'Каждая безопасная клетка увеличивает потенциальный приз.':'Выбери число мин и открой безопасные клетки.'}</p></div></div>{!minesGame?<div className="mine-count-picker"><span>МИН НА ПОЛЕ</span><div>{[3,5,8].map((count)=><button key={count} className={mineCount===count?'selected':''} onClick={()=>setMineCount(count)} disabled={busy}>{count}</button>)}</div></div>:<div className="mines-status"><div><span>БЕЗОПАСНЫЕ</span><strong>{minesGame.safeCount||0}</strong></div><div><span>МНОЖИТЕЛЬ</span><strong>{Number(minesGame.multiplier||1).toFixed(2)}×</strong></div><div><span>ПРИЗ СЕЙЧАС</span><strong>{formatDemoRub(minesGame.potentialPayout||0)}</strong></div></div>}<div className="mines-grid">{Array.from({length:25},(_,index)=>{const isPicked=mineReveal.includes(index);const isMine=(minesGame?.revealedIndices||[]).includes(index)&&!isPicked;return <button key={index} style={{'--i':index}} className={`mine-cell ${isPicked?'revealed safe':''} ${isMine?'revealed bomb':''}`} onClick={()=>minesGame?pickMineCell(index):undefined} disabled={!minesGame||busy||isPicked||Boolean(minesGame.gameOver)||Boolean(isMine)} aria-label={`Клетка ${index+1}`}>{isPicked?<SlotSymbol kind="gem"/>:isMine?<MineGlyph/>:<span className="mine-cell-core"/>}</button>})}</div><div className="mine-caption-row"><span><i className="mine-legend safe-legend"/> ДРАГОЦЕННОСТЬ</span><span><i className="mine-legend unknown-legend"/> НЕИЗВЕСТНО</span></div><div className="scene-caption"><span className="scene-caption-dot"/> ОСТАНОВИСЬ И ЗАБЕРИ ПРИЗ В ЛЮБОЙ МОМЕНТ</div></div><div className="control-column"><div className="control-card"><div className="control-card-heading"><span>01 / СТАВКА</span><span className="control-card-sub">STRATEGY MODE</span></div>{betControls}{!minesGame?<>{actionButton('Начать поиск',startMines)}<div className="control-note"><Icon name="shield"/><span>Мины скрыты сервером до открытия клетки</span></div></>:<><div className="potential-card"><span>МОЖНО ЗАБРАТЬ СЕЙЧАС</span><strong>{formatDemoRub(minesGame.potentialPayout||0)}</strong><small>Текущий множитель {Number(minesGame.multiplier||1).toFixed(2)}×</small></div><button className="primary-action cashout-action" onClick={cashoutMines} disabled={busy||!(minesGame.safeCount>0)}><span className="button-shine"/><span className="action-content"><span className="action-glyph"><Icon name="up"/></span>Забрать выигрыш</span><span className="action-arrow"><Icon name="arrow"/></span></button><div className="control-note"><Icon name="shield"/><span>При попадании на мину раунд завершается</span></div></>}</div><div className="side-info-card"><div className="side-info-title"><span className="tiny-spark">✦</span> GEM HUNT RULES</div><p>Каждая безопасная клетка повышает выплату. Можно забрать накопленный демо-приз до открытия следующей клетки.</p><div className="side-info-foot"><span>5 × 5 GRID</span><span>06 / 06</span></div></div></div></div></div>}

          <div className={`result-line ${lastNet>0?'result-success':lastNet<0?'result-loss':''}`} aria-live="polite"><span className="result-indicator"><span/></span><span className="result-message">{message}</span>{lastNet!==null&&<strong className={lastNet>0?'net-positive':lastNet<0?'net-negative':''}>{lastNet>0?'+':''}{formatDemoRub(lastNet)}</strong>}</div>
        </section>

        {error&&<div className="error-banner" role="alert"><span className="error-symbol">!</span><div>{error}</div><button onClick={()=>setError('')} aria-label="Закрыть сообщение">×</button></div>}
        <section id="history" className="history-section"><div className="history-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/> ACTIVITY LOG <span className="section-index">/ LAST ROUNDS</span></div><h2>История <em>раундов.</em></h2><p>Последние события твоего игрового зала.</p></div><div className="history-metric"><strong>{String(history.length).padStart(2,'0')}</strong><span>ЗАПИСЕЙ</span></div></div>{history.length?<div className="history-list">{history.slice(0,7).map((round,index)=>{const meta=GAME_LIST.find((game)=>game.id===round.game)||GAME_LIST[0];return <div className="history-item" key={round.id}><div className={`history-game-icon history-${meta.id}`}><GameArt type={meta.id}/></div><div className="history-info"><strong>{meta.title}</strong><span>{new Date(round.createdAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}<i/>ставка {formatDemoRub(round.bet)}<i/><span className="history-outcome">{round.outcome}</span></span></div><div className={`history-net ${round.net>0?'positive':''}`}>{round.net>0?'+':''}{formatDemoRub(round.net)}</div><span className="history-row-index">{String(index+1).padStart(2,'0')}</span></div>})}</div>:<div className="empty-history"><div className="empty-history-mark"><BrandCrown/></div><p>Пока тихо. Первый раунд начнёт историю.</p><small>Выбери режим выше — и увидишь его здесь.</small></div>}</section>
        <footer className="app-footer"><div className="footer-brand"><span className="footer-mark"><BrandCrown/></span><span><strong>NIGHT<span>CLUB</span></strong><small>PRIVATE GAME ROOM</small></span></div><span className="footer-disclaimer">ДЕМО-РЕЖИМ · ИГРОВЫЕ ОЧКИ НЕ ИМЕЮТ ДЕНЕЖНОЙ СТОИМОСТИ</span><span className="footer-build">UI BUILD 0.3</span></footer>
      </div>
      <nav className="mobile-dock" aria-label="Быстрая навигация"><a href="#games" className="dock-item"><Icon name="grid"/><span>Игры</span></a><button className="dock-item dock-active" onClick={()=>jumpToGame(view,true)}><Icon name="play"/><span>Стол</span></button><a href="#history" className="dock-item"><Icon name="clock"/><span>История</span></a></nav>
      <div className="bottom-disclaimer">Демо-₽ — условные игровые очки. Нет депозитов, покупок или вывода.</div>
    </main>
  );
}

export default App;
