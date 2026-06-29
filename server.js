const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Store session ───
let session = {
  token: null,
  refreshToken: null,
  feedToken: null,
  clientId: null,
  apiKey: null,
  lastLogin: null
};

// ─── TOTP Generator ───
function generateTOTP(secret) {
  try {
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    secret = secret.toUpperCase().replace(/\s/g, '');
    let bits = '';
    for (let i = 0; i < secret.length; i++) {
      const val = base32Chars.indexOf(secret[i]);
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    const key = Buffer.from(bytes);
    const epoch = Math.floor(Date.now() / 1000);
    const timeStep = Math.floor(epoch / 30);
    const timeBuf = Buffer.alloc(8);
    timeBuf.writeBigInt64BE(BigInt(timeStep));
    const hmac = crypto.createHmac('sha1', key).update(timeBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  } catch (e) {
    return null;
  }
}

// ─── Login to Angel One ───
async function loginAngelOne(clientId, password, apiKey, totpSecret) {
  try {
    let totp = totpSecret;
    if (totpSecret && totpSecret.length > 8) {
      totp = generateTOTP(totpSecret);
    }

    const resp = await axios.post(
      'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
      { clientcode: clientId, password: password, totp: totp },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': apiKey
        }
      }
    );

    if (resp.data.status && resp.data.data) {
      session.token = resp.data.data.jwtToken;
      session.refreshToken = resp.data.data.refreshToken;
      session.feedToken = resp.data.data.feedToken;
      session.clientId = clientId;
      session.apiKey = apiKey;
      session.lastLogin = Date.now();
      return { success: true, message: 'Login successful' };
    }
    return { success: false, message: resp.data.message || 'Login failed' };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── Get Option Chain ───
async function getOptionChain(symbol = 'NIFTY', expiry = null) {
  try {
    if (!session.token) return null;

    const resp = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/getCandleData',
      {},
      {
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': session.apiKey
        }
      }
    );
    return resp.data;
  } catch (e) {
    return null;
  }
}

