'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const URL = 'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALIASES = {
  GOLD: 'XAUUSD', 'XAU/EUR': 'XAUUSD', SILVER: 'XAGUSD', 'XAG/EUR': 'XAGUSD',
  BITCOIN: 'BTCUSD', 'BITCOIN ETF': 'BTCUSD', ETHEREUM: 'ETHUSD', SOLANA: 'SOLUSD',
  LITECOIN: 'LTCUSD', DOGECOIN: 'DOGEUSD', CARDANO: 'ADAUSD', POLYGON: 'MATICUSD',
  AVALANCHE: 'AVAXUSD', POLKADOT: 'DOTUSD', CHAINLINK: 'LINKUSD', TONCOIN: 'TONUSD',
  TRON: 'TRXUSD', BNB: 'BNBUSD', DASH: 'DASHUSD', 'BRENT OIL': 'UKOUSD',
  'WTI CRUDE OIL': 'USOUSD', 'NATURAL GAS': 'NGAS', APPLE: '#AAPL', TESLA: '#TSLA',
  MICROSOFT: '#MSFT', AMAZON: '#AMZN', NETFLIX: '#NFLX', INTEL: '#INTC',
  'FACEBOOK INC': '#FB', US100: 'USNDAQ100', SP500: 'SP500', DJI30: 'US30', JPN225: 'JPN225'
};

function demoToken() {
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function toSymbol(name) {
  let raw = String(name || '').trim();
  const otc = /\bOTC\b/i.test(raw);
  raw = raw.replace(/\s+OTC$/i, '').replace(/\s+spot$/i, '').trim();
  const upper = raw.toUpperCase();
  let base = ALIASES[upper];
  if (!base) base = raw.replace(/\//g, '').replace(/\s+/g, '').toUpperCase();
  if (otc && !/_otc$/i.test(base)) return base + '_otc';
  return base;
}

function asCandles(rows) {
  return (rows || []).map(function (row) {
    const time = Number(row[0]);
    const open = Number(row[1]);
    const close = Number(row[2]);
    const high = Number(row[3]);
    const low = Number(row[4]);
    return {
      t: time < 10000000000 ? time * 1000 : time,
      time: time,
      open: open,
      high: high,
      low: low,
      close: close
    };
  }).filter(function (c) {
    return isFinite(c.open) && isFinite(c.close) && c.close > 0;
  }).sort(function (a, b) { return a.time - b.time; });
}

function asTicks(history) {
  return (history || []).map(function (row) {
    if (!Array.isArray(row) || row.length < 2) return null;
    var time = Number(row[0]);
    var price = Number(row[1]);
    if (!(price > 0)) {
      time = Number(row[1]);
      price = Number(row[2]);
    }
    if (!(price > 0) || !isFinite(time)) return null;
    return { t: time < 10000000000 ? time * 1000 : time, price: price };
  }).filter(Boolean).sort(function (a, b) { return a.t - b.t; }).slice(-80);
}

function applyLiveTick(candles, history) {
  if (!candles.length || !history || !history.length) return candles[candles.length - 1] ? candles[candles.length - 1].close : null;
  var tick = history.slice().sort(function (a, b) { return Number(a[0]) - Number(b[0]); }).pop();
  var price = Number(tick[1]);
  var tickSec = Number(tick[0]);
  if (!(price > 0)) return candles[candles.length - 1].close;
  var bar = candles[candles.length - 1];
  var barSec = bar.time > 10000000000 ? bar.time / 1000 : bar.time;
  if (tickSec + 1 >= barSec) {
    bar.close = price;
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
  }
  return price;
}

class DemoFeed {
  constructor() {
    this.ws = null;
    this.authed = false;
    this.connecting = null;
    this.token = demoToken();
    this.queue = [];
    this.pending = null;
    this.timer = null;
  }

  candles(pair, period) {
    const symbol = toSymbol(pair);
    const tf = Math.max(1, Number(period) || 60);
    return new Promise((resolve, reject) => {
      this.queue.push({ symbol: symbol, period: tf, pair: pair, resolve: resolve, reject: reject });
      this.pump();
    });
  }

  pump() {
    if (this.pending || !this.queue.length) return;
    this.ensure().then(() => this.next()).catch((err) => {
      const job = this.queue.shift();
      if (job) job.reject(err);
      this.pump();
    });
  }

  ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(URL, {
        headers: { Origin: 'https://pocketoption.com', 'User-Agent': 'Mozilla/5.0' }
      });
      this.ws = ws;
      this.authed = false;
      const fail = (err) => {
        this.connecting = null;
        try { ws.close(); } catch (e) {}
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error('demo connect timeout')), 12000);
      ws.on('message', (buf) => {
        const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
        if (text === '2') {
          try { ws.send('3'); } catch (e) {}
          return;
        }
        if (text.startsWith('0') && text.indexOf('sid') >= 0) {
          ws.send('40');
          return;
        }
        if (text.startsWith('40') && text.indexOf('sid') >= 0 && !this.authed) {
          ws.send('42["auth",' + JSON.stringify({
            token: this.token,
            balance: 50000,
            isFastHistory: true
          }) + ']');
          return;
        }
        if (text.indexOf('successauth') >= 0) {
          this.authed = true;
          clearTimeout(timer);
          this.connecting = null;
          resolve();
        }
        this.onPayload(text);
      });
      ws.on('error', (err) => {
        if (!this.authed) fail(err);
      });
      ws.on('close', () => {
        this.authed = false;
        this.ws = null;
        if (this.pending) {
          const job = this.pending;
          this.pending = null;
          job.reject(new Error('demo socket closed'));
        }
      });
    });
    return this.connecting;
  }

  next() {
    if (this.pending || !this.queue.length || !this.ws || !this.authed) return;
    const job = this.queue.shift();
    this.pending = job;
    this.timer = setTimeout(() => {
      if (this.pending === job) {
        this.pending = null;
        job.reject(new Error('demo history timeout'));
        this.pump();
      }
    }, 8000);
    this.ws.send('42["changeSymbol",' + JSON.stringify({ asset: job.symbol, period: job.period }) + ']');
  }

  onPayload(text) {
    if (text && text[0] === '[') {
      try {
        var list = JSON.parse(text);
        if (Array.isArray(list) && list[0] && Array.isArray(list[0]) && list[0].length >= 15) {
          this.assets = list;
          this.assetsAt = Date.now();
        }
      } catch (e) {}
      return;
    }
    if (!text || text[0] !== '{') return;
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    if (!data || !Array.isArray(data.candles) || !this.pending) return;
    if (data.asset && data.asset !== this.pending.symbol) return;
    const job = this.pending;
    this.pending = null;
    clearTimeout(this.timer);
    const candles = asCandles(data.candles).slice(-400);
    const ticks = asTicks(data.history);
    const last = applyLiveTick(candles, data.history);
    const quoteAt = ticks.length ? ticks[ticks.length - 1].t : (candles.length ? Number(candles[candles.length - 1].t) + 60000 : Date.now());
    job.resolve({
      symbol: data.asset || job.symbol,
      requested: job.pair,
      period: Number(data.period || job.period),
      last: last,
      candles: candles,
      ticks: ticks,
      quoteAt: quoteAt,
      receivedAt: Date.now(),
      source: 'pocketoption-demo'
    });
    this.pump();
  }
}

