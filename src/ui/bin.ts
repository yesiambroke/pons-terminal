// Terminal driver + app loop. Owns the raw TTY, decodes keys, holds state, and
// renders via term.renderFrame on every change.

// process is a Node.js global — no import needed
import { formatEther, isAddress, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ensureEncKey, vaultAdd, vaultDecrypt, vaultExportPrivateKey, vaultGenerate,
  vaultLoad, vaultRemove, type VaultWallet,
} from './keystore.js'
import { loadPrefs, savePrefs } from './store.js'
import { loadPositionState, savePositionState, type PositionState } from './positions-store.js'
import { makePublicClient, makeWalletClient } from '../core/chain.js'
import { dispatchTrade } from '../core/dispatch.js'
import { getBalances, getBalancesBatch } from '../core/router.js'
import { formatMarketCap, quoteHoldingValue, quoteMarketCap } from '../core/holding-value.js'
import {
  applyBuy, applySell, assessPosition, emptyPosition, entryMarketCapEth, evaluateTpSl, formatPnl, formatPnlPercent, moveTrackedTokens, positionKey, reconcilePosition, ruleSellAmount,
  type TrackedPosition, type TpSlRule,
} from '../core/positions.js'
import { detectMarket, hasMarketRouteChanged, type DetectedMarket } from '../core/market.js'
import { readCurveState, type CurveState } from '../core/curve.js'
import { runCycle, type CycleConfig } from '../engine/cycle.js'
import type { Row, ActionChip, UIRecord, TermSize, PanelFocus, JobView, VolumeWalletView } from './term.js'
import { renderFrame, SETTINGS_INTERACTIVE_ROWS, settingsCursorForRow } from './term.js'
import { ERC20_ABI } from '../core/abis.js'
import { V2_HOODL_ROUTER, WETH } from '../config.js'
import { formatRouteStatus } from './route-status.js'
import { Executor, type Job, type JobParams } from '../engine/executor.js'
import { buyPlanner, nukePlanner, sellPctPlanner, trackedSellPlanner } from '../engine/adapters.js'
import type { WalletDriver } from '../engine/driver.js'
import { volumeDaemon } from '../engine/volume.js'
import type { DispatchModal, BuyStrategy, LadderShape } from './dispatch.js'
import {
  createDispatchModal, fieldsFor, normalizeBuyAmount, normalizeSellPct, parseCadence, presetOrderParams, toParams,
} from './dispatch.js'
import type { WalletDialog } from './wallet-dialog.js'
import { checkedWalletIds, commaSeparatedKeys, isWalletDialogConfirmed } from './wallet-dialog.js'
import { copyText } from './clipboard.js'

function write(s: string) { process.stdout.write(s) }

function num(n: bigint): string {
  const s = formatEther(n)
  const [whole, fraction = ''] = s.split('.')
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`
}
function numF(n?: bigint): string { return n === undefined ? '--' : num(n) }

function compactEth(n?: bigint): string {
  if (n === undefined) return '—'
  const value = Number(formatEther(n))
  if (!Number.isFinite(value)) return '—'
  for (const [divisor, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(2)}${suffix} ETH`
  }
  return `${value.toFixed(6)} ETH`
}

