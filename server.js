const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
let session = { jwtToken: null, refreshToken: null, lastLogin: null };
let nseCookie = ''; let cookieTime = 0;
function generateTOTP(secret) {
  try {
    const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    secret = secret.toUpperCase().replace(/\s+/g, '').replace(/=/g, '');
    let bits = '';
    for (let i = 0; i < secret.length; i++) { const v = base32.indexOf(secret[i]); if (v === -1) continue; bits += v.toString(2).padStart(5, '0'); }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    const key = Buffer.from(bytes);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset+1] & 0xff) << 16) | ((hmac[offset+2] & 0xff) << 8) | (hmac[offset+3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
  } catch(e) { console.log('TOTP err:', e.message); return null; }
}
async function loginAngelOne() {
  try {
    const { CLIENT_CODE, PIN, API_KEY, TOTP_SECRET } = process.env;
    if (!CLIENT_CODE || !PIN || !API_KEY || !TOTP_SECRET) { console.log('Missing env vars'); return false; }
    const totp = generateTOTP(TOTP_SECRET);
    if (!totp) { console.log('TOTP failed'); return false; }
    console.log('Logging into Angel One, TOTP:', totp);
    const resp = await axios.post('https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword', { clientcode: CLIENT_CODE, password: PIN, totp }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': API_KEY }, timeout: 15000 });
    if (resp.data.status && resp.data.data) { session.jwtToken = resp.data.data.jwtToken; session.refreshToken = resp.data.data.refreshToken; session.lastLogin = Date.now(); console.log('Angel One LOGIN SUCCESS'); return true; }
    console.log('Login failed:', resp.data.message); return false;
  } catch(e) { console.log('Login error:', e.message); return false; }
}
async function getNSECookie() {
  if (Date.now() - cookieTime < 240000 && nseCookie) return;
  try {
    const r = await axios.get('https://www.nseindia.com/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' }, timeout: 12000 });
    const c = r.headers['set-cookie'];
    if (c) { nseCookie = c.map(x => x.split(';')[0]).join('; '); cookieTime = Date.now(); }
    await axios.get('https://www.nseindia.com/option-chain', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://www.nseindia.com/', 'Cookie': nseCookie }, timeout: 12000 });
    console.log('NSE cookie refreshed');
  } catch(e) { console.log('NSE cookie err:', e.message); }
}
async function nseGet(endpoint) {
  await getNSECookie();
  const r = await axios.get('https://www.nseindia.com/api/' + endpoint, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/option-chain', 'Cookie': nseCookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15000 });
  return r.data;
}
async function getAOQuote(tokens) {
  if (!session.jwtToken) return null;
  if (Date.now() - session.lastLogin > 8 * 60 * 60 * 1000) await loginAngelOne();
  try {
    const resp = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', { mode: 'FULL', exchangeTokens: { NSE: tokens } }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1', 'X-MACAddress': '00:00:00:00:00:00', 'X-PrivateKey': process.env.API_KEY, 'Authorization': 'Bearer ' + session.jwtToken }, timeout: 12000 });
    if (resp.data.status && resp.data.data) return resp.data.data.fetched;
    return null;
  } catch(e) { console.log('AO Quote err:', e.message); return null; }
}
app.get('/', (req, res) => res.json({ status: 'Options Pro Backend — Angel One Edition ✅', angelConnected: !!session.jwtToken, lastLogin: session.lastLogin ? new Date(session.lastLogin).toISOString() : null, sessionAge: session.lastLogin ? Math.floor((Date.now()-session.lastLogin)/60000)+'min' : null }));
app.get('/nifty-spot', async (req, res) => {
  try {
    const quotes = await getAOQuote(['26000', '26009']);
    if (quotes && quotes.length > 0) {
      const nifty = quotes.find(q => q.symbolToken === '26000');
      const bank = quotes.find(q => q.symbolToken === '26009');
      return res.json({ success: true, spot: nifty?.ltp, bankNifty: bank?.ltp, vix: null, change: nifty?.percentChange, source: 'angelone' });
    }
    const d = await nseGet('allIndices');
    const n = d.data?.find(i => i.index === 'NIFTY 50');
    const b = d.data?.find(i => i.index === 'NIFTY BANK');
    const v = d.data?.find(i => i.index === 'INDIA VIX');
    res.json({ success: true, spot: n?.last, bankNifty: b?.last, vix: v?.last, change: n?.percentChange, source: 'nse' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
app.get('/nifty-option-chain', async (req, res) => {
  try {
    const sym = (req.query.symbol || 'NIFTY').toUpperCase();
    const data = await nseGet('option-chain-indices?symbol=' + sym);
    if (!data || !data.records) return res.json({ success: false, message: 'No data' });
    const spot = data.records.underlyingValue;
    const expiries = data.records.expiryDates || [];
    const exp = expiries[0];
    const all = data.filtered?.data || data.records?.data || [];
    const chain = exp ? all.filter(i => i.expiryDate === exp) : all;
    const strikes = chain.map(item => ({ strike: item.strikePrice, ce: { oi: item.CE?.openInterest||0, oiChange: item.CE?.changeinOpenInterest||0, volume: item.CE?.totalTradedVolume||0, iv: item.CE?.impliedVolatility||0, ltp: item.CE?.lastPrice||0, bid: item.CE?.bidprice||0, ask: item.CE?.askPrice||0 }, pe: { oi: item.PE?.openInterest||0, oiChange: item.PE?.changeinOpenInterest||0, volume: item.PE?.totalTradedVolume||0, iv: item.PE?.impliedVolatility||0, ltp: item.PE?.lastPrice||0, bid: item.PE?.bidprice||0, ask: item.PE?.askPrice||0 } }));
    const tce = strikes.reduce((s,i) => s+i.ce.oi, 0);
    const tpe = strikes.reduce((s,i) => s+i.pe.oi, 0);
    const pcr = tce > 0 ? (tpe/tce).toFixed(2) : '1.0';
    let mp = Math.round(spot/50)*50, minP = Infinity;
    strikes.forEach(s => { let l = 0; strikes.forEach(t => { l += Math.max(0,t.strike-s.strike)*t.ce.oi; l += Math.max(0,s.strike-t.strike)*t.pe.oi; }); if (l < minP) { minP = l; mp = s.strike; } });
    res.json({ success: true, spot, expiry: exp, expiries: expiries.slice(0,5), pcr, maxPain: mp, totalCeOI: tce, totalPeOI: tpe, strikes, timestamp: new Date().toISOString() });
  } catch(e) { if (e.response?.status === 401 || e.response?.status === 403) { nseCookie = ''; cookieTime = 0; } res.json({ success: false, message: e.message, code: e.response?.status }); }
});
app.get('/vix', async (req, res) => {
  try { const d = await nseGet('allIndices'); const v = d.data?.find(i => i.index === 'INDIA VIX'); res.json({ success: true, vix: v?.last, change: v?.percentChange }); } catch(e) { res.json({ success: false, message: e.message }); }
});
app.get('/status', (req, res) => res.json({ angelConnected: !!session.jwtToken, sessionAge: session.lastLogin ? Math.floor((Date.now()-session.lastLogin)/60000)+'min' : null }));
app.post('/login', async (req, res) => { const ok = await loginAngelOne(); res.json({ success: ok }); });
setInterval(async () => { if (session.jwtToken) await loginAngelOne(); }, 8*60*60*1000);
setInterval(getNSECookie, 3*60*1000);
loginAngelOne().then(ok => { console.log('Startup login:', ok?'OK':'FAILED'); getNSECookie(); });
app.listen(PORT, () => console.log('Options Pro Backend running on port ' + PORT));
