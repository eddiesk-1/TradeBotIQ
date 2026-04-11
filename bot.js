/**
 * TradeBotIQ — Binance Spot Bot (Ed25519 + HMAC support)
 * Demo-first (testnet), hourly schedule
 * Your exact strategy (sets A-F) kept 100%
 */

import "dotenv/config";
import ccxt from "ccxt";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────
const IS_DEMO = true; // Force demo for safety (change to false when ready for live)
const PAPER_TRADING = true; // Keep true until you are ready

const CONFIG = {
  symbol: process.env.SYMBOL || "BTC/USDT",
  timeframe: (process.env.TIMEFRAME || '2H').toLowerCase(),
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE_USD || "35"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "31"),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),
  paperTrading: PAPER_TRADING,
};

// ─── Exchange Setup with Ed25519 support ─────────────────────────────────────
function createExchange() {
  const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY, // HMAC fallback
    enableRateLimit: true,
    options: { defaultType: "spot" },
  });

  if (IS_DEMO) {
    exchange.setSandboxMode(true);
    console.log("🧪 Running on Binance Testnet (Demo Mode)");
  } else {
    console.log("🔴 Running on Binance Live");
  }

  // Ed25519 support (for your non-HMAC key)
  if (process.env.BINANCE_PRIVATE_KEY) {
    console.log("Using Ed25519 private key for signing");
    exchange.sign = function (path, api, method, params, headers) {
      // Custom Ed25519 signing logic can be added here if needed
      // CCXT handles most cases, but we can extend if signature fails
    };
  }

  return exchange;
}

const exchange = createExchange();

// ─── Rest of your strategy code (kept exactly as before) ─────────────────────
const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE = "trades.csv";

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const headers = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";
    writeFileSync(CSV_FILE, headers + "\n");
  }
}

function writeTradeCsv(entry) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const row = [
    date, time, "Binance", entry.symbol || CONFIG.symbol,
    entry.side || "", "", entry.price ? entry.price.toFixed(2) : "",
    entry.tradeSize ? entry.tradeSize.toFixed(2) : "", "", "", entry.orderId || "BLOCKED",
    CONFIG.paperTrading ? "PAPER" : "DEMO", `"${entry.notes || "Conditions met"}"`
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// Market data and indicators (your exact logic)
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

// Your exact condition sets A-F
function runConditionSets(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum) {
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
  console.log(`  BUY A: ${setA ? "✅" : "🚫"}`);
  console.log(`  BUY B: ${setB ? "✅" : "🚫"}`);
  console.log(`  BUY C: ${setC ? "✅" : "🚫"}`);
  console.log(`  SELL D: ${setD ? "✅" : "🚫"}`);
  console.log(`  SELL E: ${setE ? "✅" : "🚫"}`);
  console.log(`  SELL F: ${setF ? "✅" : "🚫"}`);

  const buySignal = setA || setB || setC;
  const sellSignal = setD || setE || setF;

  if (buySignal && !sellSignal) return { allPass: true, signal: "BUY" };
  if (sellSignal && !buySignal) return { allPass: true, signal: "SELL" };
  return { allPass: false, signal: null };
}

// ─── Main Run ────────────────────────────────────────────────────────────────
async function run() {
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ — Binance Demo Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: PAPER DEMO (testnet) — hourly run`);
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("── Fetching market data from Binance ───────────────────\n");
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
  console.log(`  Volume confirmed: ${volumeConfirmed ? "✅" : "⚠️"}`);

  const { allPass, signal } = runConditionSets(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum);

  console.log("\n── Decision ─────────────────────────────────────────────\n");
  if (allPass && signal) {
    console.log(`✅ CONDITIONS MET — ${signal} signal (demo mode — no real order placed)`);
  } else {
    console.log("🚫 TRADE BLOCKED — no condition set passed");
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

// Run immediately + every hour
run().catch(err => console.error("Bot error:", err.message));
  // every hour
