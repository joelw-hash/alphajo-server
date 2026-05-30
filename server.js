// ════════════════════════════════════════════════════════════
//  AlphaJo Bitvavo Order Server  +  POSITIE-BEWAKER
//  ────────────────────────────────────────────────────────────
//  Doet twee dingen:
//   1. Plaatst echte orders op Bitvavo (HMAC-ondertekend)
//   2. BEWAAKT je open posities 24/7 server-side: sluit automatisch
//      bij stop-loss / take-profit / trailing — OOK als je telefoon
//      of pc uit staat. Dit is de veiligste manier.
// ════════════════════════════════════════════════════════════
//
//  ⚠️ BELANGRIJK: deze server bewaart je secret key in het geheugen
//     zolang er een positie open staat (nodig om die positie
//     autonoom te kunnen sluiten). Host hem daarom alleen op JOUW
//     eigen Render/Railway account. Deel de URL met niemand.
// ════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const BITVAVO_API = 'https://api.bitvavo.com/v2';
const POS_FILE = '/tmp/alphajo_positions.json';   // simpele opslag
const MAX_ORDER_EUR = 25;                         // veiligheidslimiet per order

// ── TELEGRAM MELDINGEN (optioneel) ──
// Vul deze in op Render onder "Environment" of hieronder direct.
// Hoe je deze krijgt staat in de stappen-gids.
const TG_TOKEN = process.env.TG_TOKEN || '';   // bot token van @BotFather
const TG_CHAT  = process.env.TG_CHAT  || '';   // jouw chat id

async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT) return; // niet geconfigureerd = stil
  try {
    await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('Telegram fout:', e.message); }
}

// ── Exit-regels (zelfde als in de bot) ──
const STOP_LOSS_PCT = 0.25;   // -25%
const TAKE_PROFIT_PCT = 0.20; // +20%
const TRAIL_ACT = 0.08;       // trailing start bij +8%
const TRAIL_PCT = 0.05;       // trailing afstand 5%
const MAX_HOLD_MS = 5 * 60 * 1000; // 5 min

// ════════════════════════════════════════════════════════════
//  HMAC ondertekening (Bitvavo specificatie)
// ════════════════════════════════════════════════════════════
function signRequest(secret, timestamp, method, urlPath, body) {
  let str = timestamp + method + '/v2' + urlPath;
  if (body && Object.keys(body).length > 0) str += JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(str).digest('hex');
}

