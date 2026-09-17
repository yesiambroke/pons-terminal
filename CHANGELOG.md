# Release Notes

## 2026-09-16

First dated changelog entry. It records the changes prepared since the prior GitHub release.

### Added

- **Persistent order presets**: Buy ETH and Sell % defaults are editable in SETTINGS, stored locally, and prefill new Buy/Sell modals.
- **Direct preset orders**: `[` immediately buys the configured Buy ETH amount and `]` sells the configured Sell % for checked, non-volume wallets without opening a modal.
- **Receipt-backed position tracking**: terminal-confirmed buys and sells maintain per-wallet, per-token open cost basis, token inventory, and realized PnL locally.
- **Live PnL and valuation**: wallet rows show individual tracked-position PnL; SETTINGS shows portfolio PnL, weighted Entry MC, current Value, and MCap.
- **Local TP/SL rules** (`k`): configure per-wallet take-profit, stop-loss, and tracked sell percentage. Rules persist locally without arming automation.
- **Global TP/SL automation**: SETTINGS provides one persisted `on`/`off` switch, defaulting to `off`, that arms or disarms every configured TP/SL rule.
- Route-specific holding value and fully diluted market-cap estimates, with ETH/USD formatting when the ETH price is available.

### Changed

- Pons V2 curve and migrated V4 terminal trades now use the corrected TradeRouterV3 configuration.
- Active market state is re-detected every three seconds, so the UI updates automatically when a token moves from Curve to V4.
- SETTINGS preserves separate Value and MCap rows and adds PnL and Entry MC without hiding the active token identity in the terminal header.
- Wallet tables use responsive shared column widths, show per-wallet PnL, and omit repeated `ETH`/`TOK` suffixes from values because the column headers already provide the units.

### Fixed

- Graduated V2/V4 token sells use pre-funded ERC-20 settlement instead of the Permit2 pull path that could revert with an expired allowance.
- V4 slippage protection now applies one gross slippage-adjusted minimum to both the inner V4 swap and the router's net-output minimum.
- TP/SL sells submit only the exact terminal-tracked token tranche through the existing per-wallet serialized executor; untracked external holdings cannot be sold automatically.
- TP/SL marks a rule triggered before queueing a sell and disables it after completion, failure, or stop, preventing duplicate or blind retry orders.
- Local Sell All transfers carry proportional tracked cost basis to the receiving terminal wallet only after a confirmed transfer.

### Notes

- PnL, Entry MC, and TP/SL apply only to positions acquired through Pons Terminal. Existing external balances remain untracked and cannot arm automation.
- TP/SL monitoring runs only while Pons Terminal is open.
