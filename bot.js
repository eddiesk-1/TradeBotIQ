/**
 * TradeBotIQ v4.3 — Clean rewrite fixing all 7 audit issues
 * Fix 1: No broken try/catch injections — all functions clean
 * Fix 2: Ed25519 signing correct implementation
 * Fix 3: CONFIG.assets always array
 * Fix 4: Duplicate position guard BEFORE order placement
 * Fix 5: Ternary logging fixed
 * Fix 6: ATR penalty relaxed for crypto volatility
 * Fix 7: Rate limiting increased between API calls
 */

import "dotenv/config";
import { createPrivateKey, sign as cryptoSign } from "crypto";
import { writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const TRADING_ACCOUNT = (process.env.TRADING_ACCOUNT || "demo").toLowerCase();
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const IS_LIVE         = TRADING_ACCOUNT === "live" && !PAPER_TRADING;

const CONFIG = {
  // Fix 3: always split to guarantee array
  assets:          (process.env.ASSETS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,LINKUSDT,PEPEUSDT").split(",").map(s => s.trim()).filter(Boolean),
  timeframe:       (process.env.TIMEFRAME || "1h").toLowerCase(),
  takeProfitPct:   parseFloat(process.env.TAKE_PROFIT_PCT   || "3.5"),
  stopLossPct:     parseFloat(process.env.STOP_LOSS_PCT     || "1.0"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY  || "31"),
  s1Pct:           parseFloat(process.env.S1_PCT            || "30"),
  s2Pct:           parseFloat(process.env.S2_PCT            || "5"),
  maxTradeUSD:     parseFloat(process.env.MAX_TRADE_SIZE_USD || "35"),
  minScoreS1:      parseInt(process.env.MIN_SCORE_S1        || "60"),
  minScoreS2:      parseInt(process.env.MIN_SCORE_S2        || "40"),
  maxDrawdown:     parseFloat(process.env.MAX_DRAWDOWN_PCT   || "15"),
  paperTrading:    PAPER_TRADING,
  isLive:          IS_LIVE,
  feeRate:         0.001,
  slippagePct:     0.0005,
  apiBase:         "https://api.binance.com",
};

// ─── Fix 2: Ed25519 Signing (clean, no ccxt override needed) ─────────────────
function signEd25519(queryString) {
  const pem = process.env.BINANCE_PRIVATE_KEY;
  if (!pem) throw new Error("BINANCE_PRIVATE_KEY not set");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  return cryptoSign(null, Buffer.from(queryString), privateKey).toString("base64url");
}

function getApiKey() {
  return IS_LIVE
    ? process.env.BINANCE_API_KEY
    : process.env.BINANCE_DEMO_API_KEY;
}

async function binanceRequest(method, path, params = {}) {
  const timestamp   = Date.now();
  const allParams   = { ...params, timestamp };
  const queryString = Object.entries(allParams).map(([k,v]) => `${k}=${v}`).join("&");
  const signature   = signEd25519(queryString);
  const url         = `${CONFIG.apiBase}${path}?${queryString}&signature=${signature}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": getApiKey(),
      "Content-Type": "application/json",
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`Binance API error ${data.code}: ${data.msg}`);
  return data;
}

async function placeMarketOrder(symbol, side, quantity) {
  return binanceRequest("POST", "/api/v3/order", {
    symbol,
    side: side.toUpperCase(),
    type: "MARKET",
    quantity: quantity.toFixed(6),
  });
}

async function fetchAccountBalance() {
  const data = await binanceRequest("GET", "/api/v3/account", {});
  const usdt = data.balances?.find(b => b.asset === "USDT");
  return parseFloat(usdt?.free || 0);
}

// ─── Files ────────────────────────────────────────────────────────────────────
const LOG_FILE       = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE       = "trades.csv";
const BRIEF_FILE     = "morning-brief.json";
const BALANCE_FILE   = "balance-history.json";
const STATE_FILE     = "bot-state.json";
const CSV_HEADERS    = "Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,USD,Fee,Slippage,Net,RealPnL,OrderID,Mode,Strategy,Score,ATR%,Set,Notes";

function initFiles() {
  if (!existsSync(CSV_FILE))       writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  if (!existsSync(LOG_FILE))       writeFileSync(LOG_FILE, JSON.stringify({ trades:[] }, null, 2));
  if (!existsSync(POSITIONS_FILE)) writeFileSync(POSITIONS_FILE, "[]");
  if (!existsSync(BALANCE_FILE))   writeFileSync(BALANCE_FILE, JSON.stringify({ history:[], lastBalance:0, initialBalance:0 }, null, 2));
  if (!existsSync(STATE_FILE))     writeFileSync(STATE_FILE, JSON.stringify({
    wins:{S1:0,S2:0}, losses:{S1:0,S2:0}, totalPnL:{S1:0,S2:0}, totalFees:0, equityCurve:[],
  }, null, 2));
}

function loadLog()        { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE,"utf8")) : { trades:[] }; }
function saveLog(l)       { writeFileSync(LOG_FILE, JSON.stringify(l,null,2)); }
function loadPositions()  { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE,"utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p,null,2)); }
function loadState()      { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE,"utf8")) : { wins:{S1:0,S2:0},losses:{S1:0,S2:0},totalPnL:{S1:0,S2:0},totalFees:0,equityCurve:[] }; }
function saveState(s)     { writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); }

function loadBalanceHistory() {
  return existsSync(BALANCE_FILE)
    ? JSON.parse(readFileSync(BALANCE_FILE,"utf8"))
    : { history:[], lastBalance:0, initialBalance:0 };
}
function saveBalance(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) bh.initialBalance = balance;
  bh.history.push({ timestamp: new Date().toISOString(), balance });
  if (bh.history.length > 200) bh.history = bh.history.slice(-200);
  bh.lastBalance = balance;
  writeFileSync(BALANCE_FILE, JSON.stringify(bh,null,2));
}

function countTodaysTrades(log, symbol, strategy) {
  const today = new Date().toISOString().slice(0,10);
  return log.trades.filter(t =>
    t.timestamp?.startsWith(today) && t.orderPlaced &&
    t.symbol === symbol && t.strategy === strategy
  ).length;
}

function fmtPrice(p) {
  if (!p || p === 0) return "0";
  if (p < 0.0001) return p.toFixed(10);
  if (p < 0.01)   return p.toFixed(8);
  if (p < 1)      return p.toFixed(6);
  return p.toFixed(4);
}

function writeCsvRow(e) {
  const d   = new Date(e.timestamp);
  const qty = e.tradeSize && e.price ? (e.tradeSize/e.price).toFixed(6) : "";
  const fee = e.tradeSize ? (e.tradeSize * CONFIG.feeRate).toFixed(4) : "";
  const slp = e.tradeSize ? (e.tradeSize * CONFIG.slippagePct).toFixed(4) : "";
  const net = e.tradeSize ? (e.tradeSize - parseFloat(fee) - parseFloat(slp)).toFixed(2) : "";
  const mode = !e.allPass ? "BLOCKED" : e.paperTrading ? "PAPER" : IS_LIVE ? "LIVE" : "DEMO";
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0,10), d.toISOString().slice(11,19),
    "Binance", e.symbol, e.side||"", qty,
    e.price ? fmtPrice(e.price) : "",
    e.tradeSize ? e.tradeSize.toFixed(2) : "",
    fee, slp, net,
    e.realPnL !== undefined ? e.realPnL.toFixed(4) : "",
    e.orderId||"BLOCKED", mode,
    e.strategy||"S1", e.score||0,
    e.atrPct ? e.atrPct.toFixed(3) : "",
    e.triggerSet||"", `"${e.notes||""}"`
  ].join(",") + "\n");
}

// ─── Drawdown Guard ───────────────────────────────────────────────────────────
function checkDrawdown(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance || bh.initialBalance === 0) return { ok:true, drawdownPct:0 };
  const pct = ((balance - bh.initialBalance) / bh.initialBalance) * 100;
  return { ok: pct > -CONFIG.maxDrawdown, drawdownPct: pct, initialBalance: bh.initialBalance };
}

// ─── PnL Engine ───────────────────────────────────────────────────────────────
function calcRealPnL(pos, exitPrice) {
  const qty      = pos.sizeUSD / pos.entryPrice;
  const exitTot  = qty * exitPrice;
  const fees     = (pos.sizeUSD + exitTot) * CONFIG.feeRate;
  const slippage = (pos.sizeUSD + exitTot) * CONFIG.slippagePct;
  const gross    = exitTot - pos.sizeUSD;
  return { gross, fees, slippage, net: gross - fees - slippage };
}

function updateStats(strategy, pnl, state) {
  if (pnl.net > 0) state.wins[strategy]   = (state.wins[strategy]||0) + 1;
  else             state.losses[strategy] = (state.losses[strategy]||0) + 1;
  state.totalPnL[strategy] = (state.totalPnL[strategy]||0) + pnl.net;
  state.totalFees           = (state.totalFees||0) + pnl.fees;
  state.equityCurve         = state.equityCurve || [];
  state.equityCurve.push({ timestamp: new Date().toISOString(), pnl: pnl.net, strategy });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

// ─── Self-Optimizer ───────────────────────────────────────────────────────────
function getOptimizedAllocation(state) {
  const winRate = (s) => {
    const t = (state.wins[s]||0) + (state.losses[s]||0);
    return t >= 5 ? (state.wins[s]||0) / t : null;
  };
  const wr1 = winRate("S1"), wr2 = winRate("S2");
  let s1Pct = CONFIG.s1Pct, s2Pct = CONFIG.s2Pct;
  if (wr1 !== null) {
    if (wr1 > 0.65) s1Pct = Math.min(s1Pct * 1.15, 40);
    if (wr1 < 0.40) s1Pct = Math.max(s1Pct * 0.75, 10);
  }
  if (wr2 !== null) {
    if (wr2 > 0.65) s2Pct = Math.min(s2Pct * 1.15, 10);
    if (wr2 < 0.40) s2Pct = Math.max(s2Pct * 0.75, 2);
  }
  return { s1Pct, s2Pct, wr1, wr2 };
}

// ─── Equity Scaler ───────────────────────────────────────────────────────────
function getEquityScaler(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) return 1.0;
  return Math.max(0.5, Math.min(1.2, balance / bh.initialBalance));
}

// ─── Balance Fetch ────────────────────────────────────────────────────────────
async function fetchBalance() {
  if (CONFIG.paperTrading) {
    const bh = loadBalanceHistory();
    return bh.lastBalance || 100;
  }
  const usdt = await fetchAccountBalance();
  saveBalance(usdt);
  return usdt;
}

// ─── Market Data ──────────────────────────────────────────────────────────────
async function fetchCandles(symbol, interval, limit = 500) {
  const map = { "1h":"1h","2h":"2h","4h":"4h","1d":"1d","5m":"5m","15m":"15m" };
  const bi  = map[interval] || "1h";
  const url = `${CONFIG.apiBase}/api/v3/klines?symbol=${symbol}&interval=${bi}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Candles ${symbol}: ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function fetchOrderBook(symbol) {
  const url = `${CONFIG.apiBase}/api/v3/depth?symbol=${symbol}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data   = await res.json();
  const bidVol = data.bids.reduce((s,b) => s + parseFloat(b[1]), 0);
  const askVol = data.asks.reduce((s,a) => s + parseFloat(a[1]), 0);
  const imb    = askVol > 0 ? bidVol / askVol : 1;
  const topBid = parseFloat(data.bids[0]?.[0] || 0);
  const topAsk = parseFloat(data.asks[0]?.[0] || 0);
  const spread = topAsk > 0 ? (topAsk - topBid) / topAsk * 100 : 0;
  return { bidVol, askVol, imbalance: imb, spread, bullish: imb > 1.15, bearish: imb < 0.85 };
}

async function get5mConfirmation(symbol) {
  const candles = await fetchCandles(symbol, "5m", 20);
  const closes  = candles.map(c => c.close);
  const vols    = candles.map(c => c.volume);
  const ema8    = calcEMA(closes, 8);
  const ema21   = calcEMA(closes, 21);
  const rsi5m   = calcRSI(closes, 7);
  const avgVol  = vols.slice(-10).reduce((a,b)=>a+b,0) / 10;
  const last    = candles[candles.length-1];
  const prev    = candles[candles.length-2];
  const body    = Math.abs(last.close - last.open);
  const wick    = (last.high - last.low) || 0.0001;
  return {
    bullish:     ema8 > ema21 && rsi5m < 65 && last.close > prev.close,
    bearish:     ema8 < ema21 && rsi5m > 35 && last.close < prev.close,
    volSpike:    vols[vols.length-1] > avgVol * 1.5,
    strongCandle: body/wick > 0.6,
    rsi5m,
  };
}

// ─── Fix 1: All indicator functions clean — no try/catch injections ───────────

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1] || 0;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g/period) / (l/period));
}

function calcStochRSI(closes) {
  if (closes.length < 28) return { k:50, oversold:false, overbought:false };
  const rv = [];
  for (let i = 14; i <= closes.length; i++) rv.push(calcRSI(closes.slice(0,i), 14));
  const recent = rv.slice(-14);
  const minR = Math.min(...recent), maxR = Math.max(...recent);
  const rawK = maxR === minR ? 50 : ((rv[rv.length-1] - minR) / (maxR - minR)) * 100;
  return { k: rawK, oversold: rawK < 20, overbought: rawK > 80 };
}

function calcMACD(closes) {
  if (closes.length < 35) return { macdLine:0, signalLine:0, histogram:0 };
  const mv = [];
  for (let i = 26; i <= closes.length; i++) {
    const sl = closes.slice(0,i);
    mv.push(calcEMA(sl,12) - calcEMA(sl,26));
  }
  const macdLine   = mv[mv.length-1];
  const signalLine = calcEMA(mv, 9);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

function calcBB(closes) {
  if (closes.length < 20) return { upper:0, middle:0, lower:0 };
  const slice = closes.slice(-20);
  const sma   = slice.reduce((a,b)=>a+b,0) / 20;
  const std   = Math.sqrt(slice.reduce((s,c) => s + Math.pow(c-sma,2), 0) / 20);
  return { upper: sma+2*std, middle: sma, lower: sma-2*std };
}

function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0,0,0,0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return candles[candles.length-1].close;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol  = sess.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv/vol : candles[candles.length-1].close;
}

function calcCMF(candles, period = 20) {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period);
  const mfv    = recent.map(c => {
    const hl = c.high - c.low;
    return hl === 0 ? 0 : ((c.close-c.low) - (c.high-c.close)) / hl * c.volume;
  });
  const sumMFV = mfv.reduce((a,b) => a+b, 0);
  const sumVol = recent.reduce((s,c) => s + c.volume, 0);
  return sumVol ? sumMFV / sumVol : 0;
}

function calcRSIDivergence(closes, period = 14, lookback = 5) {
  if (closes.length < period + lookback + 2) return { bullish:false, bearish:false };
  const rsiNow  = calcRSI(closes, period);
  const rsiPrev = calcRSI(closes.slice(0, -lookback), period);
  const pNow    = closes[closes.length-1];
  const pPrev   = closes[closes.length-1-lookback];
  return {
    bullish: pNow < pPrev && rsiNow > rsiPrev,
    bearish: pNow > pPrev && rsiNow < rsiPrev,
  };
}

function calcTDSequential(closes) {
  if (closes.length < 10) return { count:0, setup:null, upCount:0, downCount:0 };
  let up = 0, dn = 0;
  for (let i = closes.length - 1; i >= 4; i--) {
    if      (closes[i] > closes[i-4]) { if (dn===0) up++; else break; }
    else if (closes[i] < closes[i-4]) { if (up===0) dn++; else break; }
    else break;
  }
  return {
    count: Math.max(up,dn),
    setup: up>=9 ? "SELL_9" : dn>=9 ? "BUY_9" : null,
    upCount: up, downCount: dn,
  };
}

function calcFibLevels(closes, lookback = 50) {
  const recent = closes.slice(-Math.min(lookback, closes.length));
  const high   = Math.max(...recent);
  const low    = Math.min(...recent);
  const range  = high - low || 1;
  const price  = closes[closes.length-1];
  const f618   = high - range * 0.618;
  const f50    = high - range * 0.5;
  return {
    high, low,
    fib618: f618, fib50: f50,
    nearFib618: Math.abs(price - f618) / f618 < 0.015,
    nearFib50:  Math.abs(price - f50)  / f50  < 0.015,
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = candles.slice(-period-1).map((c,i,arr) => {
    if (i === 0) return c.high - c.low;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - arr[i-1].close),
      Math.abs(c.low  - arr[i-1].close)
    );
  });
  return trs.slice(1).reduce((a,b) => a+b, 0) / period;
}

// ─── Full Asset Analysis ──────────────────────────────────────────────────────
async function analyzeAsset(symbol) {
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length-1];

  const ema5   = calcEMA(closes,5);
  const ema8   = calcEMA(closes,8);
  const ema13  = calcEMA(closes,13);
  const ema21  = calcEMA(closes,21);
  const ema50  = calcEMA(closes,50);
  const ema200 = calcEMA(closes,200);
  const rsi3   = calcRSI(closes,3);
  const rsi14  = calcRSI(closes,14);
  const stochRSI = calcStochRSI(closes);
  const macdData = calcMACD(closes);
  const bb       = calcBB(closes);
  const vwapVal  = calcVWAP(candles);
  const cmf      = calcCMF(candles);
  const rsiDiv   = calcRSIDivergence(closes);
  const tdSeq    = calcTDSequential(closes);
  const fib      = calcFibLevels(closes);
  const atr      = calcATR(candles);
  const atrPct   = price > 0 ? (atr / price) * 100 : 0;

  const vols       = candles.map(c => c.volume);
  const avgVol20   = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const currentVol = vols[vols.length-1];
  const volConfirmed = currentVol > avgVol20 * 1.1;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const body = Math.abs(last.close - last.open);
  const wick = (last.high - last.low) || 0.0001;

  return {
    symbol, price,
    ema5, ema8, ema13, ema21, ema50, ema200,
    rsi3, rsi14, stochRSI, macdData, bb,
    vwap: vwapVal, cmf, rsiDiv, tdSeq, fib,
    atr, atrPct, volConfirmed,
    strongGreen: last.close > last.open && body/wick > 0.6,
    strongRed:   last.close < last.open && body/wick > 0.6,
    momentum:    last.close - prev.close,
  };
}

// ─── Fix 6: Relaxed ATR scoring for crypto ────────────────────────────────────
function calcAIScore(d, ob, m5, direction) {
  let score = 0;
  const buy = direction === "BUY";

  // RSI (20pts)
  if (buy)  { if (d.rsi14 < 35) score += 20; else if (d.rsi14 < 50) score += 10; }
  else      { if (d.rsi14 > 65) score += 20; else if (d.rsi14 > 50) score += 10; }

  // CMF (20pts)
  if (buy)  { if (d.cmf > 0.05) score += 20; else if (d.cmf > 0) score += 10; }
  else      { if (d.cmf < -0.05) score += 20; else if (d.cmf < 0) score += 10; }

  // RSI Divergence (15pts)
  if (buy  && d.rsiDiv?.bullish) score += 15;
  if (!buy && d.rsiDiv?.bearish) score += 15;

  // TD Sequential (15pts)
  if (buy  && d.tdSeq?.setup === "BUY_9")  score += 15;
  if (!buy && d.tdSeq?.setup === "SELL_9") score += 15;

  // Volume (10pts)
  if (d.volConfirmed) score += 10;

  // Order book (15pts)
  if (ob) {
    if (buy  && ob.bullish)        score += 15;
    else if (buy  && ob.imbalance > 1.0) score += 7;
    if (!buy && ob.bearish)        score += 15;
    else if (!buy && ob.imbalance < 1.0) score += 7;
    if (ob.spread > 0.1) score -= 5;
  }

  // 5m confirmation (10pts)
  if (m5) {
    if (buy  && m5.bullish)  score += 10;
    if (!buy && m5.bearish)  score += 10;
    if (m5.volSpike) score += 5;
  }

  // Fib zone bonus (5pts)
  if (buy && d.fib?.nearFib618) score += 5;

  // Fix 6: Relaxed ATR penalty — crypto is naturally volatile
  if (d.atrPct > 5.0) score -= 10;       // only penalise extreme volatility
  else if (d.atrPct > 4.0) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Trade Size (ATR + Equity scaling) ───────────────────────────────────────
function calcTradeSize(balance, pct, equityScaler, atrPct) {
  let size = balance * (pct / 100) * equityScaler;
  // Only reduce size at extreme volatility
  if (atrPct > 5.0) size *= 0.6;
  else if (atrPct > 4.0) size *= 0.8;
  return Math.min(size, CONFIG.maxTradeUSD);
}

// ─── Strategy #1 (High Confidence) ───────────────────────────────────────────
function runStrategy1(d) {
  const {
    price, ema5, ema8, ema13, ema21, ema50, ema200,
    rsi3, rsi14, stochRSI, macdData, bb, vwap,
    cmf, rsiDiv, tdSeq, fib, volConfirmed, strongGreen, strongRed, momentum,
  } = d;

  const ribbonBull    = ema5>ema8 && ema8>ema13 && ema13>ema21 && ema21>ema50;
  const ribbonBear    = ema5<ema8 && ema8<ema13 && ema13<ema21 && ema21<ema50;
  const goldenZone    = price>ema50 && price>ema200;
  const nearEMA200    = price>ema200 && price<=ema200*1.02;
  const aboveVWAP     = price > vwap;
  const belowVWAP     = price < vwap;
  const macdBull      = macdData.macdLine > macdData.signalLine;
  const macdBear      = macdData.macdLine < macdData.signalLine;
  const macdCrossUp   = macdData.histogram > 0;
  const macdCrossDown = macdData.histogram < 0;
  const nearBBLower   = price <= bb.lower * 1.005;
  const nearBBUpper   = price >= bb.upper * 0.995;
  const cmfBull       = cmf > 0.05;
  const cmfBear       = cmf < -0.05;
  const posMom        = momentum > 0;
  const negMom        = momentum < 0;
  const stochOS       = stochRSI.oversold;
  const stochOB       = stochRSI.overbought;
  const reasons       = [];

  const setA     = ribbonBull && goldenZone && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setB     = ema8>ema21 && ema21>ema50 && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  const setC     = nearBBLower && rsi3<20 && (stochOS||rsi14<35) && ema8>ema21 && posMom;
  const setD     = nearEMA200 && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setE_buy = fib.nearFib618 && ribbonBull && goldenZone && rsi14<50 && (cmfBull||macdBull) && posMom;
  const setF_buy = rsiDiv.bullish && cmfBull && macdBull && ema8>ema21 && volConfirmed;
  const setG     = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed && cmfBear;
  const setH     = rsi3>80 && nearBBUpper && (stochOB||rsi14>65) && macdCrossDown && negMom;
  const setI     = (tdSeq.setup==="SELL_9"||rsiDiv.bearish) && cmfBear && macdBear && price<ema21;
  const setJ     = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;

  if (setA)     reasons.push("✅ S1-A: Ribbon+Zone+RSI<35+MACD+Vol+CMF");
  if (setB)     reasons.push("✅ S1-B: EMA+StrongGreen+MACDx+VWAP+Vol");
  if (setC)     reasons.push("✅ S1-C: BBLow+RSI3<20+StochOS+Mom");
  if (setD)     reasons.push("✅ S1-D: EMA200+RSI<35+MACD+CMF (Cowen)");
  if (setE_buy) reasons.push("✅ S1-E: Fib618+Ribbon+confirm (vanDePoppe)");
  if (setF_buy) reasons.push("✅ S1-F: RSI bullDiv+CMF+MACD (ToneVays)");
  if (setG)     reasons.push("✅ S1-G[SELL]: Ribbon bear+MACD+VWAP+CMF");
  if (setH)     reasons.push("✅ S1-H[SELL]: RSI3>80+BBUp+StochOB+MACD");
  if (setI)     reasons.push(`✅ S1-I[SELL]: ${tdSeq.setup==="SELL_9"?"TDSeq9":"bearDiv"}+CMF+MACD`);
  if (setJ)     reasons.push("✅ S1-J[SELL]: StrongRed+EMA+MACD+VWAP");

  const buySignal  = setA||setB||setC||setD||setE_buy||setF_buy;
  const sellSignal = setG||setH||setI||setJ;
  let signal = null, triggerSet = null;
  if (buySignal  && !sellSignal) { signal="BUY";  triggerSet=setA?"S1-A":setB?"S1-B":setC?"S1-C":setD?"S1-D":setE_buy?"S1-E":"S1-F"; }
  if (sellSignal && !buySignal)  { signal="SELL"; triggerSet=setG?"S1-G":setH?"S1-H":setI?"S1-I":"S1-J"; }
  if (!reasons.length) reasons.push("🚫 S1: No set passed");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S1",
    details:{ setA,setB,setC,setD,setE_buy,setF_buy,setG,setH,setI,setJ,
              ribbonBull,ribbonBear,goldenZone,macdBull,macdBear,cmfBull,cmfBear } };
}

// ─── Strategy #2 (Opportunistic) ─────────────────────────────────────────────
function runStrategy2(d) {
  const {
    price, ema8, ema21, ema50,
    rsi14, macdData, bb, vwap,
    cmf, rsiDiv, tdSeq, fib, volConfirmed, strongRed, momentum,
  } = d;

  const emaStackBull = ema8>ema21 && ema21>ema50;
  const emaStackBear = ema8<ema21 && ema21<ema50;
  const aboveVWAP    = price > vwap;
  const belowVWAP    = price < vwap;
  const macdBull     = macdData.macdLine > macdData.signalLine;
  const macdBear     = macdData.macdLine < macdData.signalLine;
  const nearBBLower  = price <= bb.lower * 1.02;
  const nearBBUpper  = price >= bb.upper * 0.98;
  const cmfPos       = cmf > 0;
  const cmfNeg       = cmf < 0;
  const posMom       = momentum > 0;
  const negMom       = momentum < 0;
  const reasons      = [];

  const setA2 = emaStackBull && rsi14<55 && (macdBull||cmfPos) && aboveVWAP;
  const setB2 = (fib.nearFib618||fib.nearFib50) && emaStackBull && rsi14<60 && posMom;
  const setC2 = nearBBLower && rsi14<45 && posMom && (emaStackBull||price>ema50);
  const setD2 = rsiDiv.bullish && (emaStackBull||price>ema50) && posMom;
  const setE2 = tdSeq.setup==="BUY_9" && (macdBull||cmfPos);
  const setF2 = emaStackBear && (macdBear||cmfNeg) && belowVWAP;
  const setG2 = nearBBUpper && rsi14>60 && negMom;
  const setH2 = (rsiDiv.bearish||tdSeq.setup==="SELL_9") && (macdBear||cmfNeg);

  if (setA2) reasons.push("✅ S2-A: EMA+RSI<55+MACD/CMF+VWAP");
  if (setB2) reasons.push("✅ S2-B: Fib50/618+EMA+Mom");
  if (setC2) reasons.push("✅ S2-C: BBLow+RSI<45+Mom");
  if (setD2) reasons.push("✅ S2-D: RSI bullDiv+Trend+Mom");
  if (setE2) reasons.push("✅ S2-E: TDSeq BUY_9");
  if (setF2) reasons.push("✅ S2-F[SELL]: EMA bear+MACD/CMF+VWAP");
  if (setG2) reasons.push("✅ S2-G[SELL]: BBUp+RSI>60+Mom-");
  if (setH2) reasons.push("✅ S2-H[SELL]: bearDiv/TDSeq9");

  const buySignal  = setA2||setB2||setC2||setD2||setE2;
  const sellSignal = setF2||setG2||setH2;
  let signal = null, triggerSet = null;
  if (buySignal  && !sellSignal) { signal="BUY";  triggerSet=setA2?"S2-A":setB2?"S2-B":setC2?"S2-C":setD2?"S2-D":"S2-E"; }
  if (sellSignal && !buySignal)  { signal="SELL"; triggerSet=setF2?"S2-F":setG2?"S2-G":"S2-H"; }
  if (!reasons.length) reasons.push("⚪ S2: No signal");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S2",
    details:{ setA2,setB2,setC2,setD2,setE2,setF2,setG2,setH2 } };
}

// ─── TP/SL Exit ───────────────────────────────────────────────────────────────
async function checkExits(symbol, price, botState) {
  const all       = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others    = all.filter(p => p.symbol !== symbol);
  const remaining = [];

  for (const pos of positions) {
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct/100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct/100);
    const hitTP   = price >= tpPrice;
    const hitSL   = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
      const pnl    = calcRealPnL(pos, price);
      updateStats(pos.strategy||"S1", pnl, botState);
      const icon   = hitTP ? "✅" : "🛑";
      console.log(`   ${icon} [${pos.strategy}] ${symbol} ${reason} | Net:$${pnl.net.toFixed(3)}`);

      if (!CONFIG.paperTrading) {
        const qty = pos.sizeUSD / price;
        await placeMarketOrder(symbol, "SELL", qty);
      } else {
        console.log(`   📋 PAPER EXIT | Net:$${pnl.net.toFixed(3)}`);
      }
      writeCsvRow({
        timestamp: new Date().toISOString(), symbol, price,
        tradeSize: pos.sizeUSD, allPass: true, paperTrading: CONFIG.paperTrading,
        orderPlaced: true, orderId: `EXIT-${Date.now()}`, side: "SELL",
        notes: reason, triggerSet: reason, strategy: pos.strategy||"S1",
        realPnL: pnl.net, score: 0, atrPct: 0,
      });
    } else {
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const icon   = pnlPct >= 0 ? "📈" : "📉";
      console.log(`   ⏳ [${pos.strategy}] ${symbol} ${icon}${pnlPct.toFixed(2)}% | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(slPrice)}`);
      remaining.push(pos);
    }
  }
  savePositions([...others, ...remaining]);
}

// ─── Fix 4: Duplicate guard BEFORE order placement ────────────────────────────
async function executeSignal(symbol, signal, tradeSize, price, logEntry) {
  // Check for existing open position on this symbol+strategy BEFORE placing order
  const existing = loadPositions().find(
    p => p.symbol === symbol && p.strategy === logEntry.strategy
  );
  if (existing) {
    console.log(`   ⚠️ [${logEntry.strategy}] Skipping — open position already exists @ ${fmtPrice(existing.entryPrice)}`);
    return;
  }

  if (CONFIG.paperTrading) {
    logEntry.orderPlaced = true;
    logEntry.orderId     = `PAPER-${Date.now()}`;
    logEntry.side        = signal;
    logEntry.notes       = `Paper ${signal} Score:${logEntry.score} ATR:${logEntry.atrPct?.toFixed(2)}% via ${logEntry.triggerSet}`;
    console.log(`   📋 PAPER ${signal} $${tradeSize.toFixed(2)} @ ${fmtPrice(price)} Score:${logEntry.score}`);
  } else {
    const qty   = tradeSize / price;
    const order = await placeMarketOrder(symbol, signal, qty);
    logEntry.orderPlaced = true;
    logEntry.orderId     = String(order.orderId);
    logEntry.side        = signal;
    logEntry.notes       = `Live ${signal} Score:${logEntry.score} via ${logEntry.triggerSet}`;
    console.log(`   ✅ LIVE ${signal} ID:${order.orderId} Score:${logEntry.score}`);
  }

  if (logEntry.orderPlaced && signal === "BUY") {
    const positions = loadPositions();
    positions.push({
      symbol, entryPrice: price, sizeUSD: tradeSize,
      strategy: logEntry.strategy, timestamp: new Date().toISOString(),
    });
    savePositions(positions);
  }
}

// ─── Morning Brief ────────────────────────────────────────────────────────────
async function morningBrief() {
  const botState = loadState();
  const alloc    = getOptimizedAllocation(botState);
  const bh       = loadBalanceHistory();
  const balance  = bh.lastBalance || 0;
  const dd       = checkDrawdown(balance);

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        TradeBotIQ v4.3 — MORNING BRIEF                   ║");
  console.log(`║        ${new Date().toUTCString().slice(0,51).padEnd(51)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  console.log(`  Balance: $${balance.toFixed(2)} | DD: ${dd.drawdownPct.toFixed(1)}% | ${dd.ok?"🟢 OK":"🛑 PAUSED"}`);
  console.log(`  S1 WR:${alloc.wr1!==null?(alloc.wr1*100).toFixed(0)+"%":"new"}(${alloc.s1Pct.toFixed(0)}%) S2 WR:${alloc.wr2!==null?(alloc.wr2*100).toFixed(0)+"%":"new"}(${alloc.s2Pct.toFixed(0)}%)`);
  console.log(`  PnL S1:$${(botState.totalPnL?.S1||0).toFixed(2)} S2:$${(botState.totalPnL?.S2||0).toFixed(2)} Fees:$${(botState.totalFees||0).toFixed(2)}\n`);

  for (const symbol of CONFIG.assets) {
    // Fix 7: 1200ms between assets in brief
    await new Promise(r => setTimeout(r, 1200));
    const d  = await analyzeAsset(symbol);
    const r1 = runStrategy1(d);
    const r2 = runStrategy2(d);
    const [ob, m5] = await Promise.all([fetchOrderBook(symbol), get5mConfirmation(symbol)]);
    const sc1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
    const sc2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;

    // Fix 5: correct ternary formatting
    const trend  = r1.details.ribbonBull ? "📈 BULL" : r1.details.ribbonBear ? "📉 BEAR" : "↔️  FLAT";
    const zone   = r1.details.goldenZone ? "🟢" : "🔴";
    const obStr  = ob ? `OB:${ob.imbalance.toFixed(2)}${ob.bullish ? "🟢" : ob.bearish ? "🔴" : ""}` : "OB:N/A";
    const s1Str  = r1.signal && sc1>=CONFIG.minScoreS1 ? `🔔${r1.signal}(${r1.triggerSet})Sc:${sc1}` : r1.signal ? `⚠️ Sc:${sc1}<${CONFIG.minScoreS1}` : "⚪";
    const s2Str  = r2.signal && sc2>=CONFIG.minScoreS2 ? `🔔${r2.signal}(${r2.triggerSet})Sc:${sc2}` : "⚪";

    console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | ${trend} | ${zone} | RSI:${d.rsi14.toFixed(1)} | CMF:${d.cmf.toFixed(3)} | ATR:${d.atrPct.toFixed(2)}% | ${obStr}`);
    console.log(`    S1:${s1Str} | S2:${s2Str}`);
  }

  writeFileSync(BRIEF_FILE, JSON.stringify({ timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n  Brief saved → ${BRIEF_FILE}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();
  if (process.argv.includes("--brief")) { await morningBrief(); return; }

  const botState     = loadState();
  const alloc        = getOptimizedAllocation(botState);
  const balance      = await fetchBalance();
  const equityScaler = getEquityScaler(balance);
  const dd           = checkDrawdown(balance);
  const bh           = loadBalanceHistory();
  const prevBal      = bh.history.length > 1 ? bh.history[bh.history.length-2]?.balance : balance;
  const balDiff      = balance - prevBal;

  if (!dd.ok) {
    console.log(`\n🛑 MAX DRAWDOWN BREACHED — Trading paused`);
    console.log(`   Balance:$${balance.toFixed(2)} Initial:$${dd.initialBalance?.toFixed(2)} DD:${dd.drawdownPct.toFixed(1)}% (max -${CONFIG.maxDrawdown}%)\n`);
    return;
  }

  const s1WR = alloc.wr1!==null ? `${(alloc.wr1*100).toFixed(0)}%` : "new";
  const s2WR = alloc.wr2!==null ? `${(alloc.wr2*100).toFixed(0)}%` : "new";

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v4.3 — Ed25519 + Clean Rewrite");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:    ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | ${IS_LIVE?"🔴 LIVE Binance":"🧪 DEMO"}`);
  console.log(`  Balance: $${balance.toFixed(2)} ${balDiff>=0?`📈+$${balDiff.toFixed(2)}`:`📉-$${Math.abs(balDiff).toFixed(2)}`}`);
  console.log(`  DD:      ${dd.drawdownPct.toFixed(1)}% limit:-${CONFIG.maxDrawdown}% 🟢`);
  console.log(`  Scale:   ${equityScaler.toFixed(2)}x | S1:${s1WR}(${alloc.s1Pct.toFixed(0)}%) S2:${s2WR}(${alloc.s2Pct.toFixed(0)}%)`);
  console.log(`  PnL:     S1:$${(botState.totalPnL?.S1||0).toFixed(2)} S2:$${(botState.totalPnL?.S2||0).toFixed(2)} Fees:$${(botState.totalFees||0).toFixed(2)}`);
  console.log(`  Signing: ${process.env.BINANCE_PRIVATE_KEY?"🔐 Ed25519":"⚠️ No key set"}`);
  console.log(`  Assets:  ${CONFIG.assets.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.paperTrading) saveBalance(balance);

  const log = loadLog();

  for (const symbol of CONFIG.assets) {
    // Fix 7: 1500ms between symbols to avoid rate limits
    await new Promise(r => setTimeout(r, 1500));

    const d  = await analyzeAsset(symbol);
    const r1 = runStrategy1(d);
    const r2 = runStrategy2(d);

    // Fix 7: sequential fetches with delay between
    const ob = await fetchOrderBook(symbol);
    await new Promise(r => setTimeout(r, 300));
    const m5 = await get5mConfirmation(symbol);

    const sc1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
    const sc2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;

    // Fix 5: All ternaries properly formatted
    const ribbonStr = r1.details.ribbonBull ? "📈 BULL" : r1.details.ribbonBear ? "📉 BEAR" : "↔️  FLAT";
    const zoneStr   = r1.details.goldenZone ? "🟢 Golden" : "🔴 Bear";
    const obStr     = ob ? `Imb:${ob.imbalance.toFixed(2)} ${ob.bullish ? "🟢" : ob.bearish ? "🔴" : "⚪"}` : "N/A";
    const m5Str     = m5 ? (m5.bullish ? "📈" : m5.bearish ? "📉" : "↔️") : "N/A";

    console.log(`\n── ${symbol} ${fmtPrice(d.price)} ─────────────────────────────────────`);
    console.log(`   ${ribbonStr} | ${zoneStr} | CMF:${d.cmf.toFixed(3)} | TD:${d.tdSeq.count}${d.tdSeq.upCount>0?"↑":"↓"} | ATR:${d.atrPct.toFixed(2)}%`);
    console.log(`   RSI14:${d.rsi14.toFixed(1)} RSI3:${d.rsi3.toFixed(1)} MACD:${r1.details.macdBull?"🟢":"🔴"} Vol:${d.volConfirmed?"✅":"⚠️"}`);
    console.log(`   OB: ${obStr} | 5m: ${m5Str} RSI5m:${m5?.rsi5m?.toFixed(1)||"N/A"}`);
    console.log(`   Fib618:${fmtPrice(d.fib.fib618)} Near:${d.fib.nearFib618?"✅":"🚫"} | Div Bull:${d.rsiDiv.bullish?"✅":"🚫"} Bear:${d.rsiDiv.bearish?"✅":"🚫"}`);
    console.log(`   S1 BUY[A:${r1.details.setA?"✅":"🚫"} B:${r1.details.setB?"✅":"🚫"} C:${r1.details.setC?"✅":"🚫"} D:${r1.details.setD?"✅":"🚫"} E:${r1.details.setE_buy?"✅":"🚫"} F:${r1.details.setF_buy?"✅":"🚫"}] SELL[G:${r1.details.setG?"✅":"🚫"} H:${r1.details.setH?"✅":"🚫"} I:${r1.details.setI?"✅":"🚫"} J:${r1.details.setJ?"✅":"🚫"}]`);

    await checkExits(symbol, d.price, botState);

    // S1
    r1.reasons.forEach(r => console.log(`   ${r}`));
    const s1Count = countTodaysTrades(log, symbol, "S1");
    if (r1.allPass && r1.signal && s1Count < CONFIG.maxTradesPerDay) {
      if (sc1 >= CONFIG.minScoreS1) {
        const ts1  = calcTradeSize(balance, alloc.s1Pct, equityScaler, d.atrPct);
        const ent1 = {
          timestamp: new Date().toISOString(), symbol, price: d.price,
          tradeSize: ts1, signal: r1.signal, triggerSet: r1.triggerSet,
          allPass: true, orderPlaced: false, orderId: null,
          paperTrading: CONFIG.paperTrading, strategy: "S1",
          score: sc1, atrPct: d.atrPct,
          conditions: [{ label: r1.triggerSet, pass: true }],
        };
        console.log(`   🎯 S1 ${r1.signal} Score:${sc1} ATR:${d.atrPct.toFixed(2)}% Size:$${ts1.toFixed(2)}`);
        await executeSignal(symbol, r1.signal, ts1, d.price, ent1);
        log.trades.push(ent1);
        writeCsvRow({ ...ent1, notes: ent1.notes || `S1 ${r1.signal} via ${r1.triggerSet}` });
      } else {
        console.log(`   ⚠️ S1 ${r1.signal} score ${sc1}<${CONFIG.minScoreS1} — skipped`);
      }
    } else if (!r1.allPass) {
      console.log(`   ⚪ S1: No signal`);
    }

    // S2
    r2.reasons.forEach(r => console.log(`   ${r}`));
    const s2Count = countTodaysTrades(log, symbol, "S2");
    if (r2.allPass && r2.signal && s2Count < CONFIG.maxTradesPerDay) {
      if (sc2 >= CONFIG.minScoreS2) {
        const ts2  = calcTradeSize(balance, alloc.s2Pct, equityScaler, d.atrPct) * 0.5;
        const ent2 = {
          timestamp: new Date().toISOString(), symbol, price: d.price,
          tradeSize: ts2, signal: r2.signal, triggerSet: r2.triggerSet,
          allPass: true, orderPlaced: false, orderId: null,
          paperTrading: CONFIG.paperTrading, strategy: "S2",
          score: sc2, atrPct: d.atrPct,
          conditions: [{ label: r2.triggerSet, pass: true }],
        };
        console.log(`   🎯 S2 ${r2.signal} Score:${sc2} ATR:${d.atrPct.toFixed(2)}% Size:$${ts2.toFixed(2)}`);
        await executeSignal(symbol, r2.signal, ts2, d.price, ent2);
        log.trades.push(ent2);
        writeCsvRow({ ...ent2, notes: ent2.notes || `S2 ${r2.signal} via ${r2.triggerSet}` });
      } else {
        console.log(`   ⚪ S2 score ${sc2}<${CONFIG.minScoreS2} — skipped`);
      }
    } else if (!r2.allPass) {
      console.log(`   ⚪ S2: No signal`);
    }
  }

  saveLog(log);
  saveState(botState);
  console.log(`\n✅ Done | $${balance.toFixed(2)} | S1:${s1WR} S2:${s2WR} | DD:${dd.drawdownPct.toFixed(1)}%`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err.message); process.exit(1); });
