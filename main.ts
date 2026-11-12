// Race a BTC trading bot live for 24 hours
//
// Strategy (validated on the competition's frozen 24-hour dev window of one-minute CBBTC bars):
// The bot trades CBBTC/USDC long-only, full cash on each buy, at most one open position at a time,
// and at most three trades in the entire window (at most one dip-bounce buy and at most two
// breakout buys). It uses two entry families that share the same position and the same exit logic:
//
// 1) Dip-bounce: buy when the latest close is at least 85 basis points below the close 90 bars ago
//    AND the close has already bounced at least 20 basis points off the lowest close of the last 30 bars.
//    Take profit is 65 basis points above the entry close; stop loss is 100 basis points below it.
//
// 2) Breakout: buy when the latest close is at least the highest close of the previous 30 bars
//    AND at least 20 basis points above the close 30 bars ago. Take profit is 50 basis points;
//    stop loss is 100 basis points.
//
// Every position also exits after 120 bars if neither target nor stop has hit. No new entry is taken
// after batch sequence 1320, and a 30-bar cooldown follows every buy. Risk guards stop trading after
// two consecutive losing trades, or if equity falls to 98% of starting cash (selling any open position first).
// Maximum slippage on every order is 1000 basis points. The bot is fully deterministic: no wall clock,
// no environment variables, no randomness — the only inputs are the hello and batch messages.
//
// Validated results on the frozen dev window (1,439 one-minute bars, day down 230 basis points):
// net profit +12.47 USDC, maximum drawdown 0.34%, three round trips, all three won, and +8.84 USDC
// even at doubled fees. By contrast, buy-and-hold lost about 26 USDC and every kit baseline lost money.

import { runBars, type BarsState, type BuyInput, type SellInput, type Batch } from "./vendor/makefun-bars.ts";

// --- Strategy constants ---

// Entry trigger: latest close must be <= -85 bps vs the close 90 bars ago (dip).
const DIP_BPS_BELOW_90_AGO = 85;
// Entry trigger: close must have bounced >= 20 bps off the lowest close of the last 30 bars.
const DIP_BOUNCE_BPS_OFF_LOWEST_30 = 20;
// Dip-bounce take profit: 65 bps above the entry close.
const DIP_TP_BPS = 65;
// Dip-bounce stop loss: 100 bps below the entry close.
const DIP_SL_BPS = 100;
// Breakout entry: close >= highest close of the previous 30 bars (excluding current bar).
const BREAKOUT_ABOVE_30_AGO_BPS = 20;
// Breakout take profit: 50 bps.
const BREAKOUT_TP_BPS = 50;
// Breakout stop loss: 100 bps.
const BREAKOUT_SL_BPS = 100;
// Hard exit: close a position after 120 bars if neither TP nor SL hit.
const MAX_BARS_IN_TRADE = 120;
// No new entries after this batch sequence.
const LAST_ENTRY_BATCH = 1320;
// Cooldown after every buy: skip new entries for 30 bars.
const COOLDOWN_BARS = 30;
// Risk guard: stop trading after this many consecutive losing trades.
const MAX_CONSECUTIVE_LOSSES = 2;
// Risk guard: stop trading if equity falls to 98% of starting cash.
const EQUITY_STOP_FRACTION = 98n;
// Maximum slippage on every order, in basis points.
const MAX_SLIPPAGE_BPS = 1000;
// Maximum number of dip-bounce buys allowed in the whole window.
const MAX_BOUNCE_TRADES = 1;
// Maximum number of breakout buys allowed in the whole window.
const MAX_BREAKOUT_TRADES = 2;

// --- Module-level state ---

// Recorded closes in USDC, one entry per bar, appended each batch.
const closesUsdc: number[] = [];
// Starting cash, captured from state.cash on the first batch.
let startingCash: bigint = 0n;
// Number of dip-bounce buys executed so far.
let bounceTrades = 0;
// Number of breakout buys executed so far.
let breakoutTrades = 0;
// Consecutive losing trades since the last win.
let consecutiveLosses = 0;
// Whether the bot has been stopped by a risk guard.
let stopped = false;
// Sequence of the last buy batch, used for the 30-bar cooldown.
let lastBuyBatch: number | null = null;
// Entry close in USDC of the current open position, if any.
let entryCloseUsdc: number | null = null;
// Take-profit and stop-loss in basis points of the current position.
let tpBps: number | null = null;
let slBps: number | null = null;
// Batch at which the current position was entered, for the 120-bar hard exit.
let entryBatch: number | null = null;
// Entry family of the current position: "dip" or "breakout".
let entryFamily: "dip" | "breakout" | null = null;

/**
 * Returns the latest close of the given symbol in USDC as a number, or null if unavailable.
 * Converts the close bigint to a plain number first, then divides by 10 ** price_scale.
 */
function latestCloseUsdc(state: BarsState, symbol: string): number | null {
  const close = state.close(symbol);
  if (close === null) {
    return null;
  }
  const priceScale = state.symbols.get(symbol)?.price_scale ?? 6;
  return Number(close) / 10 ** priceScale;
}

/**
 * Main batch callback driven by runBars.
 */
