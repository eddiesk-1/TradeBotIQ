import { readFileSync, writeFileSync } from 'fs';
let code = readFileSync('bot.js', 'utf8');

// 1. Update config to support both accounts
code = code.replace(
`  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    privateKeyPath: process.env.BINANCE_PRIVATE_KEY_PATH || "/app/private_key.pem",
    baseUrl: "https://api.binance.com",
  },`,
`  tradingAccount: process.env.TRADING_ACCOUNT || "demo",
  binance: {
    apiKey: process.env.TRADING_ACCOUNT === "live"
      ? process.env.BINANCE_API_KEY
      : process.env.BINANCE_DEMO_API_KEY,
    privateKeyPath: process.env.BINANCE_PRIVATE_KEY_PATH || "/app/private_key.pem",
    baseUrl: process.env.TRADING_ACCOUNT === "live"
      ? "https://api.binance.com"
      : "https://testnet.binance.vision",
  },`
);

// 2. Log which account is active at startup
code = code.replace(
  '`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`',
  '`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"} | Account: ${CONFIG.tradingAccount.toUpperCase()}`'
);

writeFileSync('bot.js', code);
console.log('✅ Dual account support added — demo and live');
