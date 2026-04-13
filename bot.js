/**
 * TradeBotIQ v4.1 — Live-Ready Elite Bot
 * Adds to v4.0: AI scoring, order book snapshot, win rate optimizer,
 *               real PnL engine, equity curve, fee tracking
 * All indicators REAL — no placeholders
 * Ready for live Binance HMAC keys
 */

import "dotenv/config";
import ccxt from "ccxt";
import { writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const TRADING_ACCOUNT = (process.env.TRADING_ACCOUNT || "demo").toLowerCase();
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const IS_LIVE         = TRADING_ACCOUNT === "live" && !PAPER_TRADING;

const CONFIG = {
  assets:          (process.env.ASSETS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,LINKUSDT,PEPEUSDT").split(","),
  timeframe:       (process.env.TIMEFRAME || "1H").toLowerCase(),
  timeframe5m:     "5m",
  takeProfitPct:   parseFloat(process.env.TAKE_PROFIT_PCT  || "3.5"),
  stopLossPct:     parseFloat(process.env.STOP_LOSS_PCT    || "1.0"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "31"),
  s1Pct:           parseFloat(process.env.S1_PCT || "30"),
  s2Pct:           parseFloat(process.env.S2_PCT || "5"),
  maxTradeUSD:     parseFloat(process.env.MAX_TRADE_SIZE_USD || "35"),
  minScoreS1:      parseInt(process.env.MIN_SCORE_S1 || "65"),
  minScoreS2:      parseInt(process.env.MIN_SCORE_S2 || "45"),
  paperTrading:    PAPER_TRADING,
  isLive:          IS_LIVE,
  feeRate:         0.001,
  slippagePct:     0.0005,
};

// ─── Exchange ─────────────────────────────────────────────────────────────────
function createExchange() {
  const ex = new ccxt.binance({
    apiKey: IS_LIVE ? process.env.BINANCE_API_KEY : process.env.BINANCE_DEMO_API_KEY,
    secret: IS_LIVE ? process.env.BINANCE_SECRET_KEY : process.env.BINANCE_DEMO_SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: "spot", adjustForTimeDifference: true },
  });
  if (!IS_LIVE) ex.setSandboxMode(true);
  return ex;
}

// ─── Files ────────────────────────────────────────────────────────────────────
const LOG_FILE       = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE       = "trades.csv";
const BRIEF_FILE     = "morning-brief.json";
const BALANCE_FILE   = "balance-history.json";
const STATE_FILE     = "bot-state.json";
const CSV_HEADERS    = "Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,USD,Fee,Slippage,Net,RealPnL,OrderID,Mode,Strategy,Score,Set,Notes";

function initFiles() {
  if (!existsSync(CSV_FILE))       writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  if (!existsSync(LOG_FILE))       writeFileSync(LOG_FILE, JSON.stringify({ trades: [] }, null, 2));
  if (!existsSync(POSITIONS_FILE)) writeFileSync(POSITIONS_FILE, "[]");
  if (!existsSync(BALANCE_FILE))   writeFileSync(BALANCE_FILE, JSON.stringify({ history: [], lastBalance: 0 }, null, 2));
  if (!existsSync(STATE_FILE))     writeFileSync(STATE_FILE, JSON.stringify({
    wins: { S1: 0, S2: 0 }, losses: { S1: 0, S2: 0 },
    totalPnL: { S1: 0, S2: 0 }, totalFees: 0,
    equityCurve: [], s1PctOverride: null, s2PctOverride: null,
  }, null, 2));
}

function loadLog()        { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE,"utf8")) : { trades:[] }; }
function saveLog(l)       { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function loadPositions()  { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE,"utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }
function loadState()      { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE,"utf8")) : { wins:{S1:0,S2:0}, losses:{S1:0,S2:0}, totalPnL:{S1:0,S2:0}, totalFees:0, equityCurve:[], s1PctOverride:null, s2PctOverride:null }; }
function saveState(s)     { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function loadBalanceHistory() { return existsSync(BALANCE_FILE) ? JSON.parse(readFileSync(BALANCE_FILE,"utf8")) : { history:[], lastBalance:0 }; }
function saveBalance(balance) {
  const bh = loadBalanceHistory();
  bh.history.push({ timestamp: new Date().toISOString(), balance });
  if (bh.history.length > 200) bh.history = bh.history.slice(-200);
  bh.lastBalance = balance;
  writeFileSync(BALANCE_FILE, JSON.stringify(bh, null, 2));
}

function countTodaysTrades(log, symbol, strategy) {
  const today = new Date().toISOString().slice(0,10);
  return log.trades.filter(t =>
    t.timestamp?.startsWith(today) && t.orderPlaced &&
    t.symbol === symbol && t.strategy === strategy
  ).length;
}

function fmtPrice(price) {
  if (!price) return "0";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01)   return price.toFixed(8);
  if (price < 1)      return price.toFixed(6);
  return price.toFixed(4);
}

function writeCsvRow(e) {
  const d        = new Date(e.timestamp);
  const qty      = e.tradeSize && e.price ? (e.tradeSize / e.price).toFixed(6) : "";
  const fee      = e.tradeSize ? (e.tradeSize * CONFIG.feeRate).toFixed(4) : "";
  const slip     = e.tradeSize ? (e.tradeSize * CONFIG.slippagePct).toFixed(4) : "";
  const net      = e.tradeSize ? (e.tradeSize - parseFloat(fee) - parseFloat(slip)).toFixed(2) : "";
  const mode     = !e.allPass ? "BLOCKED" : e.paperTrading ? "PAPER" : IS_LIVE ? "LIVE" : "DEMO";
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0,10), d.toISOString().slice(11,19),
    "Binance", e.symbol, e.side||"", qty,
    e.price ? fmtPrice(e.price) : "",
    e.tradeSize ? e.tradeSize.toFixed(2) : "",
    fee, slip, net,
    e.realPnL !== undefined ? e.realPnL.toFixed(4) : "",
    e.orderId||"BLOCKED", mode,
    e.strategy||"S1", e.score||0,
    e.triggerSet||"", `"${e.notes||""}"`
  ].join(",") + "\n");
}

