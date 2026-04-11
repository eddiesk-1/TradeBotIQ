import { readFileSync, writeFileSync } from 'fs';
let code = readFileSync('bot.js', 'utf8');

// 1. Replace Bitget config with Binance config
code = code.replace(
`  tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },`,
`  tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    privateKeyPath: process.env.BINANCE_PRIVATE_KEY_PATH || "/app/private_key.pem",
    baseUrl: "https://api.binance.com",
  },`
);

// 2. Replace Bitget execution section with Binance
const bitgetStart = code.indexOf('// ─── BitGet Execution ─');
const bitgetEnd = code.indexOf('// ─── Tax CSV Logging ─');
const binanceCode = `// ─── Binance Execution ──────────────────────────────────────────────────────

import { createPrivateKey, sign } from "crypto";

function signBinance(queryString) {
  const privateKeyPem = readFileSync(CONFIG.binance.privateKeyPath, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(queryString), privateKey);
  return signature.toString("base64url");
}

async function placeBinanceOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(5);
  const timestamp = Date.now();

  // Binance spot uses BTC not BTCUSDT for quantity
  const params = [
    \`symbol=\${symbol}\`,
    \`side=\${side.toUpperCase()}\`,
    \`type=MARKET\`,
    \`quantity=\${quantity}\`,
    \`timestamp=\${timestamp}\`,
  ].join("&");

  const signature = signBinance(params);
  const url = \`\${CONFIG.binance.baseUrl}/api/v3/order?\${params}&signature=\${signature}\`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": CONFIG.binance.apiKey,
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(\`Binance order failed: \${data.msg}\`);
  }

  return { orderId: data.orderId, fills: data.fills };
}

`;

code = code.slice(0, bitgetStart) + binanceCode + code.slice(bitgetEnd);

// 3. Update all placeBitGetOrder calls to placeBinanceOrder
code = code.replaceAll('placeBitGetOrder', 'placeBinanceOrder');

// 4. Update onboarding check
code = code.replace(
  'const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];',
  'const required = ["BINANCE_API_KEY"];'
);

// 5. Update .env template
code = code.replace(
`        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",`,
`        "# Binance credentials",
        "BINANCE_API_KEY=",
        "BINANCE_PRIVATE_KEY_PATH=/app/private_key.pem",`
);

writeFileSync('bot.js', code);
console.log('✅ Bot recoded — Bitget removed, Binance Ed25519 added');