export function compactToken(n?: bigint): string {
  if (n === undefined) return '--'
  const value = Number(formatEther(n))
  if (!Number.isFinite(value)) return '--'
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [divisor, suffix] of units) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(2)}${suffix}`
  }
  return value.toFixed(2)
}
function selRow(n: number): string { return `${n}` }

export interface RunOpts { onExit?: () => void }

export function runApp(opts: RunOpts = {}): void {
  ensureEncKey()

  const client = makePublicClient()
  let wallets = vaultLoad()
  const initialPrefs = loadPrefs()
  let positionState: PositionState = loadPositionState()
  let positions = new Map<string, TrackedPosition>(positionState.positions.map((position) => [positionKey(position.walletId, position.token), position]))
  let tpSlRules = new Map<string, TpSlRule>(positionState.rules.map((rule) => [positionKey(rule.walletId, rule.token), rule]))
  const tpSlJobRules = new Map<string, string>()
  let token = initialPrefs.token
  let tokenName: string | undefined
  let tokenSymbol: string | undefined
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) token = ''

  // ── Engine: the scheduler every operation dispatches into ──────────────────
  const executor = new Executor({
    onJob: (job) => {
      if ((job.state === 'done' || job.state === 'failed' || job.state === 'stopped') && tpSlJobRules.has(job.id)) {
        const key = tpSlJobRules.get(job.id)!
        const rule = tpSlRules.get(key)
        if (rule) {
          tpSlRules.set(key, rule)
        }
        tpSlJobRules.delete(job.id)
      }
      buildRows()
      renderNow()
    },
    onEvent: (_id, label) => logPush(label),
    onProgress: () => renderNow(),
  })

  function persistPositions() {
    positionState = { positions: [...positions.values()], rules: [...tpSlRules.values()] }
    savePositionState(positionState)
  }

  function positionFor(walletId: string, tokenAddress: `0x${string}`): TrackedPosition {
    const key = positionKey(walletId, tokenAddress)
    const existing = positions.get(key)
    if (existing) return existing
    const created = emptyPosition(walletId, tokenAddress)
    positions.set(key, created)
    return created
  }

  function recordSwap(walletId: string, tokenAddress: `0x${string}`, direction: 'buy' | 'sell', amountIn: bigint, amountOut: bigint) {
    const key = positionKey(walletId, tokenAddress)
    const before = positionFor(walletId, tokenAddress)
    const next = direction === 'buy'
      ? applyBuy(before, amountIn, amountOut)
      : applySell(before, amountIn, amountOut)
    positions.set(key, next)
    persistPositions()
  }

  /** Real WalletDriver: resolves vault signers + performs swaps. */
  function makeUIDriver(): WalletDriver {
    return {
      swap: async (w, opts) => {
        const vw = wallets.find((x) => x.id === w.id)
        if (!vw) throw new Error(`wallet not found: ${w.id}`)
        const signer = privateKeyToAccount(vaultDecrypt(vw) as `0x${string}`)
        const wc = makeWalletClient(signer)
        const r = await dispatchTrade(wc, client, { token: opts.token, direction: opts.direction, amount: opts.amount, recipient: signer.address })
        recordSwap(w.id, opts.token, opts.direction, opts.amount, r.amountOut)
        logPush(`${r.route} · ${r.hash.slice(0, 10)}…`)
        return { amountOut: r.amountOut, fee: r.fee, hash: r.hash }
      },
      holdings: async (w) => {
        const vw = wallets.find((x) => x.id === w.id)
        const g = await getBalances(client, (vw?.address ?? w.id) as `0x${string}`, (token || WETH) as `0x${string}`)
        return { eth: g.eth, weth: g.weth, token: token ? g.token : 0n }
      },
      cycle: async (w, spec) => {
        const vw = wallets.find((x) => x.id === w.id)
        if (!vw) throw new Error(`wallet not found: ${w.id}`)
        const signer = privateKeyToAccount(vaultDecrypt(vw) as `0x${string}`)
        const wc = makeWalletClient(signer)
        const cfg: CycleConfig = {
          token: spec.token as `0x${string}`, mode: spec.mode, patternMode: spec.patternMode,
          buys: spec.buys, sells: spec.sells, ethPerCycle: spec.ethPerCycle,
          legDelay: [0, 0], holder: signer.address, targetCycles: 1,
        }
        const r = await runCycle(wc, client, cfg)
        return { shape: r.shape, totalBought: r.totalBought, feePaid: r.feePaid }
      },
      transfer: async (w, opts) => {
        const vw = wallets.find((x) => x.id === w.id)
        if (!vw) throw new Error(`wallet not found: ${w.id}`)
        const signer = privateKeyToAccount(vaultDecrypt(vw) as `0x${string}`)
        const wc = makeWalletClient(signer)
        const hash = await wc.writeContract({
          address: opts.token,
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [opts.to, opts.amount],
        })
        const receipt = await client.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('transfer reverted')
        const recipient = wallets.find((wallet) => wallet.address.toLowerCase() === opts.to.toLowerCase())
        if (recipient) {
          const key = positionKey(w.id, opts.token)
          const source = positions.get(key)
          if (source) {
            const destinationKey = positionKey(recipient.id, opts.token)
            const destination = positions.get(destinationKey) ?? emptyPosition(recipient.id, opts.token)
            const moved = moveTrackedTokens(source, destination, opts.amount)
            positions.set(key, moved.from)
            positions.set(destinationKey, moved.to)
            persistPositions()
          }
        }
        return { hash }
      },
    }
  }
  const driver = makeUIDriver()

  let rows: Row[] = []
  let checks = new Set<number>()
  let cursor = 0
  let input = ''
  let cursorPos = 0
  let settingEdit: 'token' | 'buy' | 'sell' | null = null
  let tokenEdit = false
  let market: DetectedMarket | undefined
  let curveState: CurveState | undefined
  let routeError = ''
  let holdingValue: string | undefined
  let pnlSummary: string | undefined
  let entryMarketCap: string | undefined
  let walletPnl = new Map<string, string>()
  let marketCap: string | undefined
  let tokenSupply: bigint | undefined
  let ethUsd: number | undefined
  let ethUsdUpdatedAt = 0
  let busy = false
  let statusText = 'ready'

  // ── DISPATCH modal state (opened by b/s/v/d) ───────────────────────────────
  let modal: DispatchModal | null = null
  let modalEdit: number | null = null   // field index being text-edited
  let modalBlink = false                // toggles while editing → blink cursor
  let blinkTimer: ReturnType<typeof setInterval> | null = null
  let walletDialog: WalletDialog | null = null

  function startBlink() {
    if (blinkTimer) return
    modalBlink = true
    blinkTimer = setInterval(() => { modalBlink = !modalBlink; renderNow() }, 530)
  }
  function stopBlink() {
    if (blinkTimer) { clearInterval(blinkTimer); blinkTimer = null }
    modalBlink = false
  }

  // ── Persistent ACTIVITY log (never cleared; scrollable) ─────────────────────
  let activityLog: string[] = []
  let logScroll = 0   // 0 = pinned to live tail; N = rows scrolled back

  /** Append one or more lines to the activity log, cap it, pin live. */
  function logPush(...lines: string[]): void {
    activityLog.push(...lines)
    if (activityLog.length > 500) activityLog = activityLog.slice(-500)
    logScroll = 0   // new activity pins the view to the tail
  }

  // ── Panel focus state ─────────────────────────────────────────────────────
  let panel: PanelFocus = 'wallets'
  let actionCursor = 0
  let settingsCursor = 0
  let jobCursor = 0
  let walletScroll: number | undefined = undefined   // wheel-driven scroll offset
  let gasMode: 'fast (+2gwei)' | 'turbo (+5gwei)' | 'normal (+0gwei)' = 'normal (+0gwei)'
  let tpSlAutomationEnabled = initialPrefs.tpSlAutomationEnabled === true
  let currentTheme: string = initialPrefs.theme || 'dark'
  let defaultBuyAmount = initialPrefs.defaultBuyAmount || '0.001'
  let defaultSellPct = initialPrefs.defaultSellPct || '50'

  const reducerActions = (n: number): ActionChip[] => [
    { key: 'b', label: `buy  x${n}` },
    { key: 's', label: `sell  x${n}` },
    { key: 'k', label: 'TP / SL' },
    { key: 'v', label: 'volume' },
    { key: 'n', label: 'Sell All' },
    { key: 'i', label: 'import wallet' },
    { key: 'e', label: 'export selected' },
    { key: 'd', label: 'delete selected' },
  ]

  let refreshing = false   // true while a balance refresh is in flight
  let refreshingMarket = false

  /** Wallet ids reserved by active volume daemons; excluded from ordinary trades. */
  function volumeWalletIds(): Set<string> {
    const ACTIVE: Job['state'][] = ['queued', 'running', 'paused']
    return new Set(executor.all()
      .filter((job) => job.type === 'volumeBot' && ACTIVE.includes(job.state))
      .flatMap((job) => job.wallets.map((wallet) => wallet.id)))
  }

  function buildRows() {
    const reserved = volumeWalletIds()
    rows = wallets.map((wallet) => ({
      label: '',
      name: wallet.label,
      address: wallet.address,
      eth: '–',
      token: '–',
      reserved: reserved.has(wallet.id),
    }))
  }

  async function refreshRows() {
    if (refreshing || !wallets.length) return
    refreshing = true
    renderNow()   // show ⟳ syncing… the moment the fetch STARTS (not on user input)
    try {
      // all wallets fetched in parallel (RH Chain has no Multicall3)
      const bal = await getBalancesBatch(
        client,
        wallets.map((w) => ({ id: w.id, address: w.address as `0x${string}` })),
        (token || WETH) as `0x${string}`,
      )
      const reserved = volumeWalletIds()
      await Promise.all([refreshHoldingValue(bal), refreshPnlAndTpSl(bal), refreshMarketCap()])
      rows = wallets.map((wallet) => {
        const balance = bal.get(wallet.id)
        return {
          label: '',
          name: wallet.label,
          address: wallet.address,
          eth: `${numF(balance?.eth)} ETH`,
          token: `${compactToken(balance?.token)} TOK`,
          pnl: walletPnl.get(wallet.id) ?? '--',
          reserved: reserved.has(wallet.id),
        }
      })
    } finally {
      refreshing = false
      renderNow()
    }
  }

  async function refreshHoldingValue(balances: Map<string, { eth: bigint; weth: bigint; token: bigint }>) {
    holdingValue = undefined
    if (!token || !market || !wallets.length) return
    const totalTokens = wallets.reduce((total, wallet) => total + (balances.get(wallet.id)?.token ?? 0n), 0n)
    if (totalTokens === 0n) {
      holdingValue = '~ 0.000000 ETH'
      return
    }
    const holder = wallets[cursor]?.address as `0x${string}` | undefined
    if (!holder) return
    try {
      const quote = await quoteHoldingValue(client, market, totalTokens, holder)
      holdingValue = `~ ${num(quote.netEth)} ETH`
      if (quote.curve) curveState = quote.curve
    } catch {
      holdingValue = 'unavailable'
    }
  }

  async function refreshPnlAndTpSl(balances: Map<string, { eth: bigint; weth: bigint; token: bigint }>) {
    pnlSummary = undefined
    entryMarketCap = undefined
    walletPnl = new Map()
    if (!token || !market || !wallets.length) return
    const tokenAddress = token as `0x${string}`
    let totalCost = 0n
    let totalTokens = 0n
    let totalNet = 0n
    let tracked = false
    let changed = false

    for (const wallet of wallets) {
      const key = positionKey(wallet.id, tokenAddress)
      const position = positions.get(key)
      if (!position) continue
      const liveTokens = balances.get(wallet.id)?.token ?? 0n
      const reconciled = reconcilePosition(position, liveTokens)
      if (reconciled.tokens !== position.tokens || reconciled.costEth !== position.costEth) {
        positions.set(key, reconciled)
        changed = true
      }
      if (reconciled.tokens <= 0n) continue
      try {
        const quote = await quoteHoldingValue(client, market, reconciled.tokens, wallet.address as `0x${string}`)
        const assessment = assessPosition(reconciled, liveTokens, quote.netEth)
        walletPnl.set(wallet.id, formatPnlPercent(assessment.pnlBps))
        totalCost += assessment.costEth
        totalTokens += assessment.trackedTokens
        totalNet += assessment.netEth
        tracked = true

        const rule = tpSlRules.get(key)
        const trigger = rule && !executor.isBusy(wallet.id) ? evaluateTpSl(assessment, rule, tpSlAutomationEnabled) : undefined
        if (trigger) {
          const sellAmount = ruleSellAmount(assessment, rule!)
          if (sellAmount > 0n) {
            rule!.triggered = trigger
            tpSlRules.set(key, rule!)
            persistPositions()
            const id = executor.start('sellPct', [{ id: wallet.id, label: wallet.label }], {
              token: tokenAddress, amount: sellAmount, note: trigger,
            }, trackedSellPlanner(driver, tokenAddress))
            tpSlJobRules.set(id, key)
            logPush(`${wallet.label}: ${trigger} → sell ${rule!.sellPct}% tracked`)
          }
        }
      } catch {
        // A failed quote leaves the last displayed PnL intact until the next refresh.
      }
    }

    if (changed) persistPositions()
    if (tracked && totalCost > 0n && totalTokens > 0n) {
      const pnlEth = totalNet - totalCost
      pnlSummary = formatPnl(pnlEth, pnlEth * 10_000n / totalCost)
      const entry = tokenSupply === undefined ? undefined : entryMarketCapEth(totalCost, totalTokens, tokenSupply)
      entryMarketCap = entry === undefined ? 'untracked' : formatMarketCap(entry, ethUsd)
    } else if (token) {
      pnlSummary = 'untracked'
      entryMarketCap = 'untracked'
    }
  }

  async function refreshMarketCap() {
    marketCap = undefined
    if (!token || !market || tokenSupply === undefined) return
    const holder = wallets[cursor]?.address as `0x${string}` ?? '0x0000000000000000000000000000000000000000'
    try {
      const cap = await quoteMarketCap(client, market, tokenSupply, holder)
      const now = Date.now()
      if (!ethUsd || now - ethUsdUpdatedAt > 60_000) {
        try {
          const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
          const body = await response.json() as { ethereum?: { usd?: unknown } }
          if (typeof body.ethereum?.usd === 'number' && body.ethereum.usd > 0) {
            ethUsd = body.ethereum.usd
            ethUsdUpdatedAt = now
          }
        } catch {
          // Keep the route-derived ETH cap visible if USD pricing is temporarily unavailable.
        }
      }
      marketCap = formatMarketCap(cap.marketCapEth, ethUsd)
    } catch {
      marketCap = 'unavailable'
    }
  }

  async function refreshMarketRoute() {
    if (refreshingMarket || !token) return
    refreshingMarket = true
    const tokenAddress = token as `0x${string}`
    try {
      const resolved = await detectMarket(client, tokenAddress)
      if (token !== tokenAddress) return
      const changed = hasMarketRouteChanged(market, resolved)
      market = resolved
      routeError = ''
      if (resolved.kind === 'v2-curve') {
        const recipient = wallets[cursor]?.address as `0x${string}` | undefined
        curveState = recipient ? await readCurveState(client, resolved.curve, recipient) : undefined
      } else {
        curveState = undefined
      }
      if (changed) {
        holdingValue = undefined
        marketCap = undefined
        logPush(`route → ${resolved.kind}`)
        void refreshRows()
        void refreshMarketCap()
      }
    } catch (e) {
      if (token === tokenAddress) routeError = (e as Error).message
    } finally {
      refreshingMarket = false
      renderNow()
    }
  }

  async function refreshMarketState() {
    market = undefined
    curveState = undefined
    routeError = ''
    holdingValue = undefined
    pnlSummary = undefined
    entryMarketCap = undefined
    walletPnl = new Map()
    marketCap = undefined
    tokenSupply = undefined
    tokenName = undefined
    tokenSymbol = undefined
    if (!token) return
    const tokenAddress = token as `0x${string}`
    try {
      const [resolved, metadata] = await Promise.all([
        detectMarket(client, tokenAddress),
        Promise.allSettled([
          client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'name' }),
          client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'symbol' }),
          client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'totalSupply' }),
        ]),
      ])
      const [nameResult, symbolResult, supplyResult] = metadata
      if (nameResult?.status === 'fulfilled' && typeof nameResult.value === 'string') tokenName = nameResult.value
      if (symbolResult?.status === 'fulfilled' && typeof symbolResult.value === 'string') tokenSymbol = symbolResult.value
      if (supplyResult?.status === 'fulfilled' && typeof supplyResult.value === 'bigint') tokenSupply = supplyResult.value
      market = resolved
      if (resolved.kind === 'v2-curve') {
        const recipient = wallets[cursor]?.address as `0x${string}` | undefined
        if (recipient) curveState = await readCurveState(client, resolved.curve, recipient)
      }
      logPush(`route → ${resolved.kind}`)
      void refreshRows()
      void refreshMarketCap()
    } catch (e) {
      routeError = (e as Error).message
      logPush(`route unavailable: ${routeError}`)
    } finally {
      renderNow()
    }
  }

  function routeStatus() {
    return formatRouteStatus({ market, curve: curveState, error: routeError || undefined, v2RouterConfigured: Boolean(V2_HOODL_ROUTER) })
  }

  function rec(): UIRecord {
    const route = routeStatus()
    return {
      title: 'PONS TERMINAL',
      token,
      tokenName,
      tokenSymbol,
      rows,
      cursor: Math.min(cursor, Math.max(0, rows.length - 1)),
      checks,
      status: `${statusText} · ${selRow(checks.size)}/${wallets.length} · ${refreshing ? '⟳ syncing…' : busy ? 'busy' : 'idle'}`,
      actions: reducerActions(checks.size),
      feedback: activityLog,
      logScroll,
      input: { value: input, cursor: cursorPos, prompt: settingEdit === 'token' ? 'token CA' : settingEdit === 'buy' ? 'default buy ETH' : settingEdit === 'sell' ? 'default sell %' : 'cmd' },
      focus: panel,
      actionCursor,
      settingsCursor,
      gasMode,
      tpSlAutomationEnabled,
      theme: currentTheme,
      defaultBuyAmount,
      defaultSellPct,
      /** mirror the engine's jobs into the JOBS panel */
      jobs: jobsSnapshot(),
      volumeWallets: volumeWalletSnapshot(),
      jobCursor,
      walletScroll,
      modal: modal ?? undefined,
      walletDialog: walletDialog ?? undefined,
      walletDialogBlink: walletDialog ? modalBlink : undefined,
      routeLabel: route.label,
      routeDetail: route.detail,
      routeMarket: route.market,
      routeBlocked: route.blocked,
      holdingValue,
      pnlSummary,
      entryMarketCap,
      marketCap,
      modalEdit: modalEdit ?? undefined,
      modalBlink,
    }
  }

  function volumeWalletSnapshot(): VolumeWalletView[] {
    const reserved = volumeWalletIds()
    return wallets.flatMap((wallet, index) => {
      if (!reserved.has(wallet.id)) return []
      const row = rows[index]
      return [{
        name: wallet.label,
        address: wallet.address,
        eth: row?.eth ?? '–',
        token: row?.token ?? '–',
      }]
    })
  }

  /** Map executor jobs → renderer JobView rows. Only ACTIVE jobs (queued/
   * running/paused) show in the JOBS panel — finished/stopped jobs clear out. */
  function jobsSnapshot(): JobView[] {
    const ACTIVE: Job['state'][] = ['queued', 'running', 'paused']
    return executor.all()
      .filter((j) => ACTIVE.includes(j.state))
      .map((j) => ({
        id: j.id,
        type: j.type,
        wallets: j.wallets.length,
        progress: { done: j.progress.done, failed: j.progress.failed, total: j.progress.total },
        state: j.state,
        daemon: j.mode === 'daemon',
        note: j.params.note ?? j.params.strategy ?? (j.params.pct != null ? `${j.params.pct}%` : undefined),
      }))
  }

  function termSize(): TermSize {
    return { cols: process.stdout.columns || 110, rows: process.stdout.rows || 30 }
  }

  // Flicker-free repaint: move cursor home then overwrite in-place.
  // renderFrame produces no screen-control escapes — only SGR colours.
  function renderNow() {
    write('\u001b[H')   // cursor home (no clear — lines are fully padded)
    write(renderFrame(rec(), termSize()))
    write('\u001b[0m')
  }

  function toggle(index: number) {
    const wallet = wallets[index]
    if (wallet && volumeWalletIds().has(wallet.id)) {
      logPush(`${wallet.label} is dedicated to volume`)
      return
    }
    const next = new Set(checks)
    next.has(index) ? next.delete(index) : next.add(index)
    checks = next
  }

  function reloadWallets(selectId?: string, selectNew = false) {
    const selectedIds = new Set([...checks].map((i) => wallets[i]?.id).filter((id): id is string => Boolean(id)))
    if (selectNew && selectId) selectedIds.add(selectId)
    wallets = vaultLoad()
    checks = new Set(wallets.flatMap((wallet, i) => selectedIds.has(wallet.id) ? [i] : []))
    const selectedIndex = selectId ? wallets.findIndex((wallet) => wallet.id === selectId) : -1
    cursor = selectedIndex >= 0 ? selectedIndex : Math.min(cursor, Math.max(0, wallets.length - 1))
    buildRows()
  }

  function selectedWallet(): VaultWallet | undefined {
    return wallets[cursor]
  }

  function beginSettingEdit(kind: 'token' | 'buy' | 'sell') {
    settingEdit = kind
    tokenEdit = kind === 'token'
    input = kind === 'token' ? '' : kind === 'buy' ? defaultBuyAmount : defaultSellPct
    cursorPos = input.length
    panel = 'token'
    renderNow()
  }

  function openWalletDialog(kind: WalletDialog['kind']) {
    if (kind === 'import') {
      walletDialog = { kind, value: '' }
      panel = 'wallets'
      startBlink()
      renderNow()
      return
    }
    const wallet = selectedWallet()
    if (!wallet) { logPush('no wallet selected'); renderNow(); return }
    const walletIds = kind === 'delete-confirm' || kind === 'export-confirm'
      ? checkedWalletIds(wallets, checks)
      : undefined
    if ((kind === 'delete-confirm' || kind === 'export-confirm') && !walletIds?.length) {
      logPush(`no wallets checked for ${kind === 'delete-confirm' ? 'deletion' : 'export'}`)
      renderNow()
      return
    }
    walletDialog = {
      kind,
      walletId: wallet.id,
      walletIds,
      walletLabel: wallet.label,
      walletAddress: wallet.address,
      value: '',
    }
    panel = 'wallets'
    startBlink()
    renderNow()
  }

  function closeWalletDialog() {
    walletDialog = null
    stopBlink()
    renderNow()
  }

  // ── DISPATCH modal lifecycle ────────────────────────────────────────────────
  function openModal(kind: DispatchModal['kind']) {
    modal = createDispatchModal(kind, { defaultBuyAmount, defaultSellPct })
    modalEdit = null
    renderNow()
  }
  function closeModal() { modal = null; modalEdit = null; stopBlink(); renderNow() }

  function dispatchPreset(kind: 'buy' | 'sell') {
    if (!token) { logPush(`${kind} preset: set a token first (t)`); renderNow(); return }
    const route = routeStatus()
    if (route.blocked) { logPush(`${kind} preset: ${route.blocked}`); renderNow(); return }
    const selected = wallets.filter((_, index) => checks.has(index))
    const reserved = volumeWalletIds()
    const targets = selected.filter((wallet) => !reserved.has(wallet.id))
    if (!targets.length) {
      const detail = selected.length ? 'selected wallets are dedicated to volume' : 'no wallets selected'
      logPush(`${kind} preset: ${detail}`)
      renderNow()
      return
    }
    if (targets.length !== selected.length) {
      logPush(`preset ${kind}: skipped ${selected.length - targets.length} volume-reserved wallet${selected.length - targets.length === 1 ? '' : 's'}`)
    }
    const params = presetOrderParams(kind, { defaultBuyAmount, defaultSellPct })
    const wids = targets.map((wallet) => ({ id: wallet.id, label: wallet.label }))
    if (kind === 'buy') {
      executor.start('ladderBuy', wids, { ...params, token, note: `preset ${defaultBuyAmount} ETH` }, buyPlanner(driver, token))
      logPush(`preset buy · ${defaultBuyAmount} ETH × ${wids.length}`)
    } else {
      executor.start('sellPct', wids, { ...params, token, note: `preset ${defaultSellPct}%` }, sellPctPlanner(driver, token))
      logPush(`preset sell · ${defaultSellPct}% × ${wids.length}`)
    }
    busy = true
    statusText = `${kind} preset dispatched`
    renderNow()
    void refreshRows()
  }

  /** Confirm → dispatch a job from the modal's params, then close. */
  function dispatchModal() {
    if (!modal) return
    if (!token) { modal.error = 'set a token first (t)'; renderNow(); return }
    const activeRoute = routeStatus()
    if (activeRoute.blocked) { modal.error = activeRoute.blocked; renderNow(); return }
    const name = modal.kind
    const selected = wallets.filter((_, i) => checks.has(i))
    if (name === 'volume' && selected.some((wallet) => executor.isBusy(wallet.id))) {
      modal.error = 'stop active jobs before dedicating wallets to volume'
      renderNow()
      return
    }
    const reserved = volumeWalletIds()
    const targets = name === 'volume'
      ? selected
      : selected.filter((wallet) => !reserved.has(wallet.id))
    if (!targets.length) {
      const detail = selected.length && name !== 'volume'
        ? 'selected wallets are dedicated to volume'
        : 'no wallets selected'
      modal.error = detail
      renderNow()
      return
    }
    if (name !== 'volume' && targets.length !== selected.length) {
      logPush(`skipped ${selected.length - targets.length} volume-reserved wallet${selected.length - targets.length === 1 ? '' : 's'}`)
    }
    const wids = targets.map((w) => ({ id: w.id, label: w.label }))
    const tok  = token
    const p    = toParams(modal)

    if (name === 'tpsl') {
      for (const wallet of targets) {
        const key = positionKey(wallet.id, tok as `0x${string}`)
        tpSlRules.set(key, {
          walletId: wallet.id,
          token: tok as `0x${string}`,
          takeProfitPct: p.takeProfitPct!,
          stopLossPct: p.stopLossPct!,
          sellPct: p.sellPct!,
        })
      }
      persistPositions()
      logPush(`TP/SL · ${wids.length} wallet${wids.length === 1 ? '' : 's'} · +${p.takeProfitPct}% / -${p.stopLossPct}% · ${p.sellPct}% tracked`)
    } else if (name === 'buy') {
      executor.start('ladderBuy', wids, { ...p, token: tok, note: modal.strategy ?? 'buy' }, buyPlanner(driver, tok))
    } else if (name === 'sell') {
      executor.start('sellPct', wids, { ...p, token: tok }, sellPctPlanner(driver, tok))
    } else if (name === 'volume') {
      executor.startDaemon('volumeBot', wids, { ...p, token: tok, cycles: p.cycles ?? 0, note: 'bg' }, volumeDaemon(driver, {
        token: tok, mode: 'auto', patternMode: 'bs', buys: 1, sells: 1,
        ethPerCycle: p.amount ?? parseEther('0.001'),
      }))
    }
    const summary = `${name} · ${wids.length} wallet${wids.length > 1 ? 's' : ''} dispatched`
    logPush(summary)
    busy = true; statusText = `${name} dispatched`; renderNow(); void refreshRows()
    closeModal()
  }

  function nukeNow() {
    if (!token) { logPush('nuke: set a token first (t)'); renderNow(); return }
    const route = routeStatus()
    if (route.blocked) { logPush(`nuke: ${route.blocked}`); renderNow(); return }
    const reserved = volumeWalletIds()
    const targets = wallets.filter((wallet) => !reserved.has(wallet.id))
    if (!targets.length) {
      logPush(wallets.length ? 'nuke: all wallets are dedicated to volume' : 'nuke: no wallets available')
      renderNow()
      return
    }
    if (reserved.size) {
      logPush(`nuke: skipped ${reserved.size} volume-reserved wallet${reserved.size === 1 ? '' : 's'}`)
    }
    const wids = targets.map((wallet) => ({ id: wallet.id, label: wallet.label, address: wallet.address as `0x${string}` }))
    executor.start('nuke', wids, { token, note: 'nuke' }, nukePlanner(driver, token))
    logPush(`Sell All · ${wids.length} wallet${wids.length === 1 ? '' : 's'} · random sink · sell 100%`)
    busy = true
    statusText = 'Sell All dispatched'
    renderNow()
    void refreshRows()
  }

  /** Execute the action under the action cursor */
  function triggerActionCursor() {
    const actions = reducerActions(checks.size)
    const a = actions[actionCursor]
    if (!a) return
    const map: Record<string, DispatchModal['kind']> = { b: 'buy', s: 'sell', k: 'tpsl', v: 'volume' }
    if (a.key === 'n') { nukeNow(); return }
    const name = map[a.key]
    if (name) openModal(name)
    else if (a.key === 'i') openWalletDialog('import')
    else if (a.key === 'e') openWalletDialog('export-confirm')
    else if (a.key === 'd') openWalletDialog('delete-confirm')
  }

  function cleanup() {
    stopBlink()
    clearInterval(refreshTimer)
    write('\u001b[?1006l')  // disable SGR mouse
    write('\u001b[?1003l')  // disable any-event mouse tracking
    write('\u001b[?25h')    // show cursor
    write('\u001b[?1049l')  // leave alternate screen
    try { process.stdin.setRawMode(false) } catch { /* already raw-unset */ }
    process.stdin.pause()
  }
  const quit = () => { cleanup(); opts.onExit ? opts.onExit() : process.exit(0) }

  /** Modal key handling — navigate/cycle/edit fields, confirm/cancel. */
  function handleModalKey(
    ch: string,
    key: {
      up?: boolean; down?: boolean; left?: boolean; right?: boolean
      enter?: boolean; esc?: boolean; backspace?: boolean; ch?: string
    },
  ) {
    const m = modal
    if (!m) return
    const fields = fieldsFor(m)
    m.error = undefined

    // text-editing a specific field
    if (modalEdit !== null) {
      const f = fields[modalEdit]
      if (!f) { modalEdit = null; stopBlink(); renderNow(); return }
      if (key.esc || key.enter) { modalEdit = null; stopBlink(); renderNow(); return }
      if (key.backspace) setField(f.key, f.value.slice(0, -1))
      else if (key.ch) setField(f.key, f.value + key.ch)
      renderNow()
      return
    }

    if (key.esc) { closeModal(); return }
    if (key.enter) { dispatchModal(); return }          // ⏎ confirm

    if (key.up)   { m.cursor = (m.cursor - 1 + fields.length) % fields.length; renderNow(); return }
    if (key.down) { m.cursor = (m.cursor + 1) % fields.length; renderNow(); return }

    const curField = fields[m.cursor % fields.length]
    if (key.left && curField?.kind === 'enum') { cycleField(curField.key, -1); renderNow(); return }
    if (key.right && curField?.kind === 'enum') { cycleField(curField.key, 1); renderNow(); return }
    // start inline text editing for text/int fields
    if (key.right || key.ch) { modalEdit = m.cursor; startBlink(); renderNow(); return }
  }

  /** Cycle an enum field (strategy / shape) forward or back. */
  function cycleField(key: string, dir: number) {
    const m = modal
    if (!m) return
    const opts: readonly string[] = key === 'strategy'
      ? ['individual', 'split-equal', 'split-prop', 'ladder']
      : ['arithmetic', 'geometric', 'list']
    const cur = key === 'strategy' ? m.strategy : m.ladderShape
    const idx = Math.max(0, opts.indexOf(cur ?? opts[0]!))
    const next = opts[(idx + dir + opts.length) % opts.length]!
    if (key === 'strategy') m.strategy = next as BuyStrategy
    else m.ladderShape = next as LadderShape
  }

  /** Set a text/int field value back into the active modal. */
  function setField(key: string, value: string) {
    const m = modal
    if (!m) return
    if (key === 'amount') m.amount = value

    else if (key === 'step') m.step = value
    else if (key === 'factor') m.factor = value
    else if (key === 'list') m.list = value
    else if (key === 'pct') m.pct = value
    else if (key === 'sellPct') m.sellPct = value
    else if (key === 'takeProfit') m.takeProfit = value
    else if (key === 'stopLoss') m.stopLoss = value
    else if (key === 'cadence') m.cadence = value
    else if (key === 'cycles') m.cycles = value
  }

  function handleWalletDialogKey(key: {
    enter?: boolean; esc?: boolean; backspace?: boolean; left?: boolean; right?: boolean; ch?: string
  }) {
    const dialog = walletDialog
    if (!dialog) return
    if (dialog.kind === 'export-reveal') {
      const exportKeys = dialog.exportKeys ?? (dialog.value ? [dialog.value] : [])
      if (key.left || key.right) {
        const delta = key.left ? -1 : 1
        dialog.exportIndex = ((dialog.exportIndex ?? 0) + delta + exportKeys.length) % Math.max(1, exportKeys.length)
        dialog.copied = false
        renderNow()
        return
      }
      if (key.ch === 'c') {
        try {
          copyText(commaSeparatedKeys(exportKeys))
          dialog.copied = true
          logPush(`${exportKeys.length} private key${exportKeys.length === 1 ? '' : 's'} copied to clipboard`)
        } catch (error) {
          dialog.error = (error as Error).message
        }
        renderNow()
        return
      }
      closeWalletDialog()
      return
    }
    if (key.esc) { closeWalletDialog(); return }
    if (key.backspace) {
      dialog.value = (dialog.value ?? '').slice(0, -1)
      renderNow()
      return
    }
    if (key.ch) {
      dialog.value = (dialog.value ?? '') + key.ch
      dialog.error = undefined
      renderNow()
      return
    }
    if (!key.enter) return

    try {
      if (dialog.kind === 'import') {
        const wallet = vaultAdd(`w${wallets.length + 1}`, dialog.value ?? '')
        reloadWallets(wallet.id, true)
        logPush(`+ wallet imported ${wallet.address.slice(0, 6)}…`)
        walletDialog = null
        stopBlink()
        void refreshRows()
      } else if (dialog.kind === 'export-confirm') {
        if (!isWalletDialogConfirmed(dialog.kind, dialog.value)) {
          dialog.error = 'type EXPORT exactly to reveal'
        } else if (!dialog.walletIds?.length) {
          dialog.error = 'no wallets checked for export'
        } else {
          walletDialog = {
            ...dialog,
            kind: 'export-reveal',
            exportKeys: dialog.walletIds.map((id) => vaultExportPrivateKey(id)),
            exportIndex: 0,
            value: undefined,
          }
          stopBlink()
        }
      } else if (dialog.kind === 'delete-confirm') {
        if (!isWalletDialogConfirmed(dialog.kind, dialog.value)) {
          dialog.error = 'type DELETE exactly to remove'
        } else if (!dialog.walletIds?.length) {
          dialog.error = 'no wallets checked for deletion'
        } else if (dialog.walletIds.some((id) => executor.isBusy(id))) {
          dialog.error = 'stop active jobs before deleting checked wallets'
        } else {
          const removed = dialog.walletIds.map((id) => vaultRemove(id))
          reloadWallets()
          logPush(`− deleted ${removed.length} wallet${removed.length === 1 ? '' : 's'}`)
          walletDialog = null
          stopBlink()
        }
      }
    } catch (error) {
      dialog.error = (error as Error).message
    }
    renderNow()
  }

  function handle(
    ch: string,
    key: {
      up?: boolean; down?: boolean; left?: boolean; right?: boolean
      enter?: boolean; esc?: boolean; backspace?: boolean; space?: boolean
      ctrlC?: boolean; tab?: boolean; ch?: string
    },
  ) {
    // ── WALLET management modal (captures all input, including secrets) ───────
    if (walletDialog) {
      handleWalletDialogKey(key)
      return
    }

    // ── DISPATCH modal mode (captures all input while open) ──────────────────
    if (modal) {
      handleModalKey(ch, key)
      return
    }

    // ── Editable Settings (token/default buy/default sell) ────────────────────
    if (settingEdit) {
      if (key.esc) { settingEdit = null; tokenEdit = false; input = ''; statusText = 'ready'; renderNow(); return }
      if (key.enter) {
        try {
          if (settingEdit === 'token') {
            if (!isAddress(input.trim() as `0x${string}`)) throw new Error('invalid CA')
            token = input.trim()
            savePrefs({ token })
            logPush(`token → ${token.slice(0, 6)}…`)
            statusText = 'token set'
            void refreshMarketState()
          } else if (settingEdit === 'buy') {
            defaultBuyAmount = normalizeBuyAmount(input)
            savePrefs({ defaultBuyAmount })
            logPush(`default buy → ${defaultBuyAmount} ETH`)
          } else {
            defaultSellPct = normalizeSellPct(input)
            savePrefs({ defaultSellPct })
            logPush(`default sell → ${defaultSellPct}%`)
          }
          settingEdit = null
          tokenEdit = false
          input = ''
          cursorPos = 0
        } catch (error) {
          statusText = (error as Error).message
        }
        return
      }
      if (key.backspace) { input = input.slice(0, cursorPos - 1) + input.slice(cursorPos); cursorPos = Math.max(0, cursorPos - 1) }
      else if (key.left) cursorPos = Math.max(0, cursorPos - 1)
      else if (key.right) cursorPos = Math.min(input.length, cursorPos + 1)
      else if (key.ch) { input = input.slice(0, cursorPos) + key.ch + input.slice(cursorPos); cursorPos += key.ch.length }
      return
    }

    // ── Global keys (always active) ───────────────────────────────────────────
    if (key.ctrlC) return quit()
    if (key.tab) {
      const cycle: Record<PanelFocus, PanelFocus> = { wallets: 'token', token: 'actions', actions: 'jobs', jobs: 'wallets' }
      panel = cycle[panel]
      if (panel === 'actions') actionCursor = Math.min(actionCursor, reducerActions(0).length - 1)
      return
    }

    const c = key.ch ?? ''

    // Direct digit shortcuts to jump to wallet index (e.g. '1' -> wallet [1])
    if (/^[1-9]$/.test(c)) {
      const idx = parseInt(c, 10) - 1
      if (idx >= 0 && idx < wallets.length) {
        panel = 'wallets'
        cursor = idx
        const view = Math.max(4, Math.floor(Math.max(5, termSize().rows - 8) * 0.55))
        walletScroll = Math.min(idx, Math.max(0, wallets.length - (view - 1)))
        return
      }
    }

    // Letter hotkeys — always available regardless of panel
    if (c === 't') { beginSettingEdit('token'); return }
    if (c === '[') { dispatchPreset('buy'); return }
    if (c === ']') { dispatchPreset('sell'); return }
    if (c === 'b') { openModal('buy'); return }
    if (c === 's') { openModal('sell'); return }
    if (c === 'k') { openModal('tpsl'); return }
    if (c === 'v') { openModal('volume'); return }
    if (c === 'n') { nukeNow(); return }
    if (c === 'c' && panel === 'wallets') {
      const wallet = selectedWallet()
      if (!wallet) { logPush('no wallet selected'); renderNow(); return }
      try {
        copyText(wallet.address)
        logPush(`address copied · ${wallet.address}`)
      } catch (error) {
        logPush((error as Error).message)
      }
      renderNow()
      return
    }
    if (c === 'i') { openWalletDialog('import'); return }
    if (c === 'e') { openWalletDialog('export-confirm'); return }
    if (c === 'd') { openWalletDialog('delete-confirm'); return }

    if (c === 'a') {
      const reserved = volumeWalletIds()
      const available = wallets.flatMap((wallet, index) => reserved.has(wallet.id) ? [] : [index])
      const allAvailableChecked = available.length > 0 && available.every((index) => checks.has(index))
      checks = allAvailableChecked ? new Set<number>() : new Set(available)
      return
    }
    if (c === 'g') {
      try {
        vaultGenerate(`w${wallets.length + 1}`); wallets = vaultLoad(); buildRows(); logPush('+ wallet generated, key encrypted'); renderNow(); void refreshRows()
      } catch (e) { logPush(`✗ ${(e as Error).message}`); renderNow() }
      return
    }
    if (c === '?' || c === 'h') { logPush('b buy · s sell · k TP/SL · v volume · n Sell All · i import · e export · d delete · a all · g gen · tab panel · x stop · p pause · r resume · q quit'); return }
    if (c === 'q') return quit()

    // Job control — GLOBAL keys (work from any panel, target the focused/newest job)
    if (c === 'x') { stopFocusedJob(); return }
    if (c === 'p') { pauseFocusedJob(); return }
    if (c === 'r') { resumeFocusedJob(); return }

    // ── Panel-specific keys ───────────────────────────────────────────────────
    if (panel === 'wallets') {
      const maxIdx = Math.max(0, wallets.length - 1)
      const view = Math.max(4, Math.floor(Math.max(5, termSize().rows - 8) * 0.55))
      const sync = () => { walletScroll = Math.min(cursor, Math.max(0, wallets.length - (view - 1))) }
      if (key.up)   { cursor = cursor <= 0 ? maxIdx : cursor - 1; sync(); return }
      if (key.down) { cursor = cursor >= maxIdx ? 0 : cursor + 1; sync(); return }
      if (key.space) { toggle(cursor); return }
      if (key.enter) { toggle(cursor); return }
    } else if (panel === 'token') {
      const maxSetting = SETTINGS_INTERACTIVE_ROWS.length - 1
      if (key.up)   { settingsCursor = settingsCursor <= 0 ? maxSetting : settingsCursor - 1; return }
      if (key.down) { settingsCursor = settingsCursor >= maxSetting ? 0 : settingsCursor + 1; return }
      if (key.enter || key.space) {
        if (settingsCursor === 0) beginSettingEdit('token')
        else if (settingsCursor === 1) beginSettingEdit('buy')
        else if (settingsCursor === 2) beginSettingEdit('sell')
        else if (settingsCursor === 3) {
          const modes: Array<'fast (+2gwei)' | 'turbo (+5gwei)' | 'normal (+0gwei)'> = ['fast (+2gwei)', 'turbo (+5gwei)', 'normal (+0gwei)']
          gasMode = modes[(modes.indexOf(gasMode) + 1) % modes.length]
          logPush(`gas mode → ${gasMode}`)
        } else if (settingsCursor === 4) {
          tpSlAutomationEnabled = !tpSlAutomationEnabled
          savePrefs({ tpSlAutomationEnabled })
          if (!tpSlAutomationEnabled) {
            for (const id of tpSlJobRules.keys()) executor.stop(id)
          }
          logPush(`TP/SL automation → ${tpSlAutomationEnabled ? 'on' : 'off'}`)
        } else if (settingsCursor === 5) {
          const themes = ['dark', 'tokyo-night', 'obsidian-gold', 'sunset-synth', 'cyberpunk', 'dracula', 'matrix', 'nord']
          currentTheme = themes[(themes.indexOf(currentTheme) + 1) % themes.length]
          savePrefs({ theme: currentTheme })
          logPush(`theme → ${currentTheme}`)
        }
        return
      }
    } else if (panel === 'actions') {
      const actCount = reducerActions(0).length
      const maxAct = Math.max(0, actCount - 1)
      if (key.up)   { actionCursor = actionCursor <= 0 ? maxAct : actionCursor - 1; return }
      if (key.down) { actionCursor = actionCursor >= maxAct ? 0 : actionCursor + 1; return }
      if (key.enter || key.space) { triggerActionCursor(); return }
    } else if (panel === 'jobs') {
      const jobs = executor.all()
      const maxJ = Math.max(0, jobs.length - 1)
      if (key.up)   { jobCursor = jobCursor <= 0 ? maxJ : jobCursor - 1; return }
      if (key.down) { jobCursor = jobCursor >= maxJ ? 0 : jobCursor + 1; return }
      if (c === 'x' || key.enter || key.backspace) { stopFocusedJob(); return }
      if (c === 'p') { pauseFocusedJob(); return }
      if (c === 'r') { resumeFocusedJob(); return }
    }
  }

  /** Stop the job under the JOBS cursor (or the newest job if none selected). */
  function stopFocusedJob() {
    const jobs = executor.all()
    const j = jobs[jobCursor] ?? jobs[0]
    if (!j) { logPush('no jobs to stop'); renderNow(); return }
    if (j.state === 'done' || j.state === 'failed' || j.state === 'stopped') {
      logPush(`${j.id} already ${j.state}`); renderNow(); return
    }
    executor.stop(j.id)
    logPush(`● stopped ${j.id} (${j.type})`)
    renderNow(); void refreshRows()
  }
  function pauseFocusedJob() {
    const jobs = executor.all()
    const j = jobs[jobCursor] ?? jobs.find((x) => x.state === 'running') ?? jobs[0]
    if (j && (j.state === 'running' || j.state === 'queued')) {
      executor.pause(j.id); logPush(`⏸ paused ${j.id} (${j.type})`); renderNow()
    } else if (j) logPush(`${j.id} is ${j.state} — nothing to pause`)
  }
  function resumeFocusedJob() {
    const jobs = executor.all()
    // resume the focused job, or the newest PAUSED one (so `r` works after pause)
    const j = jobs[jobCursor] ?? jobs.find((x) => x.state === 'paused') ?? jobs[0]
    if (j && j.state === 'paused') {
      executor.resume(j.id); logPush(`▶ resumed ${j.id} (${j.type})`); renderNow()
    } else if (j) logPush(`${j.id} is ${j.state} — nothing to resume`)
  }

  /** Which top panel owns a 0-based column — MUST mirror renderer (term.ts).
   *  WALLETS cols 1..ci1+2 · SETTINGS cols ci1+4..ci1+ci2+5 · ACTIONS beyond. */
  function panelAtCol(col: number): 'wallets' | 'token' | 'actions' | 'none' {
    const size = termSize()
    const pw = Math.max(70, size.cols - 2)
    const ci2 = Math.max(22, Math.min(34, Math.floor(pw * 0.26)))
    const ci3 = 22
    const ci1 = pw - 4 - (ci2 + 2) - (ci3 + 2)
    if (col >= 1 && col <= ci1 + 2) return 'wallets'
    if (col >= ci1 + 4 && col <= ci1 + ci2 + 5) return 'token'
    return 'actions'   // ACTIONS spans the rest to the right edge
  }

  /** Hover-follow: move the selection in the panel under the mouse (no click).
   *  Throttled — SGR motion events stream at high rate. */
  let hoverLast = 0
  function handleHover(col: number, row: number) {
    const now = Date.now()
    if (now - hoverLast < 60) return      // ~16/s cap
    hoverLast = now
    const size = termSize()
    const view = Math.max(4, Math.floor(Math.max(5, size.rows - 8) * 0.55))
    // only follow within the 3 top panels' body rows
    if (row < 3 || row >= 3 + (view - 1)) return
    const p = panelAtCol(col)
    if (p === 'wallets') {
      // WALLETS: row → wallet index using the SAME displayed offset (walletStart)
      const start = walletStart(view)
      const idx = start + (row - 3)
      if (idx >= 0 && idx < wallets.length && idx !== cursor) { cursor = idx; renderNow() }
    } else if (p === 'token') {
      const idx = settingsCursorForRow(row - 3)
      if (idx !== undefined && idx !== settingsCursor) { settingsCursor = idx; renderNow() }
    } else if (p === 'actions') {
      const idx = row - 3
      const n = reducerActions(0).length
      if (idx >= 0 && idx < n && idx !== actionCursor) { actionCursor = idx; renderNow() }
    }
  }

  /** Wheel over a top/bottom panel scrolls THAT panel (the one under the cursor). */
  function moveHoverPanel(col: number, row: number, dir: number) {
    const size = termSize()
    const view = Math.max(4, Math.floor(Math.max(5, size.rows - 8) * 0.55))
    const btY = view + 3          // bottom titles row
    const byY = btY + 1           // bottom body start
    // top panels (rows 3..view+1)
    if (row >= 3 && row <= 3 + (view - 1)) {
      const p = panelAtCol(col)
      if (p === 'wallets') { moveSlideFor('wallets', dir) }
      else if (p === 'token') { moveSlideFor('token', dir) }
      else { moveSlideFor('actions', dir) }
      return
    }
    // JOBS panel (bottom right, cols ca1+2.., body byY..byY+act-2)
    const pwA = Math.max(70, size.cols - 2)
    const ca2A = Math.max(26, Math.min(34, Math.floor(pwA * 0.3))) + 2
    const ca1A = pwA - 1 - ca2A
    const flexA = Math.max(5, size.rows - 8)
    const actA = Math.max(2, flexA - view)
    if (row >= byY && row < byY + actA - 1 && col > ca1A + 1) { moveSlideFor('jobs', dir) }
  }

  /** Move a specific panel's selection by dir (clamped at the ends). */
  function moveSlideFor(which: string, dir: number) {
    if (which === 'token') { settingsCursor = Math.min(5, Math.max(0, settingsCursor + dir)); return }
    if (which === 'actions') {
      const n = reducerActions(0).length
      actionCursor = Math.min(Math.max(0, n - 1), Math.max(0, actionCursor + dir)); return
    }
    if (which === 'jobs') {
      const n = executor.all().length
      jobCursor = Math.min(Math.max(0, n - 1), Math.max(0, jobCursor + dir)); return
    }
    const max = Math.max(0, wallets.length - 1)
    cursor = Math.min(max, Math.max(0, cursor + dir))
    // keep the wheel-driven scroll offset in sync with the cursor so the
    // viewport follows keyboard/wheel nav — but clicks DON'T touch walletScroll,
    // so clicking a wallet never re-anchors the scrollbar.
    const view = Math.max(4, Math.floor(Math.max(5, termSize().rows - 8) * 0.55))
    walletScroll = Math.min(cursor, Math.max(0, wallets.length - (view - 1)))
  }

  /** Visible-row start offset for WALLETS — mirrors term.ts renderer exactly.
   *  Explicit walletScroll wins; otherwise cursor-anchored. */
  function walletStart(view: number) {
    const maxStart = Math.max(0, wallets.length - (view - 1))
    return walletScroll !== undefined
      ? Math.min(walletScroll, maxStart)
      : Math.max(0, Math.min(cursor - Math.floor((view - 1) / 3), maxStart))
  }

  /** Handle mouse click & wheel events */
  function handleMouse(btn: number, col: number, row: number, isPress: boolean) {
    // SGR mouse coords are 1-based; the renderer + all hit-math below are 0-based.
    col -= 1
    row -= 1
    const size = termSize()
    const pw = Math.max(70, size.cols - 2)   // fit width (matches computeLayout)
    const ci2 = Math.max(22, Math.min(34, Math.floor(pw * 0.26)))
    const ci3 = 22
    const ci1 = pw - 4 - (ci2 + 2) - (ci3 + 2)   // -4 → matches renderer's right-edge gap

    const chrome = 8
    const flex = Math.max(5, size.rows - chrome)
    const view = Math.max(4, Math.floor(flex * 0.55))

    // 0-based terminal column boundaries — MUST match the renderer (term.ts):
    // WALLETS painted at x=1, width ci1+2 →  cols 1..ci1+2
    // SETTINGS painted at x=ci1+4, width ci2+2 → cols ci1+4..ci1+ci2+5
    // gutters (BGS) at ci1+3 and ci1+ci2+6
    const walletEnd  = ci1 + 2   // last wallet column (inclusive)
    const settingEnd = ci1 + ci2 + 5   // last settings column (inclusive)

    if (settingEdit) {
      if (btn === 0 && isPress) {
        // Click outside Settings panel cancels the active settings edit.
        if (col <= walletEnd || col > settingEnd || row > view + 2) {
          settingEdit = null
          tokenEdit = false
          input = ''
          statusText = 'ready'
          renderNow()
        }
      }
      return
    }

    // ACTIVITY panel body: top section chrome = header(1)+spacer(1)+titles(1)+top body(view-1)+spacer(1)
    // bottom bits: title(1) + body. Body starts at view+5 and spans the remaining rows.
    const actStart = view + 5
    const actEnd = termSize().rows - 4 // up to the help bar
    // the ACTIVITY log spans the full left bottom panel (width ca1), NOT the
    // wallets column width (c1). Use ca1 so wheel-over-log works everywhere.
    const pwA = Math.max(70, termSize().cols - 2)
    const ca2A = Math.max(26, Math.min(34, Math.floor(pwA * 0.3))) + 2
    const ca1A = pwA - 1 - ca2A
    const overLog = actStart <= row && row <= actEnd && col <= ca1A

    if (btn === 64 || btn === 65) {
      const dir = btn === 64 ? -1 : 1      // 64 = wheel up (selection up), 65 = down
      // over the activity log → scroll the log
      if (overLog) {
        if (dir === -1) { const back = activityLog.length + 50; if (logScroll < back) logScroll += 2 }
        else { logScroll = Math.max(0, logScroll - 2) }
      } else {
        // wheel scrolls the panel the CURSOR is hovering over (not the focused one)
        moveHoverPanel(col, row, dir)
      }
      renderNow()
      return
    }

    if (btn === 0 && isPress) {
      if (row >= 3 && row <= view + 1) {   // body rows only (not title/spacer)
        if (col <= walletEnd) {
          // Column 1: WALLETS panel — first click FOCUSES + moves cursor,
          // second click (panel already focused) actually toggles the wallet.
          const wasFocused = panel === 'wallets'
          panel = 'wallets'
          // visible-row → wallet mapping uses the SAME offset the renderer
          // displayed (walletScroll), so clicks hit exactly what's on screen.
          const start = walletStart(view)
          const bi = row - 3
          if (bi >= 0 && bi < view) {
            const targetIndex = start + bi
            if (targetIndex >= 0 && targetIndex < wallets.length) {
              cursor = targetIndex
              if (wasFocused) toggle(targetIndex)   // only act on repeat clicks
            }
          }
          renderNow()
        } else if (col <= settingEnd) {
          // Column 2: SETTINGS panel clicked — focus panel; only select a
          // setting if the click landed on one of the 4 real setting rows.
          panel = 'token'
          const sIdx = settingsCursorForRow(row - 3)
          if (sIdx !== undefined) {
            settingsCursor = sIdx
            if (sIdx === 0) {
              beginSettingEdit('token')
            } else if (sIdx === 1) {
              beginSettingEdit('buy')
            } else if (sIdx === 2) {
              beginSettingEdit('sell')
            } else if (sIdx === 3) {
              const modes: Array<'fast (+2gwei)' | 'turbo (+5gwei)' | 'normal (+0gwei)'> = ['fast (+2gwei)', 'turbo (+5gwei)', 'normal (+0gwei)']
              gasMode = modes[(modes.indexOf(gasMode) + 1) % modes.length]
              logPush(`gas mode → ${gasMode}`)
            } else if (sIdx === 4) {
              tpSlAutomationEnabled = !tpSlAutomationEnabled
              savePrefs({ tpSlAutomationEnabled })
              if (!tpSlAutomationEnabled) {
                for (const id of tpSlJobRules.keys()) executor.stop(id)
              }
              logPush(`TP/SL automation → ${tpSlAutomationEnabled ? 'on' : 'off'}`)
            } else if (sIdx === 5) {
              const themes = ['dark', 'tokyo-night', 'obsidian-gold', 'sunset-synth', 'cyberpunk', 'dracula', 'matrix', 'nord']
              currentTheme = themes[(themes.indexOf(currentTheme) + 1) % themes.length]
              savePrefs({ theme: currentTheme })
              logPush(`theme → ${currentTheme}`)
            }
          }
          renderNow()
        } else {
          // Column 3: ACTIONS panel clicked
          panel = 'actions'
          const actionIdx = row - 3
          const actCount = reducerActions(checks.size).length
          if (actionIdx >= 0 && actionIdx < actCount) {
            actionCursor = actionIdx
            triggerActionCursor()
          } else {
            renderNow()
          }
        }
      }
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  write('\u001b[?1049h')   // alternate screen
  write('\u001b[?25l')     // hide cursor
  write('\u001b[2J')       // clear screen once at start
  write('\u001b[?1003h')   // enable any-event mouse tracking
  write('\u001b[?1006h')   // enable SGR extended mouse mode
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
  buildRows()                  // show all wallet rows immediately (balances = `–`)
  renderNow()                  // paint the shell RIGHT AWAY — no waiting on balances
  void refreshRows()           // balances stream in behind the UI (⟳ syncing…)
  void refreshMarketState()    // venue/taxes stream in behind the UI
  const refreshTimer = setInterval(() => {
    void refreshRows()
    void refreshMarketRoute()
  }, 3000)
  process.stdout.on('resize', renderNow)

  // ── Input parser ────────────────────────────────────────────────────────────
  let esc = ''
  let escTimer: ReturnType<typeof setTimeout> | null = null

  const dispatchChar = (ch: string): void => {
    handle(ch, {
      enter: ch === '\r',
      ctrlC: ch === '\u0003',
      backspace: ch === '\u007f' || ch === '\b',
      space: ch === ' ',
      tab: ch === '\t',
      ch: /^[^\u0000-\u001f\u007f]/.test(ch) ? ch : undefined,
    })
    renderNow()
  }

  const dispatchEsc = (seq: string): void => {
    // ── SGR mouse event: \u001b[<btn;col;row;M or m ─────────────────────────
    const mouseMatch = seq.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/)
    if (mouseMatch) {
      const btn = parseInt(mouseMatch[1], 10)
      const col = parseInt(mouseMatch[2], 10)
      const row = parseInt(mouseMatch[3], 10)
      const isPress = mouseMatch[4] === 'M'
      // SGR motion event = pure hover (bit 32 set, no button). Follow the row.
      if ((btn & 32) !== 0 && !isPress) { handleHover(col, row); return }
      handleMouse(btn, col, row, isPress)
      return
    }

    // ── Standard key sequences ──────────────────────────────────────────────
    const k: { [k: string]: boolean } = {}
    if (seq === '\u001b[A') k.up = true
    else if (seq === '\u001b[B') k.down = true
    else if (seq === '\u001b[C') k.right = true
    else if (seq === '\u001b[D') k.left = true
    else if (seq === '\u001b[Z') k.tab = true     // shift+tab (backtab)
    else if (seq === '\u001b') k.esc = true
    handle('', k)
    renderNow()
  }

  process.stdin.on('data', (d: Buffer) => {
    const str = d.toString('utf8')
    for (const ch of str) {
      if (esc) {
        if (escTimer) { clearTimeout(escTimer); escTimer = null }
        esc += ch
        // CSI sequence: starts with \u001b[ and ends with a letter in 0x40-0x7e
        if (esc.startsWith('\u001b[') && /[A-Za-z]/.test(esc[esc.length - 1]) && esc.length >= 3) {
          dispatchEsc(esc)
          esc = ''
        }
        // Bail on absurdly long sequences
        else if (esc.length > 32) { esc = '' }
        else {
          escTimer = setTimeout(() => {
            if (esc) { dispatchEsc(esc); esc = '' }
          }, 30)
        }
        continue
      }
      if (ch === '\u001b') {
        esc = ch
        escTimer = setTimeout(() => {
          if (esc === '\u001b') { dispatchEsc(esc); esc = '' }
        }, 30)
        continue
      }
      dispatchChar(ch)
    }
  })
}