// ─── PnL Engine ───────────────────────────────────────────────────────────────
function calcRealPnL(entry, exitPrice) {
  const entryTotal = entry.sizeUSD;
  const qty        = entryTotal / entry.entryPrice;
  const exitTotal  = qty * exitPrice;
  const entryFee   = entryTotal * CONFIG.feeRate;
  const exitFee    = exitTotal  * CONFIG.feeRate;
  const entrySlip  = entryTotal * CONFIG.slippagePct;
  const exitSlip   = exitTotal  * CONFIG.slippagePct;
  const grossPnL   = exitTotal - entryTotal;
  const totalCosts = entryFee + exitFee + entrySlip + exitSlip;
  return { gross: grossPnL, fees: entryFee + exitFee, slippage: entrySlip + exitSlip, net: grossPnL - totalCosts };
}

function updateStats(strategy, pnl, state) {
  if (pnl.net > 0) state.wins[strategy]++;
  else state.losses[strategy]++;
  state.totalPnL[strategy] = (state.totalPnL[strategy] || 0) + pnl.net;
  state.totalFees = (state.totalFees || 0) + pnl.fees;
  state.equityCurve = state.equityCurve || [];
  state.equityCurve.push({ timestamp: new Date().toISOString(), pnl: pnl.net, strategy });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

// ─── Self-Optimizer ───────────────────────────────────────────────────────────
function getOptimizedAllocation(state) {
  const calcWR = (s) => {
    const total = (state.wins[s]||0) + (state.losses[s]||0);
    return total >= 5 ? (state.wins[s]||0) / total : null;
  };
  const wr1 = calcWR("S1");
  const wr2 = calcWR("S2");

  let s1Pct = CONFIG.s1Pct;
  let s2Pct = CONFIG.s2Pct;

  if (wr1 !== null) {
    if (wr1 > 0.65) s1Pct = Math.min(CONFIG.s1Pct * 1.15, 40); // winning — scale up max 40%
    if (wr1 < 0.40) s1Pct = Math.max(CONFIG.s1Pct * 0.75, 10); // losing — scale down min 10%
  }
  if (wr2 !== null) {
    if (wr2 > 0.65) s2Pct = Math.min(CONFIG.s2Pct * 1.15, 10);
    if (wr2 < 0.40) s2Pct = Math.max(CONFIG.s2Pct * 0.75, 2);
  }

  return { s1Pct, s2Pct, wr1, wr2 };
}

// ─── Balance Management ───────────────────────────────────────────────────────
async function fetchBalance(exchange) {
  if (CONFIG.paperTrading) {
    const bh = loadBalanceHistory();
    return bh.lastBalance || 100;
  }
  try {
    const bal  = await exchange.fetchBalance();
    const usdt = bal?.USDT?.free || 0;
    saveBalance(usdt);
    return usdt;
  } catch (err) {
    console.log(`   ⚠️ Balance fetch failed: ${err.message}`);
    return loadBalanceHistory().lastBalance || 100;
  }
}

// ─── Order Book Snapshot (REST — stable for Railway) ─────────────────────────
async function fetchOrderBook(symbol, limit = 20) {
  try {
    const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const bidVol = data.bids.reduce((s,b) => s + parseFloat(b[1]), 0);
    const askVol = data.asks.reduce((s,a) => s + parseFloat(a[1]), 0);
    const imbalance = askVol > 0 ? bidVol / askVol : 1;
    const topBid    = parseFloat(data.bids[0]?.[0] || 0);
    const topAsk    = parseFloat(data.asks[0]?.[0] || 0);
    const spread    = topAsk > 0 ? (topAsk - topBid) / topAsk * 100 : 0;
    return { bidVol, askVol, imbalance, spread, bullish: imbalance > 1.15, bearish: imbalance < 0.85 };
  } catch { return null; }
}

// ─── 5M Confirmation (Hybrid timeframe — van de Poppe entry timing) ───────────
async function get5mConfirmation(symbol) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=20`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const closes = data.map(k => parseFloat(k[4]));
    const vols   = data.map(k => parseFloat(k[5]));
    const last   = data[data.length-1];
    const prev   = data[data.length-2];

    const ema8_5m  = calcEMA(closes, 8);
    const ema21_5m = calcEMA(closes, 21);
    const rsi5m    = calcRSI(closes, 7);
    const avgVol5m = vols.slice(-10).reduce((a,b)=>a+b,0) / 10;
    const curVol5m = vols[vols.length-1];

    const body = Math.abs(parseFloat(last[4]) - parseFloat(last[1]));
    const wick = (parseFloat(last[2]) - parseFloat(last[3])) || 0.0001;

    return {
      bullish: ema8_5m > ema21_5m && rsi5m < 65 && parseFloat(last[4]) > parseFloat(prev[4]),
      bearish: ema8_5m < ema21_5m && rsi5m > 35 && parseFloat(last[4]) < parseFloat(prev[4]),
      volSpike: curVol5m > avgVol5m * 1.5,
      rsi5m,
      strongCandle: body/wick > 0.6,
    };
  } catch { return null; }
}

// ─── AI Score Engine ─────────────────────────────────────────────────────────
function calcAIScore(d, ob, m5, strategy) {
  let score = 0;
  const isBuy = strategy === "BUY";

  // RSI (20 pts)
  if (isBuy  && d.rsi14 < 35) score += 20;
  else if (isBuy && d.rsi14 < 50) score += 10;
  if (!isBuy && d.rsi14 > 65) score += 20;
  else if (!isBuy && d.rsi14 > 50) score += 10;

  // CMF (20 pts)
  if (isBuy  && d.cmf > 0.05)  score += 20;
  else if (isBuy && d.cmf > 0) score += 10;
  if (!isBuy && d.cmf < -0.05) score += 20;
  else if (!isBuy && d.cmf < 0) score += 10;

  // RSI Divergence (15 pts)
  if (isBuy  && d.rsiDiv?.bullish) score += 15;
  if (!isBuy && d.rsiDiv?.bearish) score += 15;

  // TD Sequential (15 pts)
  if (isBuy  && d.tdSeq?.setup === "BUY_9")  score += 15;
  if (!isBuy && d.tdSeq?.setup === "SELL_9") score += 15;

  // Volume (10 pts)
  if (d.volConfirmed) score += 10;

  // Order book (15 pts)
  if (ob) {
    if (isBuy  && ob.bullish) score += 15;
    else if (isBuy && ob.imbalance > 1.0) score += 7;
    if (!isBuy && ob.bearish) score += 15;
    else if (!isBuy && ob.imbalance < 1.0) score += 7;
    if (ob.spread > 0.1) score -= 5; // wide spread = bad liquidity
  }

  // 5m confirmation (10 pts)
  if (m5) {
    if (isBuy  && m5.bullish) score += 10;
    if (!isBuy && m5.bearish) score += 10;
    if (m5.volSpike) score += 5;
  }

  // Fibonacci zone bonus (5 pts)
  if (isBuy && d.fib?.nearFib618) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Market Data + All Indicators ────────────────────────────────────────────
async function fetchCandles(symbol, interval, limit = 500) {
  const map = {"1h":"1h","2h":"2h","4h":"4h","1d":"1d","5m":"5m"};
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]||"1h"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol}: ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g/period) / (l/period));
}

function calcStochRSI(closes) {
  if (closes.length < 28) return null;
  const rsiVals = [];
  for (let i = 14; i <= closes.length; i++) rsiVals.push(calcRSI(closes.slice(0,i), 14));
  const recent = rsiVals.slice(-14);
  const minR = Math.min(...recent), maxR = Math.max(...recent);
  const rawK = maxR === minR ? 50 : ((rsiVals[rsiVals.length-1] - minR) / (maxR - minR)) * 100;
  return { k: rawK, oversold: rawK < 20, overbought: rawK > 80 };
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const macdVals = [];
  for (let i = 26; i <= closes.length; i++) {
    const sl = closes.slice(0,i);
    macdVals.push(calcEMA(sl,12) - calcEMA(sl,26));
  }
  const macdLine = macdVals[macdVals.length-1];
  const signalLine = calcEMA(macdVals, 9);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

function calcBB(closes) {
  if (closes.length < 20) return null;
  const slice = closes.slice(-20);
  const sma = slice.reduce((a,b)=>a+b,0) / 20;
  const std = Math.sqrt(slice.reduce((s,c) => s + Math.pow(c-sma,2), 0) / 20);
  return { upper: sma+2*std, middle: sma, lower: sma-2*std };
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol  = sess.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv/vol : null;
}

function calcCMF(candles, period = 20) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  const mfv = recent.map(c => {
    const hl = c.high - c.low;
    if (hl === 0) return 0;
    return ((c.close - c.low) - (c.high - c.close)) / hl * c.volume;
  });
  const sumMFV = mfv.reduce((a,b) => a+b, 0);
  const sumVol = recent.reduce((s,c) => s + c.volume, 0);
  return sumVol ? sumMFV / sumVol : 0;
}

function calcRSIDivergence(closes, period = 14, lookback = 5) {
  if (closes.length < period + lookback + 2) return { bullish: false, bearish: false };
  const rsiNow    = calcRSI(closes, period);
  const rsiPrev   = calcRSI(closes.slice(0, -lookback), period);
  const priceNow  = closes[closes.length-1];
  const pricePrev = closes[closes.length-1-lookback];
  return {
    bullish: priceNow < pricePrev && rsiNow > rsiPrev,
    bearish: priceNow > pricePrev && rsiNow < rsiPrev,
  };
}

function calcTDSequential(closes) {
  if (closes.length < 10) return { count: 0, setup: null };
  let upCount = 0, downCount = 0;
  for (let i = closes.length - 1; i >= 4; i--) {
    if (closes[i] > closes[i-4]) { if (downCount === 0) upCount++; else break; }
    else if (closes[i] < closes[i-4]) { if (upCount === 0) downCount++; else break; }
    else break;
  }
  const setup = upCount >= 9 ? "SELL_9" : downCount >= 9 ? "BUY_9" : null;
  return { count: Math.max(upCount, downCount), setup, upCount, downCount };
}

function calcFibLevels(closes, lookback = 50) {
  if (closes.length < lookback) return null;
  const recent = closes.slice(-lookback);
  const high = Math.max(...recent), low = Math.min(...recent);
  const range = high - low;
  const price = closes[closes.length-1];
  return {
    high, low, fib618: high - range*0.618, fib50: high - range*0.5,
    nearFib618: Math.abs(price - (high - range*0.618)) / (high - range*0.618) < 0.015,
    nearFib50:  Math.abs(price - (high - range*0.5))   / (high - range*0.5)   < 0.015,
  };
}

async function analyzeAsset(symbol) {
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length-1];

  const ema5=calcEMA(closes,5); const ema8=calcEMA(closes,8); const ema13=calcEMA(closes,13);
  const ema21=calcEMA(closes,21); const ema50=calcEMA(closes,50); const ema200=calcEMA(closes,200);
  const rsi3=calcRSI(closes,3); const rsi14=calcRSI(closes,14);
  const stochRSI=calcStochRSI(closes); const macdData=calcMACD(closes);
  const bb=calcBB(closes); const vwapVal=calcVWAP(candles);
  const cmf=calcCMF(candles); const rsiDiv=calcRSIDivergence(closes);
  const tdSeq=calcTDSequential(closes); const fib=calcFibLevels(closes);

  const vols = candles.map(c => c.volume);
  const avgVol20   = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const currentVol = vols[vols.length-1];
  const volConfirmed = currentVol > avgVol20 * 1.1;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const body = Math.abs(last.close - last.open);
  const wick = (last.high - last.low) || 0.0001;
  const strongGreen = last.close > last.open && body/wick > 0.6;
  const strongRed   = last.close < last.open && body/wick > 0.6;
  const momentum    = last.close - prev.close;

  return {
    symbol, price, ema5, ema8, ema13, ema21, ema50, ema200,
    rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
    cmf, rsiDiv, tdSeq, fib,
    volConfirmed, currentVol, avgVol20,
    strongGreen, strongRed, momentum,
  };
}

// ─── Strategy #1 (30% — High Confidence) ─────────────────────────────────────
function runStrategy1(d) {
  const { price, ema5, ema8, ema13, ema21, ema50, ema200,
          rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
          cmf, rsiDiv, tdSeq, fib,
          volConfirmed, strongGreen, strongRed, momentum } = d;

  const ribbonBull = ema5>ema8 && ema8>ema13 && ema13>ema21 && ema21>ema50;
  const ribbonBear = ema5<ema8 && ema8<ema13 && ema13<ema21 && ema21<ema50;
  const goldenZone = price>ema50 && price>ema200;
  const nearEMA200 = price>ema200 && price<=ema200*1.02;
  const aboveVWAP  = vwapVal && price>vwapVal;
  const belowVWAP  = vwapVal && price<vwapVal;
  const macdBull   = macdData?.macdLine > macdData?.signalLine;
  const macdBear   = macdData?.macdLine < macdData?.signalLine;
  const macdCrossUp   = macdData?.histogram > 0;
  const macdCrossDown = macdData?.histogram < 0;
  const nearBBLower = bb && price<=bb.lower*1.005;
  const nearBBUpper = bb && price>=bb.upper*0.995;
  const cmfBull = cmf !== null && cmf > 0.05;
  const cmfBear = cmf !== null && cmf < -0.05;
  const posMom = momentum > 0, negMom = momentum < 0;
  const stochOS = stochRSI?.oversold ?? false;
  const stochOB = stochRSI?.overbought ?? false;
  const reasons = [];

  const setA     = ribbonBull && goldenZone && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setB     = (ema8>ema21&&ema21>ema50) && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  const setC     = nearBBLower && rsi3<20 && (stochOS||rsi14<35) && (ema8>ema21) && posMom;
  const setD     = nearEMA200 && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setE_buy = fib?.nearFib618 && ribbonBull && goldenZone && rsi14<50 && (cmfBull||macdBull) && posMom;
  const setF_buy = rsiDiv?.bullish && cmfBull && macdBull && (ema8>ema21) && volConfirmed;
  const setG     = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed && cmfBear;
  const setH     = rsi3>80 && nearBBUpper && (stochOB||rsi14>65) && macdCrossDown && negMom;
  const setI     = (tdSeq?.setup==="SELL_9"||rsiDiv?.bearish) && cmfBear && macdBear && price<ema21;
  const setJ     = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;

  if (setA)     reasons.push("✅ S1-A: Ribbon+GoldenZone+RSI<35+MACD+Vol+CMF");
  if (setB)     reasons.push("✅ S1-B: EMA stack+StrongGreen+MACDcross+VWAP+Vol");
  if (setC)     reasons.push("✅ S1-C: BBLower+RSI3<20+StochOS+EMA+Mom");
  if (setD)     reasons.push("✅ S1-D: EMA200 support+RSI<35+MACD+CMF (Cowen)");
  if (setE_buy) reasons.push("✅ S1-E: Fib618 pullback+Ribbon+MACD/CMF (vanDePoppe)");
  if (setF_buy) reasons.push("✅ S1-F: RSI bullDiv+CMF+MACD (ToneVays)");
  if (setG)     reasons.push("✅ S1-G(SELL): Ribbon bear+MACD+VWAP+CMF");
  if (setH)     reasons.push("✅ S1-H(SELL): RSI3>80+BBUpper+StochOB+MACD");
  if (setI)     reasons.push(`✅ S1-I(SELL): ${tdSeq?.setup==="SELL_9"?"TDSeq9":"RSI bearDiv"}+CMF+MACD`);
  if (setJ)     reasons.push("✅ S1-J(SELL): StrongRed+EMA21/50+MACD+VWAP");

  const buySignal  = setA||setB||setC||setD||setE_buy||setF_buy;
  const sellSignal = setG||setH||setI||setJ;

  let signal = null, triggerSet = null;
  if (buySignal && !sellSignal) {
    signal = "BUY";
    triggerSet = setA?"S1-A": setB?"S1-B": setC?"S1-C": setD?"S1-D": setE_buy?"S1-E":"S1-F";
  } else if (sellSignal && !buySignal) {
    signal = "SELL";
    triggerSet = setG?"S1-G": setH?"S1-H": setI?"S1-I":"S1-J";
  }
  if (!reasons.length) reasons.push("🚫 S1: No set passed");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S1",
    details:{ setA,setB,setC,setD,setE_buy,setF_buy,setG,setH,setI,setJ,
              ribbonBull,ribbonBear,goldenZone,macdBull,macdBear,cmfBull,cmfBear } };
}

// ─── Strategy #2 (5% — Opportunistic) ────────────────────────────────────────
function runStrategy2(d) {
  const { price, ema8, ema13, ema21, ema50, ema200,
          rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
          cmf, rsiDiv, tdSeq, fib,
          volConfirmed, strongGreen, strongRed, momentum } = d;

  const emaStackBull = ema8>ema21 && ema21>ema50;
  const emaStackBear = ema8<ema21 && ema21<ema50;
  const aboveVWAP    = vwapVal && price>vwapVal;
  const belowVWAP    = vwapVal && price<vwapVal;
  const macdBull     = macdData?.macdLine > macdData?.signalLine;
  const macdBear     = macdData?.macdLine < macdData?.signalLine;
  const nearBBLower  = bb && price<=bb.lower*1.02;
  const nearBBUpper  = bb && price>=bb.upper*0.98;
  const cmfPos = cmf !== null && cmf > 0;
  const cmfNeg = cmf !== null && cmf < 0;
  const posMom = momentum > 0, negMom = momentum < 0;
  const reasons = [];

  const setA2 = emaStackBull && rsi14<55 && (macdBull||cmfPos) && aboveVWAP;
  const setB2 = (fib?.nearFib618||fib?.nearFib50) && emaStackBull && rsi14<60 && posMom;
  const setC2 = nearBBLower && rsi14<45 && posMom && (emaStackBull||price>ema50);
  const setD2 = rsiDiv?.bullish && (emaStackBull||price>ema50) && posMom;
  const setE2 = tdSeq?.setup==="BUY_9" && (macdBull||cmfPos);
  const setF2 = emaStackBear && (macdBear||cmfNeg) && belowVWAP;
  const setG2 = nearBBUpper && rsi14>60 && negMom;
  const setH2 = (rsiDiv?.bearish||tdSeq?.setup==="SELL_9") && (macdBear||cmfNeg);

  if (setA2) reasons.push("✅ S2-A: EMA stack+RSI<55+MACD/CMF+VWAP");
  if (setB2) reasons.push("✅ S2-B: Fib50/618+EMA+RSI<60+Mom");
  if (setC2) reasons.push("✅ S2-C: BBLower+RSI<45+Mom+Trend");
  if (setD2) reasons.push("✅ S2-D: RSI bullDiv+Trend+Mom");
  if (setE2) reasons.push("✅ S2-E: TDSeq BUY_9+confirm");
  if (setF2) reasons.push("✅ S2-F(SELL): EMA bear+MACD/CMF+VWAP");
  if (setG2) reasons.push("✅ S2-G(SELL): BBUpper+RSI>60+Mom-");
  if (setH2) reasons.push("✅ S2-H(SELL): RSI bearDiv/TDSeq+confirm");

  const buySignal  = setA2||setB2||setC2||setD2||setE2;
  const sellSignal = setF2||setG2||setH2;

  let signal = null, triggerSet = null;
  if (buySignal && !sellSignal) {
    signal = "BUY";
    triggerSet = setA2?"S2-A": setB2?"S2-B": setC2?"S2-C": setD2?"S2-D":"S2-E";
  } else if (sellSignal && !buySignal) {
    signal = "SELL";
    triggerSet = setF2?"S2-F": setG2?"S2-G":"S2-H";
  }
  if (!reasons.length) reasons.push("⚪ S2: No signal");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S2",
    details:{ setA2,setB2,setC2,setD2,setE2,setF2,setG2,setH2 } };
}

// ─── TP/SL Exit ───────────────────────────────────────────────────────────────
async function checkExits(exchange, symbol, price, botState) {
  const all       = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others    = all.filter(p => p.symbol !== symbol);
  const remaining = [];

  for (const pos of positions) {
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct  / 100);
    const hitTP   = price >= tpPrice;
    const hitSL   = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
      const pnl    = calcRealPnL(pos, price);
      updateStats(pos.strategy || "S1", pnl, botState);

      console.log(`   ${hitTP?"✅":"🛑"} [${pos.strategy}] ${symbol} ${reason} | Gross:$${pnl.gross.toFixed(3)} Fees:$${pnl.fees.toFixed(3)} Net:$${pnl.net.toFixed(3)}`);

      if (!CONFIG.paperTrading) {
        try {
          await exchange.createMarketSellOrder(symbol.replace("USDT","/USDT"), pos.sizeUSD/price);
        } catch (err) { console.log(`   ❌ Exit failed: ${err.message}`); remaining.push(pos); continue; }
      } else {
        console.log(`   📋 PAPER EXIT — Net P&L: $${pnl.net.toFixed(3)}`);
      }

      writeCsvRow({
        timestamp: new Date().toISOString(), symbol, price,
        tradeSize: pos.sizeUSD, allPass: true, paperTrading: CONFIG.paperTrading,
        orderPlaced: true, orderId: `EXIT-${Date.now()}`, side: "SELL",
        notes: reason, triggerSet: reason, strategy: pos.strategy||"S1",
        realPnL: pnl.net, score: 0,
      });
    } else {
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice * 100);
      console.log(`   ⏳ [${pos.strategy}] ${symbol} ${pnlPct>=0?"📈":"📉"}${pnlPct.toFixed(2)}% | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(slPrice)}`);
      remaining.push(pos);
    }
  }
  savePositions([...others, ...remaining]);
}

// ─── Place Order ──────────────────────────────────────────────────────────────
async function placeOrder(exchange, symbol, signal, tradeSize, price, logEntry) {
  const effectivePrice = CONFIG.paperTrading ? price : price * (1 + (signal==="BUY"?1:-1) * CONFIG.slippagePct);
  if (CONFIG.paperTrading) {
    logEntry.orderPlaced = true;
    logEntry.orderId     = `PAPER-${Date.now()}`;
    logEntry.side        = signal;
    logEntry.notes       = `Paper ${signal} | Score:${logEntry.score} via ${logEntry.triggerSet}`;
    console.log(`   📋 PAPER ${signal} — $${tradeSize.toFixed(2)} @ ${fmtPrice(effectivePrice)} | Score:${logEntry.score}`);
  } else {
    try {
      const ccxtSym = symbol.replace("USDT","/USDT");
      const qty     = tradeSize / effectivePrice;
      const order   = signal === "BUY"
        ? await exchange.createMarketBuyOrder(ccxtSym, qty)
        : await exchange.createMarketSellOrder(ccxtSym, qty);
      logEntry.orderPlaced = true;
      logEntry.orderId     = order.id;
      logEntry.side        = signal;
      logEntry.notes       = `Live ${signal} | Score:${logEntry.score} via ${logEntry.triggerSet}`;
      console.log(`   ✅ LIVE ${signal} — ID: ${order.id} | Score:${logEntry.score}`);
    } catch (err) {
      console.log(`   ❌ Order failed: ${err.message}`);
      logEntry.notes = `Failed: ${err.message}`;
    }
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

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        TradeBotIQ v4.1 — MORNING BRIEF                   ║");
  console.log(`║        ${new Date().toUTCString().padEnd(51)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  const s1WR = alloc.wr1 !== null ? `${(alloc.wr1*100).toFixed(0)}%` : "N/A";
  const s2WR = alloc.wr2 !== null ? `${(alloc.wr2*100).toFixed(0)}%` : "N/A";
  console.log(`  Optimizer: S1 WR:${s1WR} (${alloc.s1Pct.toFixed(1)}%) | S2 WR:${s2WR} (${alloc.s2Pct.toFixed(1)}%)`);
  console.log(`  Total PnL: S1:$${(botState.totalPnL?.S1||0).toFixed(2)} S2:$${(botState.totalPnL?.S2||0).toFixed(2)} | Fees paid: $${(botState.totalFees||0).toFixed(2)}\n`);

  const results = [];
  for (const symbol of CONFIG.assets) {
    try {
      const d  = await analyzeAsset(symbol);
      const r1 = runStrategy1(d);
      const r2 = runStrategy2(d);
      const ob = await fetchOrderBook(symbol);
      const m5 = await get5mConfirmation(symbol);

      const score1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
      const score2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;
      const trend  = r1.details.ribbonBull?"📈 BULL":r1.details.ribbonBear?"📉 BEAR":"↔️  FLAT";
      const zone   = r1.details.goldenZone?"🟢":"🔴";
      const cmfStr = d.cmf>0.05?"🟢CMF":d.cmf<-0.05?"🔴CMF":"⚪CMF";
      const obStr  = ob ? `OB:${ob.imbalance.toFixed(2)}${ob.bullish?"🟢":ob.bearish?"🔴":""}` : "OB:N/A";

      const s1Str = r1.signal && score1 >= CONFIG.minScoreS1 ? `🔔${r1.signal}(${r1.triggerSet}) Score:${score1}` : r1.signal ? `⚠️${r1.signal} Score:${score1}<${CONFIG.minScoreS1}` : "⚪ wait";
      const s2Str = r2.signal && score2 >= CONFIG.minScoreS2 ? `🔔${r2.signal}(${r2.triggerSet}) Score:${score2}` : "⚪ wait";

      console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | ${trend} | ${zone} | RSI14:${d.rsi14?.toFixed(1).padStart(5)} | ${cmfStr} | ${obStr}`);
      console.log(`    S1: ${s1Str} | S2: ${s2Str}`);

      results.push({ symbol, price: d.price, s1: r1, s2: r2, score1, score2 });
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  ${symbol.padEnd(10)} ❌ ${err.message}`);
    }
  }

  writeFileSync(BRIEF_FILE, JSON.stringify({ timestamp: new Date().toISOString(), assets: results }, null, 2));
  console.log(`\n  Brief → ${BRIEF_FILE}\n`);
}