const feed = new DemoFeed();

function candles(pair, period) {
  return feed.candles(pair, period);
}

function boardFromAssets(rows) {
  var map = {
    currency: 'currencies',
    cryptocurrency: 'crypto',
    commodity: 'commodities',
    stock: 'stocks',
    index: 'indices'
  };
  var categories = { currencies: [], crypto: [], commodities: [], stocks: [], indices: [] };
  rows.forEach(function (row) {
    if (!Array.isArray(row) || row.length < 15) return;
    var bucket = map[row[3]];
    if (!bucket) return;
    categories[bucket].push({
      symbol: row[1],
      display: row[2] || row[1],
      payout: Math.round(Number(row[5]) || 0),
      type: row[3],
      active: row[14] === true
    });
  });
  return {
    status: 'ONLINE',
    source: 'pocketoption-demo',
    timestamp: Date.now(),
    categories: categories
  };
}

function payouts() {
  return feed.ensure().then(function () {
    var started = Date.now();
    return new Promise(function (resolve, reject) {
      (function waitAssets() {
        if (feed.assets && feed.assets.length) return resolve(boardFromAssets(feed.assets));
        if (Date.now() - started > 8000) return reject(new Error('demo assets timeout'));
        setTimeout(waitAssets, 150);
      })();
    });
  });
}

module.exports = { candles, payouts, toSymbol };
