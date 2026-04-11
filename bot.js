/**
 * TradeBotIQ — Clean & Safe Binance Spot Bot with CCXT
 * Strategy: Your exact VWAP + RSI(3) + EMA sets A-F
 * Toggle: TRADING_ACCOUNT=demo (safe) or live
 * PAPER_TRADING=true recommended at first
 */

import "dotenv/config";
import ccxt from "ccxt";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import cron from "node-cron";

// ─── Config ──────────────────────────────────────────────────────────────────
const IS_DEMO = (process.env.TRADING_ACCOUNT || "demo").toLowerCase() === "demo";
const PAPER_TRADING = process.env.PAPER_TRADING !== "false";

const CONFIG = {
  symbol: process.env.SYMBOL || "BTC/USDT",
  timeframe: process.env.TIMEFRAME || "2h",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_USD || "35"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "31"),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),
  paperTrading: PAPER_TRADING,
  isDemo: IS_DEMO,
};

// ─── Exchange Setup (CCXT) ───────────────────────────────────────────────────
const exchange = new ccxt.binance({
  apiKey: IS_DEMO ? process.env.BINANCE_DEMO_API_KEY : process.env.BINANCE_API_KEY,
  secret: IS_DEMO ? process.env.BINANCE_DEMO_SECRET_KEY : process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  options: { defaultType: "spot", adjustForTimeDifference: true },
});

if (IS_DEMO) {
  exchange.setSandboxMode(true);
  console.log("🧪 Binance Testnet (Demo Mode) Active");
} else if (!PAPER_TRADING) {
  console.log("🔴 Binance LIVE Trading Active — Be careful!");
}

// ─── Files & Logging ─────────────────────────────────────────────────────────
const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE = "trades.csv";

const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

function loadLog() { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, "utf8")) : { trades: [] }; }
function saveLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function writeTradeCsv(entry) {
  const now = new Date(entry.timestamp || Date.now());
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const qty = entry.tradeSize && entry.price ? (entry.tradeSize / entry.price).toFixed(6) : "";
  const fee = entry.tradeSize ? (entry.tradeSize * 0.001).toFixed(4) : "";
  const net = entry.tradeSize && fee ? (entry.tradeSize - parseFloat(fee)).toFixed(2) : "";
  const mode = entry.paperTrading ? "PAPER" : (IS_DEMO ? "DEMO" : "LIVE");
  const notes = entry.exitReason || (entry.allPass ? "Conditions met" : `Blocked: ${entry.failed || ""}`);

  const row = [
    date, time, "Binance", entry.symbol || CONFIG.symbol,
    entry.side || "", qty, entry.price ? entry.price.toFixed(2) : "",
    entry.tradeSize ? entry.tradeSize.toFixed(2) : "", fee, net,
    entry.orderId || "BLOCKED", mode, `"${notes}"`
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Position Tracking & TP/SL ───────────────────────────────────────────────
function loadPositions() {
  return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, "utf8")) : [];
}
function savePositions(pos) { writeFileSync(POSITIONS_FILE, JSON.stringify(pos, null, 2)); }

async function checkAndClosePositions(price) {
  let positions = loadPositions();
  if (positions.length === 0) return;

  console.log("\n── Checking Open Positions ─────────────────────────────\n");
  const remaining = [];

  for (const pos of positions) {
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct / 100);

    console.log(`  Entry: $${pos.entryPrice.toFixed(2)} | Now: $${price.toFixed(2)} | P&L: ${pnlPct.toFixed(2)}%`);

    if (price >= tpPrice || price <= slPrice) {
      const reason = price >= tpPrice ? `TAKE PROFIT (+${CONFIG.takeProfitPct}%)` : `STOP LOSS (-${CONFIG.stopLossPct}%)`;
      console.log(`  ${reason} — closing`);

      if (!CONFIG.paperTrading) {
        try {
          await exchange.createMarketSellOrder(CONFIG.symbol, pos.sizeUSD / price);
          console.log("  ✅ Sell executed on Binance");
        } catch (e) { console.log(`  ❌ Sell failed: ${e.message}`); remaining.push(pos); continue; }
      } else {
        console.log(`  📋 PAPER SELL ~$${pos.sizeUSD.toFixed(2)}`);
      }

      writeTradeCsv({ timestamp: new Date().toISOString(), price, tradeSize: pos.sizeUSD, side: "SELL", exitReason: reason, allPass: true, paperTrading: CONFIG.paperTrading });
    } else {
      remaining.push(pos);
    }
  }
  savePositions(remaining);
}

// ─── Market Data & Indicators (your exact logic) ─────────────────────────────
async function fetchCandles(symbol, timeframe, limit = 1000) {
  const cleanSymbol = symbol.replace("/", "");
  const url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${timeframe}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance error: ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
}

function calcEMA(closes, period) {
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b)=>a+b,0)/period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (!session.length) return null;
  const tpv = session.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol = session.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv / vol : null;
}