// ─── PineScript ───────────────────────────────────────────────────────────────
function exportPineScript() {
  const pine = `//@version=5
strategy("TradeBotIQ v4.1 — van de Poppe + Tone Vays + AI Score", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1)

ema5=ta.ema(close,5); ema8=ta.ema(close,8); ema13=ta.ema(close,13)
ema21=ta.ema(close,21); ema50=ta.ema(close,50); ema200=ta.ema(close,200)
plot(ema5,color=color.lime,linewidth=1); plot(ema8,color=color.green,linewidth=1)
plot(ema13,color=color.teal,linewidth=1); plot(ema21,color=color.blue,linewidth=2)
plot(ema50,color=color.orange,linewidth=2); plot(ema200,color=color.red,linewidth=3)

rsi3=ta.rsi(close,3); rsi14=ta.rsi(close,14)
[ml,sl,hist]=ta.macd(close,12,26,9)
[bbU,bbM,bbL]=ta.bb(close,20,2)
vwapVal=ta.vwap(hlc3)
mfv=((close-low)-(high-close))/(high-low==0?1:high-low)*volume
cmf=ta.sma(mfv,20)/ta.sma(volume,20)
volOk=volume>ta.sma(volume,20)*1.1

ph=ta.highest(high,50); pl=ta.lowest(low,50)
fib618=ph-(ph-pl)*0.618; fib50=ph-(ph-pl)*0.5
plot(fib618,color=color.new(color.yellow,50),linewidth=1,title="Fib 61.8%")
plot(fib50, color=color.new(color.yellow,70),linewidth=1,title="Fib 50%")

rsiPrev=rsi14[5]; bullDiv=close<close[5] and rsi14>rsiPrev
bearDiv=close>close[5] and rsi14<rsiPrev

ribbonBull=ema5>ema8 and ema8>ema13 and ema13>ema21 and ema21>ema50
ribbonBear=ema5<ema8 and ema8<ema13 and ema13<ema21 and ema21<ema50
goldenZone=close>ema50 and close>ema200
body=math.abs(close-open); wick=math.max(high-low,0.0001)
strongGreen=close>open and body/wick>0.6; strongRed=close<open and body/wick>0.6

s1A=ribbonBull and goldenZone and rsi14<35 and ml>sl and volOk and cmf>0.05
s1B=ema8>ema21 and ema21>ema50 and close>ema8 and strongGreen and hist>0 and close>vwapVal and volOk
s1C=close<=bbL*1.005 and rsi3<20 and rsi14<35 and ema8>ema21 and close>close[1]
s1D=close>ema200 and close<=ema200*1.02 and rsi14<35 and ml>sl and volOk and cmf>0.05
s1E=math.abs(close-fib618)/fib618<0.015 and ribbonBull and goldenZone and rsi14<50 and cmf>0
s1F=bullDiv and cmf>0.05 and ml>sl and ema8>ema21 and volOk

s1G=ribbonBear and ml<sl and close<vwapVal and close<ema21 and volOk and cmf<-0.05
s1H=rsi3>80 and close>=bbU*0.995 and rsi14>65 and hist<0 and close<close[1]
s1J=strongRed and close<ema21 and close<ema50 and ml<sl and close<vwapVal

s2A=ema8>ema21 and ema21>ema50 and rsi14<55 and (ml>sl or cmf>0) and close>vwapVal
s2B=(math.abs(close-fib618)/fib618<0.015 or math.abs(close-fib50)/fib50<0.015) and ema8>ema21 and rsi14<60 and close>close[1]
s2D=bullDiv and (ema8>ema21 or close>ema50) and close>close[1]

s1Buy=(s1A or s1B or s1C or s1D or s1E or s1F) and not(s1G or s1H or s1J)
s1Sell=(s1G or s1H or s1J) and not(s1A or s1B or s1C or s1D or s1E or s1F)
s2Buy=(s2A or s2B or s2D) and not s1Sell

if s1Buy
    strategy.entry("S1",strategy.long,qty_value=30)
    strategy.exit("S1x","S1",profit=close*0.035/syminfo.mintick,loss=close*0.01/syminfo.mintick)
if s2Buy
    strategy.entry("S2",strategy.long,qty_value=5)
    strategy.exit("S2x","S2",profit=close*0.035/syminfo.mintick,loss=close*0.01/syminfo.mintick)
if s1Sell
    strategy.close_all(comment="Sell")

plotshape(s1Buy,location=location.belowbar,color=color.green,style=shape.labelup,text="S1")
plotshape(s2Buy,location=location.belowbar,color=color.lime,style=shape.triangleup,text="S2")
plotshape(s1Sell,location=location.abovebar,color=color.red,style=shape.labeldown,text="SELL")
bgcolor(goldenZone?color.new(color.green,95):color.new(color.red,95))
alertcondition(s1Buy,"S1 BUY","TradeBotIQ S1 BUY: {{ticker}} @ {{close}}")
alertcondition(s2Buy,"S2 BUY","TradeBotIQ S2 BUY: {{ticker}} @ {{close}}")
alertcondition(s1Sell,"SELL","TradeBotIQ SELL: {{ticker}} @ {{close}}")
`;
  writeFileSync("TradeBotIQ.pine", pine);
  console.log("✅ PineScript v4.1 saved → TradeBotIQ.pine");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();
  if (process.argv.includes("--brief")) { await morningBrief(); return; }
  if (process.argv.includes("--pine"))  { exportPineScript();   return; }

  const botState = loadState();
  const alloc    = getOptimizedAllocation(botState);
  const exchange = createExchange();
  const balance  = await fetchBalance(exchange);
  const bh       = loadBalanceHistory();
  const prevBal  = bh.history.length > 1 ? bh.history[bh.history.length-2]?.balance : balance;
  const balDiff  = balance - prevBal;

  const s1WR = alloc.wr1 !== null ? `${(alloc.wr1*100).toFixed(0)}%` : "new";
  const s2WR = alloc.wr2 !== null ? `${(alloc.wr2*100).toFixed(0)}%` : "new";

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v4.1 — Dual Strategy + AI Score + PnL Engine");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:      ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | ${IS_LIVE?"🔴 LIVE Binance":"🧪 DEMO"}`);
  console.log(`  Balance:   $${balance.toFixed(2)} ${balDiff>=0?`📈+$${balDiff.toFixed(2)}`:`📉-$${Math.abs(balDiff).toFixed(2)}`}`);
  console.log(`  S1(${alloc.s1Pct.toFixed(0)}% WR:${s1WR}): $${(balance*alloc.s1Pct/100).toFixed(2)} | S2(${alloc.s2Pct.toFixed(0)}% WR:${s2WR}): $${(balance*alloc.s2Pct/100).toFixed(2)}`);
  console.log(`  PnL: S1=$${(botState.totalPnL?.S1||0).toFixed(2)} S2=$${(botState.totalPnL?.S2||0).toFixed(2)} | Fees: $${(botState.totalFees||0).toFixed(2)}`);
  console.log(`  Min Score: S1≥${CONFIG.minScoreS1} S2≥${CONFIG.minScoreS2}`);
  console.log(`  Assets:    ${CONFIG.assets.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.paperTrading) saveBalance(balance);

  const log = loadLog();

  for (const symbol of CONFIG.assets) {
    try {
      const d  = await analyzeAsset(symbol);
      const r1 = runStrategy1(d);
      const r2 = runStrategy2(d);

      // Order book + 5m confirmation (parallel)
      const [ob, m5] = await Promise.all([
        fetchOrderBook(symbol),
        get5mConfirmation(symbol),
      ]);

      const score1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
      const score2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;

      console.log(`\n── ${symbol} ${fmtPrice(d.price)} ─────────────────────────────────────`);
      console.log(`   Ribbon:${r1.details.ribbonBull?"📈":"📉"} Zone:${r1.details.goldenZone?"🟢":"🔴"} CMF:${d.cmf?.toFixed(3)||"N/A"} TD:${d.tdSeq.count}${d.tdSeq.upCount>0?"↑":"↓"}`);
      console.log(`   RSI14:${d.rsi14?.toFixed(1)} RSI3:${d.rsi3?.toFixed(1)} MACD:${r1.details.macdBull?"🟢":"🔴"} Vol:${d.volConfirmed?"✅":"⚠️"}`);
      if (ob) console.log(`   OrderBook: Imb:${ob.imbalance.toFixed(3)} ${ob.bullish?"🟢 Buy wall":ob.bearish?"🔴 Sell pressure":"⚪ Neutral"} Spread:${ob.spread.toFixed(4)}%`);
      if (m5) console.log(`   5m: ${m5.bullish?"📈 Bull":m5.bearish?"📉 Bear":"↔️"} RSI5m:${m5.rsi5m?.toFixed(1)} VolSpike:${m5.volSpike?"✅":"🚫"}`);
      if (d.fib) console.log(`   Fib618:${fmtPrice(d.fib.fib618)} Near:${d.fib.nearFib618?"✅":"🚫"} | RsiDiv Bull:${d.rsiDiv.bullish?"✅":"🚫"} Bear:${d.rsiDiv.bearish?"✅":"🚫"}`);
      console.log(`   S1 Sets: A:${r1.details.setA?"✅":"🚫"} B:${r1.details.setB?"✅":"🚫"} C:${r1.details.setC?"✅":"🚫"} D:${r1.details.setD?"✅":"🚫"} E:${r1.details.setE_buy?"✅":"🚫"} F:${r1.details.setF_buy?"✅":"🚫"} | G:${r1.details.setG?"✅":"🚫"} H:${r1.details.setH?"✅":"🚫"} I:${r1.details.setI?"✅":"🚫"} J:${r1.details.setJ?"✅":"🚫"}`);
      console.log(`   S2 Sets: A:${r2.details.setA2?"✅":"🚫"} B:${r2.details.setB2?"✅":"🚫"} C:${r2.details.setC2?"✅":"🚫"} D:${r2.details.setD2?"✅":"🚫"} E:${r2.details.setE2?"✅":"🚫"}`);

      await checkExits(exchange, symbol, d.price, botState);

      // S1 execution
      const s1Count = countTodaysTrades(log, symbol, "S1");
      if (s1Count < CONFIG.maxTradesPerDay) {
        r1.reasons.forEach(r => console.log(`   ${r}`));
        if (r1.allPass && r1.signal) {
          if (score1 >= CONFIG.minScoreS1) {
            const tradeSize = Math.min(balance * (alloc.s1Pct/100), CONFIG.maxTradeUSD);
            const entry1 = {
              timestamp: new Date().toISOString(), symbol, price: d.price,
              tradeSize, signal: r1.signal, triggerSet: r1.triggerSet,
              allPass: true, orderPlaced: false, orderId: null,
              paperTrading: CONFIG.paperTrading, strategy: "S1", score: score1,
              conditions: [{ label: r1.triggerSet, pass: true }],
            };
            console.log(`   🎯 S1 ${r1.signal} | Score:${score1}/${CONFIG.minScoreS1} | $${tradeSize.toFixed(2)}`);
            await placeOrder(exchange, symbol, r1.signal, tradeSize, d.price, entry1);
            log.trades.push(entry1);
            writeCsvRow({ ...entry1, notes: entry1.notes||`S1 ${r1.signal} via ${r1.triggerSet}` });
          } else {
            console.log(`   ⚠️ S1 ${r1.signal} signal but score too low (${score1}<${CONFIG.minScoreS1}) — skipped`);
          }
        } else {
          console.log(`   ⚪ S1: No signal`);
        }
      }

      // S2 execution (simultaneous)
      const s2Count = countTodaysTrades(log, symbol, "S2");
      if (s2Count < CONFIG.maxTradesPerDay) {
        r2.reasons.forEach(r => console.log(`   ${r}`));
        if (r2.allPass && r2.signal) {
          if (score2 >= CONFIG.minScoreS2) {
            const tradeSize2 = Math.min(balance * (alloc.s2Pct/100), CONFIG.maxTradeUSD * 0.5);
            const entry2 = {
              timestamp: new Date().toISOString(), symbol, price: d.price,
              tradeSize: tradeSize2, signal: r2.signal, triggerSet: r2.triggerSet,
              allPass: true, orderPlaced: false, orderId: null,
              paperTrading: CONFIG.paperTrading, strategy: "S2", score: score2,
              conditions: [{ label: r2.triggerSet, pass: true }],
            };
            console.log(`   🎯 S2 ${r2.signal} | Score:${score2}/${CONFIG.minScoreS2} | $${tradeSize2.toFixed(2)}`);
            await placeOrder(exchange, symbol, r2.signal, tradeSize2, d.price, entry2);
            log.trades.push(entry2);
            writeCsvRow({ ...entry2, notes: entry2.notes||`S2 ${r2.signal} via ${r2.triggerSet}` });
          } else {
            console.log(`   ⚪ S2: Signal found but score too low (${score2}<${CONFIG.minScoreS2})`);
          }
        } else {
          console.log(`   ⚪ S2: No signal`);
        }
      }

    } catch (err) {
      console.log(`\n── ${symbol} ❌ ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  saveLog(log);
  saveState(botState);
  console.log(`\n✅ Done | Balance:$${balance.toFixed(2)} | S1 WR:${s1WR} S2 WR:${s2WR}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err.message); process.exit(1); });