async function bitvavoBuy(apiKey, apiSecret, market, amountQuote) {
  const timestamp = Date.now();
  const body = {
    market,
    side: 'buy',
    orderType: 'market',
    amountQuote: String(amountQuote),
    operatorId: 10001   // verplicht door Bitvavo (eigen getal, voor audit trail)
  };
  const signature = signRequest(apiSecret, timestamp, 'POST', '/order', body);
  const r = await fetch(BITVAVO_API + '/order', {
    method: 'POST',
    headers: {
      'Bitvavo-Access-Key': apiKey,
      'Bitvavo-Access-Signature': signature,
      'Bitvavo-Access-Timestamp': String(timestamp),
      'Bitvavo-Access-Window': '10000',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Sluit een positie door de aangehouden hoeveelheid coin te verkopen
async function bitvavoSell(apiKey, apiSecret, market, amountBase) {
  const timestamp = Date.now();
  const body = {
    market,
    side: 'sell',
    orderType: 'market',
    amount: String(amountBase),
    operatorId: 10001   // verplicht door Bitvavo
  };
  const signature = signRequest(apiSecret, timestamp, 'POST', '/order', body);
  const r = await fetch(BITVAVO_API + '/order', {
    method: 'POST',
    headers: {
      'Bitvavo-Access-Key': apiKey,
      'Bitvavo-Access-Signature': signature,
      'Bitvavo-Access-Timestamp': String(timestamp),
      'Bitvavo-Access-Window': '10000',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function getPrice(market) {
  const r = await fetch(BITVAVO_API + '/ticker/price?market=' + market);
  const d = await r.json();
  return parseFloat(d.price);
}

// ════════════════════════════════════════════════════════════
//  POSITIE-OPSLAG (overleeft herstart zolang /tmp blijft bestaan)
// ════════════════════════════════════════════════════════════
let positions = [];
function loadPositions() {
  try { positions = JSON.parse(fs.readFileSync(POS_FILE, 'utf8')); } catch (e) { positions = []; }
}
function savePositions() {
  try { fs.writeFileSync(POS_FILE, JSON.stringify(positions)); } catch (e) {}
}
loadPositions();

// ════════════════════════════════════════════════════════════
//  ENDPOINTS
// ════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'AlphaJo server + positie-bewaker draait OK',
    bewaaktePosities: positions.length,
    time: new Date().toISOString(),
  });
});

// Plaats koop-order EN registreer de positie voor bewaking
app.post('/order', async (req, res) => {
  try {
    const { apiKey, apiSecret, market, side, amountQuote } = req.body;
    if (!apiKey || !apiSecret || !market || !side) return res.status(400).json({ error: 'Ontbrekende velden' });
    if (parseFloat(amountQuote) > MAX_ORDER_EUR) return res.status(400).json({ error: 'Veiligheidslimiet: max EUR ' + MAX_ORDER_EUR });

    if (side === 'buy') {
      const data = await bitvavoBuy(apiKey, apiSecret, market, amountQuote);
      console.log('[' + new Date().toISOString() + '] BUY ' + market + ' EUR' + amountQuote + ' -> ' + (data.orderId || data.error));
      if (data.orderId) {
        const entryPrice = parseFloat(data.price) || await getPrice(market);
        const filledBase = parseFloat(data.filledAmount) || (parseFloat(amountQuote) / entryPrice);
        positions.push({
          market, apiKey, apiSecret,
          entryPrice, amountBase: filledBase,
          openTime: Date.now(), highWater: entryPrice, trailStop: null,
        });
        savePositions();
        console.log('  -> positie geregistreerd voor bewaking: ' + market + ' @ ' + entryPrice);
        notify('🟢 <b>GEKOCHT</b>\n' + market + ' voor €' + amountQuote + '\nEntry: €' + entryPrice + '\n🛡️ Server bewaakt nu SL/TP automatisch.');
      }
      return res.json(data);
    } else {
      // directe verkoop op verzoek van de bot
      const pos = positions.find(p => p.market === market);
      let amountBase = pos ? pos.amountBase : null;

      // Niet bekend bij server? Haal de echte coin-hoeveelheid op via Bitvavo balans
      if (!amountBase) {
        try {
          const coin = market.split('-')[0];
          const ts2 = Date.now();
          const sig2 = signRequest(apiSecret, ts2, 'GET', '/balance', null);
          const balRes = await fetch(BITVAVO_API + '/balance', {
            headers: { 'Bitvavo-Access-Key': apiKey, 'Bitvavo-Access-Signature': sig2, 'Bitvavo-Access-Timestamp': String(ts2), 'Bitvavo-Access-Window': '10000' }
          });
          const balData = await balRes.json();
          const coinBal = Array.isArray(balData) ? balData.find(b => b.symbol === coin) : null;
          amountBase = coinBal ? parseFloat(coinBal.available) : null;
          if (amountBase) console.log('Hoeveelheid opgezocht via balans: ' + coin + ' = ' + amountBase);
        } catch (e) { console.error('Balans ophalen mislukt:', e.message); }
      }

      if (!amountBase || amountBase <= 0) {
        return res.status(404).json({ error: 'Geen ' + market.split('-')[0] + ' beschikbaar om te verkopen' });
      }
      const data = await bitvavoSell(apiKey, apiSecret, market, amountBase);
      positions = positions.filter(p => p.market !== market);
      savePositions();
      return res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Handmatig sluiten via de server
app.post('/close', async (req, res) => {
  try {
    const { market } = req.body;
    const pos = positions.find(p => p.market === market);
    if (!pos) return res.status(404).json({ error: 'Geen bewaakte positie voor ' + market });
    const data = await bitvavoSell(pos.apiKey, pos.apiSecret, market, pos.amountBase);
    positions = positions.filter(p => p.market !== market);
    savePositions();
    res.json({ closed: true, result: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bekijk bewaakte posities
app.get('/positions', (req, res) => {
  res.json(positions.map(p => ({
    market: p.market, entryPrice: p.entryPrice, amountBase: p.amountBase,
    openMinutes: ((Date.now() - p.openTime) / 60000).toFixed(1),
  })));
});

app.post('/balance', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body;
    const timestamp = Date.now();
    const signature = signRequest(apiSecret, timestamp, 'GET', '/balance', null);
    const r = await fetch(BITVAVO_API + '/balance', {
      headers: {
        'Bitvavo-Access-Key': apiKey,
        'Bitvavo-Access-Signature': signature,
        'Bitvavo-Access-Timestamp': String(timestamp),
        'Bitvavo-Access-Window': '10000',
      },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  DE BEWAKER — draait elke 10 seconden, ook als je telefoon uit is
//  Sluit posities automatisch bij SL / TP / trailing / tijdslimiet
// ════════════════════════════════════════════════════════════
async function monitorLoop() {
  for (const pos of [...positions]) {
    try {
      const price = await getPrice(pos.market);
      if (!price) continue;
      const pct = (price - pos.entryPrice) / pos.entryPrice;
      let reden = null;

      if (pct >= TAKE_PROFIT_PCT) reden = 'Take-profit +' + (pct * 100).toFixed(1) + '%';
      else if (pct <= -STOP_LOSS_PCT) reden = 'Stop-loss ' + (pct * 100).toFixed(1) + '%';
      else if (pct >= TRAIL_ACT) {
        if (price > pos.highWater) { pos.highWater = price; pos.trailStop = price * (1 - TRAIL_PCT); savePositions(); }
        if (pos.trailStop && price <= pos.trailStop) reden = 'Trailing stop +' + (((pos.trailStop - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1) + '%';
      }
      if (!reden && (Date.now() - pos.openTime) >= MAX_HOLD_MS && pct < TRAIL_ACT * 0.3) reden = 'Tijdslimiet 5 min';

      if (reden) {
        console.log('[' + new Date().toISOString() + '] AUTO-SLUIT ' + pos.market + ' (' + reden + ') @ ' + price);
        const result = await bitvavoSell(pos.apiKey, pos.apiSecret, pos.market, pos.amountBase);
        console.log('  -> verkoop resultaat: ' + (result.orderId || result.error));
        const winst = ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
        const emoji = parseFloat(winst) >= 0 ? '💰' : '🔴';
        notify(emoji + ' <b>AUTOMATISCH GESLOTEN</b>\n' + pos.market + '\nReden: ' + reden + '\nResultaat: ' + (winst >= 0 ? '+' : '') + winst + '%\nEntry €' + pos.entryPrice.toFixed(4) + ' → €' + price.toFixed(4));
        positions = positions.filter(p => p.market !== pos.market);
        savePositions();
      }
    } catch (e) {
      console.error('Monitor fout voor ' + pos.market + ': ' + e.message);
    }
  }
}
setInterval(monitorLoop, 10000); // elke 10 seconden

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('AlphaJo server + bewaker draait op poort ' + PORT + ' - bewaakt ' + positions.length + ' posities');
  notify('🤖 <b>AlphaJo server gestart</b>\nDe positie-bewaker is actief en klaar om te traden.');
});

/* ════════════════════════════════════════════════════════════
   INSTALLATIE — zie de stappen-gids. Kort:
   1. Account op render.com -> New Web Service -> upload deze map
   2. Build: npm install   |   Start: node server.js
   3. Kopieer de URL -> plak in de bot bij "Server URL"

   LET OP: gratis Render-servers vallen na ~15 min inactiviteit in slaap.
   Dan stopt OOK de bewaker. Oplossingen:
     A) Gratis keep-alive ping (cron-job.org elke 10 min je URL openen)
     B) Goedkoopste betaalde Render-plan (~$7/mnd) voor echte 24/7
   ════════════════════════════════════════════════════════════ */
