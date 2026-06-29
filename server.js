const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;
let nseCookie = '';
let cookieTime = 0;
async function getSession() {
  try {
    if (Date.now() - cookieTime < 240000 && nseCookie) return;
    const r = await axios.get('https://www.nseindia.com/', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, timeout: 15000 });
    const c = r.headers['set-cookie'];
    if (c) { nseCookie = c.map(x => x.split(';')[0]).join('; '); cookieTime = Date.now(); }
    await axios.get('https://www.nseindia.com/option-chain', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Referer': 'https://www.nseindia.com/', 'Cookie': nseCookie }, timeout: 15000 });
    console.log('NSE session OK');
  } catch(e) { console.log('Session err:', e.message); }
}
async function nse(ep) {
  await getSession();
  const r = await axios.get('https://www.nseindia.com/api/' + ep, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/option-chain', 'Cookie': nseCookie, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15000 });
  return r.data;
}
app.get('/', (req, res) => res.json({ status: 'Options Pro Backend Running', session: !!nseCookie, time: new Date().toISOString() }));
app.get('/nifty-spot', async (req, res) => {
  try {
    const d = await nse('allIndices');
    const n = d.data?.find(i => i.index === 'NIFTY 50');
    const b = d.data?.find(i => i.index === 'NIFTY BANK');
    const v = d.data?.find(i => i.index === 'INDIA VIX');
    res.json({ success: true, spot: n?.last, bankNifty: b?.last, vix: v?.last, change: n?.percentChange });
  } catch(e) { nseCookie = ''; cookieTime = 0; res.json({ success: false, message: e.message }); }
});
app.get('/nifty-option-chain', async (req, res) => {
  try {
    const sym = (req.query.symbol || 'NIFTY').toUpperCase();
    const d = await nse('option-chain-indices?symbol=' + sym);
    if (!d || !d.records) return res.json({ success: false, message: 'No data' });
    const spot = d.records.underlyingValue;
    const expiries = d.records.expiryDates || [];
    const exp = expiries[0];
    const all = d.filtered?.data || d.records?.data || [];
    const chain = exp ? all.filter(i => i.expiryDate === exp) : all;
    const strikes = chain.map(item => ({ strike: item.strikePrice, ce: { oi: item.CE?.openInterest || 0, oiChange: item.CE?.changeinOpenInterest || 0, volume: item.CE?.totalTradedVolume || 0, iv: item.CE?.impliedVolatility || 0, ltp: item.CE?.lastPrice || 0, bid: item.CE?.bidprice || 0, ask: item.CE?.askPrice || 0 }, pe: { oi: item.PE?.openInterest || 0, oiChange: item.PE?.changeinOpenInterest || 0, volume: item.PE?.totalTradedVolume || 0, iv: item.PE?.impliedVolatility || 0, ltp: item.PE?.lastPrice || 0, bid: item.PE?.bidprice || 0, ask: item.PE?.askPrice || 0 } }));
    const tce = strikes.reduce((s, i) => s + i.ce.oi, 0);
    const tpe = strikes.reduce((s, i) => s + i.pe.oi, 0);
    const pcr = tce > 0 ? (tpe / tce).toFixed(2) : '1.0';
    let mp = Math.round(spot / 50) * 50, minP = Infinity;
    strikes.forEach(s => { let l = 0; strikes.forEach(t => { l += Math.max(0, t.strike - s.strike) * t.ce.oi; l += Math.max(0, s.strike - t.strike) * t.pe.oi; }); if (l < minP) { minP = l; mp = s.strike; } });
    res.json({ success: true, spot, expiry: exp, expiries: expiries.slice(0, 5), pcr, maxPain: mp, totalCeOI: tce, totalPeOI: tpe, strikes, timestamp: new Date().toISOString() });
  } catch(e) { nseCookie = ''; cookieTime = 0; res.json({ success: false, message: e.message, code: e.response?.status }); }
});
app.get('/vix', async (req, res) => {
  try {
    const d = await nse('allIndices');
    const v = d.data?.find(i => i.index === 'INDIA VIX');
    res.json({ success: true, vix: v?.last, change: v?.percentChange });
  } catch(e) { res.json({ success: false, message: e.message }); }
});
setInterval(getSession, 180000);
getSession();
app.listen(PORT, () => console.log('Backend running on port ' + PORT));