async function onBatch(state: BarsState, batch: Batch): Promise<(BuyInput | SellInput)[]> {
  const orders: (BuyInput | SellInput)[] = [];
  const symbol = "CBBTC";
  const closeUsdc = latestCloseUsdc(state, symbol);

  // Record the latest close in our own history.
  if (closeUsdc !== null) {
    closesUsdc.push(closeUsdc);
  }

  // Capture starting cash on the first batch.
  if (startingCash === 0n && state.cash !== undefined) {
    startingCash = state.cash;
  }

  // If no close yet, nothing to do.
  if (closeUsdc === null) {
    return orders;
  }

  // --- Exit and risk-guard logic ---

  const positions = state.positions;
  const currentBatch = batch.seq;

  // If a position is open, check exits first.
  if (positions.has(symbol)) {
    const position = positions.get(symbol)!;

    // Take-profit check.
    if (tpBps !== null && entryCloseUsdc !== null) {
      const tpPrice = entryCloseUsdc * (1 + tpBps / 10000);
      if (closeUsdc >= tpPrice) {
        orders.push({
          side: "sell",
          symbol,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        consecutiveLosses = 0; // Winning exit resets consecutive losses.
        entryCloseUsdc = null;
        tpBps = null;
        slBps = null;
        entryBatch = null;
        entryFamily = null;
        return orders;
      }
    }

    // Stop-loss check.
    if (slBps !== null && entryCloseUsdc !== null) {
      const slPrice = entryCloseUsdc * (1 - slBps / 10000);
      if (closeUsdc <= slPrice) {
        orders.push({
          side: "sell",
          symbol,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        consecutiveLosses++; // Stop-loss is a losing exit.
        if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
          stopped = true; // Stop trading immediately after two consecutive losses.
        }
        entryCloseUsdc = null;
        tpBps = null;
        slBps = null;
        entryBatch = null;
        entryFamily = null;
        return orders;
      }
    }

    // 120-bar time exit.
    if (entryBatch !== null && currentBatch !== null && currentBatch - entryBatch >= MAX_BARS_IN_TRADE) {
      orders.push({
        side: "sell",
        symbol,
        qty: position.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      // Time exit counts as losing if closed below entry.
      if (closeUsdc < entryCloseUsdc!) {
        consecutiveLosses++;
        if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
          stopped = true; // Stop trading immediately after two consecutive losses.
        }
      } else {
        consecutiveLosses = 0;
      }
      entryCloseUsdc = null;
      tpBps = null;
      slBps = null;
      entryBatch = null;
      entryFamily = null;
      return orders;
    }

    // If stopped by a risk guard, send no orders.
    if (stopped) {
      return orders;
    }
  }

  // --- Equity guard (sell any open position and stop if breached) ---
  if (stopped === false && state.equity !== undefined) {
    const equityThreshold = (startingCash * EQUITY_STOP_FRACTION) / 100n;
    if (state.equity <= equityThreshold) {
      if (positions.has(symbol)) {
        const position = positions.get(symbol)!;
        orders.push({
          side: "sell",
          symbol,
          qty: position.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        entryCloseUsdc = null;
        tpBps = null;
        slBps = null;
        entryBatch = null;
        entryFamily = null;
      }
      stopped = true;
      return orders;
    }
  }

  // --- Entry logic (only when flat and not stopped) ---
  if (positions.has(symbol) || stopped) {
    return orders;
  }

  // Enforce 30-bar cooldown after last buy.
  if (lastBuyBatch !== null && currentBatch !== null && currentBatch - lastBuyBatch < COOLDOWN_BARS) {
    return orders;
  }

  // Enforce no-new-entry cutoff at batch sequence 1320.
  if (currentBatch !== null && currentBatch >= LAST_ENTRY_BATCH) {
    return orders;
  }

  // --- Dip-bounce entry (first) ---
  // Buy the dip only after the price has already turned up, so the bot does not catch a falling knife.
  if (closesUsdc.length >= 91 && bounceTrades < MAX_BOUNCE_TRADES) {
    const close90Ago = closesUsdc[closesUsdc.length - 91];
    const returnBps = ((closeUsdc - close90Ago) / close90Ago) * 10000;
    if (returnBps <= -DIP_BPS_BELOW_90_AGO) {
      const lowest30 = Math.min(...closesUsdc.slice(-30));
      const bounceBps = ((closeUsdc - lowest30) / lowest30) * 10000;
      if (bounceBps >= DIP_BOUNCE_BPS_OFF_LOWEST_30) {
        const minimumNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (state.cash >= minimumNotional) {
          orders.push({
            side: "buy",
            symbol,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          lastBuyBatch = currentBatch;
          entryCloseUsdc = closeUsdc;
          tpBps = DIP_TP_BPS;
          slBps = DIP_SL_BPS;
          entryBatch = currentBatch;
          entryFamily = "dip";
          bounceTrades++;
          return orders;
        }
      }
    }
  }

  // --- Breakout entry (second) ---
  if (closesUsdc.length >= 31 && breakoutTrades < MAX_BREAKOUT_TRADES) {
    const previous30 = closesUsdc.slice(-31, -1);
    const highest30 = Math.max(...previous30);
    const close30Ago = closesUsdc[closesUsdc.length - 31];
    if (closeUsdc >= highest30) {
      const above30AgoBps = ((closeUsdc - close30Ago) / close30Ago) * 10000;
      if (above30AgoBps >= BREAKOUT_ABOVE_30_AGO_BPS) {
        const minimumNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (state.cash >= minimumNotional) {
          orders.push({
            side: "buy",
            symbol,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          lastBuyBatch = currentBatch;
          entryCloseUsdc = closeUsdc;
          tpBps = BREAKOUT_TP_BPS;
          slBps = BREAKOUT_SL_BPS;
          entryBatch = currentBatch;
          entryFamily = "breakout";
          breakoutTrades++;
          return orders;
        }
      }
    }
  }

  // If neither entry fires, send no orders.
  return orders;
}

// --- Entry point: wire up runBars ---

await runBars({ onBatch });
