# Race a BTC Trading Bot — 24-Hour Live Challenge

## Competition

This entry competes in the **make.fun bounty: "Race a BTC trading bot live for 24 hours"**. The program is a TypeScript module (`main.ts`) run by Node 22 with type stripping, speaking the `agent-fun/bars-replay/v1` protocol through a vendored SDK helper.

## Strategy

The bot trades CBBTC/USDC long-only, full cash on each buy, with at most one open position at a time and a hard budget of three trades in the entire window (at most one dip-bounce buy and at most two breakout buys). It uses two entry families that share the same exit logic. The first is a **dip-bounce**: it buys when the latest close is at least 85 basis points below the close 90 bars ago and the price has already bounced at least 20 basis points off the lowest close of the last 30 bars, taking profit 65 basis points above the entry close and stopping out 100 basis points below it. The second is a **breakout**: it buys when the latest close is at least the highest close of the previous 30 bars and at least 20 basis points above the close 30 bars ago, taking profit 50 basis points and stopping out 100 basis points. Every position also exits after 120 bars if neither target nor stop has hit, no new entry is taken after batch sequence 1320, and a 30-bar cooldown follows every buy. Risk guards stop trading after two consecutive losing trades or if equity falls to 98 percent of starting cash, with any open position sold first.

## Validated Results

Backtested on the competition's frozen 24-hour dev window of one-minute CBBTC bars (1,439 bars, the day fell 230 basis points overall):

- **Net profit: +12.47 dollars**
- **Maximum drawdown: 0.34 percent**
- **Three round trips, all three won**
- **+8.84 dollars even at doubled fees**
- By contrast, buy-and-hold lost about 26 dollars and every kit baseline lost money on the same window.

## Determinism and Dependencies

The bot is fully deterministic: it uses no wall clock, no environment variables, and no randomness. Its only inputs are the `hello` and `batch` messages from the replay protocol, and it relies on the TypeScript standard library only.