// ─── Your Exact Condition Sets A-F ───────────────────────────────────────────
function runConditionSets(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum) {
  const results = [];
  let signal = null;

  const emaStackBull = ema8 > ema21 && ema21 > ema50 && price > ema8;
  const emaStackBear = ema8 < ema21 && ema21 < ema50 && price < ema8;
  const aboveVWAP = price > vwap;
  const belowVWAP = price < vwap;
  const aboveEMA8 = price > ema8;
  const belowEMA8 = price < ema8;
  const rsiOversold = rsi3 < 30;
  const rsiExtreme = rsi3 < 20;
  const rsiOverbought = rsi3 > 70;
  const rsiExtremeBear = rsi3 > 80;
  const posMomentum = momentum > 0;
  const negMomentum = momentum < 0;

  const setA = emaStackBull && aboveVWAP && rsiOversold && volumeConfirmed;
  const setB = emaStackBull && aboveVWAP && strongGreen && posMomentum && aboveEMA8;
  const setC = rsiExtreme && aboveEMA8 && posMomentum && emaStackBull;

  const setD = emaStackBear && belowVWAP && rsiOverbought && volumeConfirmed;
  const setE = emaStackBear && belowVWAP && strongRed && negMomentum && belowEMA8;
  const setF = rsiExtremeBear && belowEMA8 && negMomentum && emaStackBear;

  console.log("\n── Condition Sets ───────────────────────────────────────\n");
  console.log(`  BUY A (Snap-back): ${setA ? "✅" : "🚫"}`);
  console.log(`  BUY B (Momentum):  ${setB ? "✅" : "🚫"}`);
  console.log(`  BUY C (Extreme):   ${setC ? "✅" : "🚫"}`);
  console.log(`  SELL D (Reversal): ${setD ? "✅" : "🚫"}`);
  console.log(`  SELL E (Breakdown):${setE ? "✅" : "🚫"}`);
  console.log(`  SELL F (Overbought):${setF ? "✅" : "🚫"}`);

  const buySignal = setA || setB || setC;
  const sellSignal = setD || setE || setF;

  if (buySignal && !sellSignal) {
    signal = "BUY";
    console.log(`  🟢 STRONG BUY SIGNAL`);
  } else if (sellSignal && !buySignal) {
    signal = "SELL";
    console.log(`  🔴 STRONG SELL SIGNAL`);
  } else {
    console.log(`  ⚪ NEUTRAL — no set triggered`);
  }

  return { results: [], allPass: !!(buySignal || sellSignal), signal };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────
function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);

  if (todayCount >= CONFIG.maxTradesPerDay) return { ok: false, tradeSize: 0 };

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSize);
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)}`);
  return { ok: true, tradeSize };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ — Binance Spot Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} | Account: ${CONFIG.isDemo ? "DEMO (Testnet)" : "LIVE"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const log = loadLog();
  const { ok, tradeSize } = checkTradeLimits(log);
  if (!ok) return;

  console.log("── Fetching market data ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 1000);
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  const volumes = candles.map(c => c.volume);
  const avgVol20 = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const currentVol = volumes[volumes.length-1];
  const volumeConfirmed = currentVol > avgVol20 * 1.1;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const strongGreen = last.close > last.open && (last.close - last.open) > (last.high - last.low) * 0.6;
  const strongRed = last.close < last.open && (last.open - last.close) > (last.high - last.low) * 0.6;
  const momentum = last.close - prev.close;

  console.log(`  Price: $${price.toFixed(2)} | RSI(3): ${rsi3?.toFixed(2)} | VWAP: $${vwap?.toFixed(2)}`);
  console.log(`  Volume: ${currentVol.toFixed(2)} (avg ${avgVol20.toFixed(2)}) ${volumeConfirmed ? "✅" : "⚠️"}`);

  await checkAndClosePositions(price);

  const { allPass, signal } = runConditionSets(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    price,
    tradeSize,
    allPass,
    side: signal,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (allPass && signal) {
    console.log(`✅ CONDITIONS MET — ${signal} signal`);
    if (CONFIG.paperTrading) {
      console.log(`📋 PAPER ${signal} — $${tradeSize.toFixed(2)} of ${CONFIG.symbol}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      try {
        const qty = (tradeSize / price).toFixed(6);
        const order = signal === "BUY"
          ? await exchange.createMarketBuyOrder(CONFIG.symbol, qty)
          : await exchange.createMarketSellOrder(CONFIG.symbol, qty);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.id;
        console.log(`✅ LIVE ORDER PLACED — ID: ${order.id}`);
      } catch (err) {
        console.log(`❌ Order failed: ${err.message}`);
        logEntry.error = err.message;
      }
    }

    // Save position for TP/SL
    if (logEntry.orderPlaced && signal === "BUY") {
      const positions = loadPositions();
      positions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
      savePositions(positions);
    }
  } else {
    console.log("🚫 TRADE BLOCKED");
  }

  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);

  console.log(`\nLogs saved → ${LOG_FILE} | ${CSV_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => console.error("Bot error:", err.message));

// Schedule every 2 hours (matches 2H timeframe)
cron.schedule('0 */2 * * *', run);