// ─── Get Nifty LTP ───
async function getNiftyLTP() {
  try {
    if (!session.token) return null;

    const resp = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
      {
        mode: 'LTP',
        exchangeTokens: {
          NSE: ['26000']
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': session.apiKey
        }
      }
    );

    if (resp.data.status && resp.data.data) {
      const data = resp.data.data.fetched;
      if (data && data.length > 0) {
        return data[0].ltp;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─── Get Option Chain from NSE (backup) ───
async function getNSEOptionChain(symbol = 'NIFTY') {
  try {
    const resp = await axios.get(
      `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.nseindia.com',
          'Cookie': ''
        },
        timeout: 10000
      }
    );
    return resp.data;
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Options Pro Backend Running',
    connected: !!session.token,
    lastLogin: session.lastLogin
  });
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { clientId, password, apiKey, totpSecret } = req.body;
  if (!clientId || !password || !apiKey) {
    return res.json({ success: false, message: 'clientId, password, apiKey zaroori hain' });
  }
  const result = await loginAngelOne(clientId, password, apiKey, totpSecret);
  res.json(result);
});

// Nifty Spot Price
app.get('/nifty-spot', async (req, res) => {
  try {
    const ltp = await getNiftyLTP();
    if (ltp) {
      res.json({ success: true, spot: ltp, source: 'angelone' });
    } else {
      // Fallback to NSE
      const nseData = await getNSEOptionChain('NIFTY');
      if (nseData && nseData.records) {
        res.json({
          success: true,
          spot: nseData.records.underlyingValue,
          source: 'nse'
        });
      } else {
        res.json({ success: false, message: 'Data unavailable' });
      }
    }
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Full Option Chain Data
app.get('/nifty-option-chain', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'NIFTY';
    const nseData = await getNSEOptionChain(symbol);

    if (!nseData || !nseData.records) {
      return res.json({ success: false, message: 'NSE data unavailable' });
    }

    const spot = nseData.records.underlyingValue;
    const expiries = nseData.records.expiryDates;
    const nearestExpiry = expiries[0];

    // Filter data for nearest expiry
    const chainData = nseData.filtered.data.filter(
      item => item.expiryDate === nearestExpiry
    );

    // Process chain
    const strikes = chainData.map(item => {
      const ce = item.CE || {};
      const pe = item.PE || {};
      return {
        strike: item.strikePrice,
        ce: {
          oi: ce.openInterest || 0,
          oiChange: ce.changeinOpenInterest || 0,
          volume: ce.totalTradedVolume || 0,
          iv: ce.impliedVolatility || 0,
          ltp: ce.lastPrice || 0,
          bid: ce.bidprice || 0,
          ask: ce.askPrice || 0,
          delta: ce.delta || null,
          gamma: ce.gamma || null,
          theta: ce.theta || null,
          vega: ce.vega || null
        },
        pe: {
          oi: pe.openInterest || 0,
          oiChange: pe.changeinOpenInterest || 0,
          volume: pe.totalTradedVolume || 0,
          iv: pe.impliedVolatility || 0,
          ltp: pe.lastPrice || 0,
          bid: pe.bidprice || 0,
          ask: pe.askPrice || 0,
          delta: pe.delta || null,
          gamma: pe.gamma || null,
          theta: pe.theta || null,
          vega: pe.vega || null
        }
      };
    });

    // Calculate PCR
    const totalCeOI = chainData.reduce((s, i) => s + (i.CE?.openInterest || 0), 0);
    const totalPeOI = chainData.reduce((s, i) => s + (i.PE?.openInterest || 0), 0);
    const pcr = totalCeOI > 0 ? totalPeOI / totalCeOI : 0;

    // Max Pain calculation
    let maxPain = spot;
    let minPain = Infinity;
    strikes.forEach(s => {
      let totalLoss = 0;
      strikes.forEach(t => {
        totalLoss += Math.max(0, t.strike - s.strike) * t.ce.oi;
        totalLoss += Math.max(0, s.strike - t.strike) * t.pe.oi;
      });
      if (totalLoss < minPain) { minPain = totalLoss; maxPain = s.strike; }
    });

    res.json({
      success: true,
      spot: spot,
      expiry: nearestExpiry,
      expiries: expiries.slice(0, 5),
      pcr: pcr.toFixed(2),
      maxPain: maxPain,
      totalCeOI: totalCeOI,
      totalPeOI: totalPeOI,
      strikes: strikes,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
  console.log("LOGIN ERROR:", e.response?.data || e.message);
  return {
    success: false,
    message: e.response?.data || e.message
  };
  }

// VIX data
app.get('/vix', async (req, res) => {
  try {
    const resp = await axios.get(
      'https://www.nseindia.com/api/allIndices',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Referer': 'https://www.nseindia.com'
        },
        timeout: 8000
      }
    );
    const vixData = resp.data.data?.find(i => i.index === 'INDIA VIX');
    res.json({
      success: true,
      vix: vixData?.last || null,
      change: vixData?.percentChange || null
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Session status
app.get('/status', (req, res) => {
  res.json({
    connected: !!session.token,
    clientId: session.clientId ? session.clientId.substring(0, 3) + '***' : null,
    lastLogin: session.lastLogin,
    sessionAge: session.lastLogin ? Math.floor((Date.now() - session.lastLogin) / 60000) + ' min' : null
  });
});

// Logout
app.post('/logout', (req, res) => {
  session = { token: null, refreshToken: null, feedToken: null, clientId: null, apiKey: null, lastLogin: null };
  res.json({ success: true, message: 'Logged out' });
});
// Auto Login on Server Start
async function autoLogin() {
  console.log("Starting auto login...");

  const result = await loginAngelOne(
    process.env.CLIENT_CODE,
    process.env.PIN,
    process.env.API_KEY,
    process.env.TOTP_SECRET
  );

  console.log("AUTO LOGIN RESULT:", result);
}

autoLogin();
app.listen(PORT, () => {
  console.log(`Options Pro Backend running on port ${PORT}`);
});
