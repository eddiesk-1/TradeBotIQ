import { readFileSync, writeFileSync } from 'fs';
let code = readFileSync('bot.js', 'utf8');

// 1. Add 3H interval + change default timeframe
code = code.replace('"4H": "4h",', '"3H": "3h",\n    "4H": "4h",');
code = code.replace('TIMEFRAME || "4H"', 'TIMEFRAME || "3H"');
code = code.replace('"TIMEFRAME=4H"', '"TIMEFRAME=3H"');

// 2. Add TP/SL config
code = code.replace(
  'tradeMode: process.env.TRADE_MODE || "spot",',
  `tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "2.0"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),`
);

// 3. Add POSITIONS_FILE constant
code = code.replace(
  'const LOG_FILE = "safety-check-log.json";',
  `const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";`
);

// 4. Add position tracking + exit logic functions
const positionFunctions = `
// ─── Position Tracking & Exit Logic ─────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

async function checkAndClosePositions(price) {
  const positions = loadPositions();
  if (positions.length === 0) return;

  console.log("\\n── Checking Open Positions ─────────────────────────────\\n");

  const remaining = [];

  for (const pos of positions) {
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlUSD = (pnlPct / 100) * pos.sizeUSD;
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct / 100);

    console.log(\`  Position: \${pos.symbol} | Entry: $\${pos.entryPrice.toFixed(2)} | Now: $\${price.toFixed(2)}\`);
    console.log(\`  P&L: \${pnlPct.toFixed(2)}% ($\${pnlUSD.toFixed(4)}) | TP: $\${tpPrice.toFixed(2)} | SL: $\${slPrice.toFixed(2)}\`);

    const hitTP = price >= tpPrice;
    const hitSL = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP
        ? \`✅ TAKE PROFIT hit (+\${CONFIG.takeProfitPct}%)\`
        : \`🛑 STOP LOSS hit (-\${CONFIG.stopLossPct}%)\`;
      console.log(\`  \${reason} — closing position\`);

      if (!CONFIG.paperTrading) {
        try {
          await placeBitGetOrder(pos.symbol, "sell", pos.sizeUSD, price);
          console.log(\`  ✅ Sell order placed on Bitget\`);
        } catch (err) {
          console.log(\`  ❌ Sell order failed: \${err.message}\`);
          remaining.push(pos);
          continue;
        }
      } else {
        console.log(\`  📋 PAPER SELL — would sell \${pos.symbol} ~$\${pos.sizeUSD.toFixed(2)} at $\${price.toFixed(2)}\`);
      }

      writeTradeCsv({
        timestamp: new Date().toISOString(),
        symbol: pos.symbol,
        price,
        tradeSize: pos.sizeUSD,
        allPass: true,
        paperTrading: CONFIG.paperTrading,
        orderPlaced: true,
        orderId: \`EXIT-\${Date.now()}\`,
        conditions: [],
        side: "SELL",
        pnlPct: pnlPct.toFixed(2),
        exitReason: hitTP ? "TAKE_PROFIT" : "STOP_LOSS",
      });
    } else {
      console.log(\`  ⏳ Holding — TP not reached yet (need +\${CONFIG.takeProfitPct}%) | SL at $\${slPrice.toFixed(2)}\`);
      remaining.push(pos);
    }
  }

  savePositions(remaining);
}

`;

code = code.replace(
  '// ─── Market Data (Binance public API — free, no auth) ───────────────────────',
  positionFunctions + '// ─── Market Data (Binance public API — free, no auth) ───────────────────────'
);

// 5. Fix writeTradeCsv to support SELL side
code = code.replace(
  '    side = "BUY";\n    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);\n    totalUSD = logEntry.tradeSize.toFixed(2);\n    fee = (logEntry.tradeSize * 0.001).toFixed(4);\n    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);\n    orderId = logEntry.orderId || "";\n    mode = "PAPER";',
  '    side = logEntry.side || "BUY";\n    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);\n    totalUSD = logEntry.tradeSize.toFixed(2);\n    fee = (logEntry.tradeSize * 0.001).toFixed(4);\n    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);\n    orderId = logEntry.orderId || "";\n    mode = logEntry.side === "SELL" ? `PAPER-EXIT(${logEntry.exitReason})` : "PAPER";'
);

code = code.replace(
  '    side = "BUY";\n    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);\n    totalUSD = logEntry.tradeSize.toFixed(2);\n    fee = (logEntry.tradeSize * 0.001).toFixed(4);\n    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);\n    orderId = logEntry.orderId || "";\n    mode = "LIVE";',
  '    side = logEntry.side || "BUY";\n    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);\n    totalUSD = logEntry.tradeSize.toFixed(2);\n    fee = (logEntry.tradeSize * 0.001).toFixed(4);\n    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);\n    orderId = logEntry.orderId || "";\n    mode = logEntry.side === "SELL" ? `LIVE-EXIT(${logEntry.exitReason})` : "LIVE";'
);

// 6. Check exits at start of run before entry logic
code = code.replace(
  '  // Run safety check\n  const { results, allPass } = runSafetyCheck',
  `  // Check and close existing positions first
  await checkAndClosePositions(price);

  // Run safety check
  const { results, allPass } = runSafetyCheck`
);

// 7. Save position after paper buy
code = code.replace(
  "logEntry.orderPlaced = true;\n      logEntry.orderId = `PAPER-${Date.now()}`;",
  "logEntry.orderPlaced = true;\n      logEntry.orderId = `PAPER-${Date.now()}`;\n      const paperPositions = loadPositions();\n      paperPositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });\n      savePositions(paperPositions);"
);

// 8. Save position after live buy
code = code.replace(
  "logEntry.orderPlaced = true;\n        logEntry.orderId = order.orderId;\n        console.log(`✅ ORDER PLACED — ${order.orderId}`);",
  "logEntry.orderPlaced = true;\n        logEntry.orderId = order.orderId;\n        console.log(`✅ ORDER PLACED — ${order.orderId}`);\n        const livePositions = loadPositions();\n        livePositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });\n        savePositions(livePositions);"
);

writeFileSync('bot.js', code);
console.log('✅ bot.js patched — exit logic, TP/SL, position tracking + 3H interval added');
