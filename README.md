# 🤡 fumble.com

**Upload your crypto trades. See how much you fumbled.**

fumble.com is a client-side web app that analyzes your crypto trade history and shows:
- how much profit you *actually* made
- how much you *could have made* if you didn’t exit too early
- where you paper-handed winners or held losers too long

No APIs. No accounts. No promises of alpha.  
Just cold, painful hindsight.

---

## 🚀 What it does

- Upload your **trade history CSV** (BloFin supported for now)
- Automatically reconstructs closed trades (Open → Close)
- Computes behavioral stats:
  - win rate
  - paperhands index
  - fumble score
- **Hindsight Mode (FREE)**:
  - Fetches public Binance candles (no API key)
  - Calculates best possible exit within a lookahead window
  - Shows how much PnL you fumbled
- Fully runs **locally in the browser**

---

## 🧠 How “Fumbled PnL” is calculated

1. Take your real trade (entry → exit)
2. Look at price action *after* your exit
3. Find the **best price** within a chosen window (1h / 4h / 24h)
4. Compare:
   - Realized PnL
   - Potential PnL
5. **Fumbled = Potential − Realized (if positive)**

A realism slider reduces fantasy outcomes.

> ⚠️ This is an estimate, not exchange-perfect accounting.

---

## 🔒 Privacy & Security

- No accounts
- No backend
- No database
- CSV files never leave your browser
- Uses only **public market data** for hindsight

---

## 📂 Supported Exchanges

### ✅ Currently supported
- **BloFin** — Order History CSV

### 🔜 Planned
- Binance
- Bybit

(Automatic detection, no column mapping UI.)

---

## 🛠 Tech Stack

- React (Create React App)
- PapaParse (CSV parsing)
- Binance public klines API (no key required)
- 100% client-side

---

## 🧪 Running locally

```bash
npm install
npm start
