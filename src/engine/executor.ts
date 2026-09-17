// Executor core — the heart of the trading terminal.
//
// Design:
//   - Concurrency at the JOB level: different jobs run simultaneously.
//   - Safety at the WALLET level: a single wallet never runs two in-flight txs
//     (avoids EIP-1559 nonce collisions). All submits for one wallet are queued
//     serially; cross-wallet work interleaves in parallel automatically.
//
// This module is HEADLESS — no TTY/UI/mouse deps. Chain interaction is isolated
// behind a `WalletDriver`, so the scheduler is fully unit-testable.

import { randInt, sleep } from '../core/util.js'

export type JobType =
  | 'ladderBuy'
  | 'sellPct'
  | 'nuke'
  | 'swap'
  | 'volumeBot'
  | 'snipe'

export type JobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'done'
  | 'failed'

export interface Wallet {
  id: string
  label?: string
  address?: `0x${string}`
}

/** One per-wallet execution leg of a job. */
export interface Leg {
  wallet: Wallet
  /** Resolves the actual chain action. Returns a short outcome label. */
  run: () => Promise<{ ok: boolean; label: string }>
}

/** Per-type params; semantics decided by the job planner. */
export interface JobParams {
  token?: string
  amount?: bigint
  strategy?: string
  ladderShape?: string
  step?: bigint
  factor?: bigint
  amounts?: bigint[]
  splits?: number
  cadence?: [number, number]
  pct?: number
  cycles?: number
  takeProfitPct?: number
  stopLossPct?: number
  sellPct?: number
  /** Fixed sink for deterministic tests; production nuke picks randomly. */
  sinkId?: string
  /** optional short human label shown in the JOBS panel row */
  note?: string
}

export interface Job {
  id: string
  type: JobType
  /** 'daemon' jobs self-reschedule (volume bot). One-shot = undefined. */
  mode?: 'daemon'
  wallets: Wallet[]
  params: JobParams
  state: JobState
  progress: { total: number; done: number; failed: number }
  results: string[]
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface JobPlanner {
  type: JobType
  /** Build the leg list for the job's wallets. May be async (needs balances). */
  plan: (wallets: Wallet[], params: JobParams) => Promise<Leg[]>
}

/**
 * A DAEMON (long-run / background) job. Unlike a one-shot plan, daemon.plan is
 * called repeatedly: each call yields one cycle/round of legs, the executor runs
 * them across the wallets' queues, then waits `cadence` before planning the next
 * round. Stops on `stop()`, or once `params.cycles` rounds (`0`/unset = forever).
 */
export interface DaemonPlanner {
  type: JobType
  plan: (wallets: Wallet[], params: JobParams) => Promise<Leg[]>
}

export interface ExecutorEvents {
  onJob?: (job: Job) => void
  onEvent?: (jobId: string, label: string) => void
  onProgress?: (jobId: string, progress: Job['progress']) => void
}

export class Executor {
  private jobs = new Map<string, Job>()
  private queues = new Map<string, Promise<void>>() // walletId -> serial tail
  private byWallet = new Map<string, Set<string>>() // walletId -> job ids
  private stopped = new Set<string>()
  private nextId = 1

  constructor(private readonly events: ExecutorEvents = {}) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Snapshot, newest first. Safe to read every frame. */
  all(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** True if a wallet is currently owned/used by any job. */
  isBusy(walletId: string): boolean {
    return (this.byWallet.get(walletId)?.size ?? 0) > 0
  }

  /** Enqueue a job. Returns its id immediately (runs in background). */
  start(type: JobType, wallets: Wallet[], params: JobParams, planner: JobPlanner): string {
    if (wallets.length === 0) throw new Error('no wallets targeted')
    const id = `j${this.nextId++}`
    const now = Date.now()
    const job: Job = {
      id, type, wallets, params,
      state: 'queued',
      progress: { total: 0, done: 0, failed: 0 },
      results: [],
      createdAt: now,
    }
    this.jobs.set(id, job)
    for (const w of wallets) {
      if (!this.byWallet.has(w.id)) this.byWallet.set(w.id, new Set())
      this.byWallet.get(w.id)!.add(id)
    }
    this.events.onJob?.(job)
    void this.run(job, planner)
    return id
  }

  stop(id: string): void {
    const j = this.jobs.get(id)
    if (j && (j.state === 'running' || j.state === 'queued' || j.state === 'paused')) {
      this.stopped.add(id)
      this.setState(id, 'stopped')
    }
  }

  pause(id: string): void {
    const j = this.jobs.get(id)
    if (j && j.state === 'running') this.setState(id, 'paused')
  }

  resume(id: string): void {
    const j = this.jobs.get(id)
    if (j && j.state === 'paused') this.setState(id, 'running')
  }

  /**
   * Start a long-run DAEMON job. Re-plans one cycle's legs at a time, runs them
   * across the wallets' queues, sleeps `cadence`, repeats. Stops on stop() or at
   * params.cycles rounds (0/unset = forever). Returns the job id.
   */
  startDaemon(
    type: JobType,
    wallets: Wallet[],
    params: JobParams,
    planner: DaemonPlanner,
  ): string {
    if (wallets.length === 0) throw new Error('no wallets targeted')
    const id = `j${this.nextId++}`
    const cadence = params.cadence ?? [1, 1]
    const maxCycles = params.cycles ?? 0
    const sleepMs = async () => { await sleep(randInt(cadence[0], cadence[1]) * 1000) }
    const job: Job = {
      id, type, wallets, params,
      mode: 'daemon',
      state: 'queued',
      progress: { total: 0, done: 0, failed: 0 },
      results: [],
      createdAt: Date.now(),
    }
    this.jobs.set(id, job)
    for (const w of wallets) {
      if (!this.byWallet.has(w.id)) this.byWallet.set(w.id, new Set())
      this.byWallet.get(w.id)!.add(id)
    }
    this.events.onJob?.(job)
    void this.daemonRun(job, planner, sleepMs)
    return id
  }

  // ── internals ────────────────────────────────────────────────────────────

  private setState(id: string, state: JobState): void {
    const j = this.jobs.get(id)
    if (!j) return
    j.state = state
    if (state === 'running' && !j.startedAt) j.startedAt = Date.now()
    if (state === 'done' || state === 'failed' || state === 'stopped') {
      j.finishedAt = Date.now()
      for (const w of j.wallets) this.byWallet.get(w.id)?.delete(id)
    }
    this.events.onJob?.(j)
  }

  private async run(job: Job, planner: JobPlanner): Promise<void> {
    let legs: Leg[]
    try {
      legs = await planner.plan(job.wallets, job.params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      job.results.push(`✗ ${message}`)
      this.events.onEvent?.(job.id, `✗ ${message}`)
      this.setState(job.id, 'failed')
      return
    }
    job.progress.total = legs.length
    if (legs.length === 0) { this.setState(job.id, 'done'); return }
    this.setState(job.id, 'running')

    // Submit every leg onto its wallet's serial queue. They interleave across
    // wallets automatically; same-wallet legs run one after another.
    for (const leg of legs) {
      if (this.stopped.has(job.id)) return
      this.enqueue(leg.wallet.id, () => this.runLeg(job.id, leg))
    }
    // final state is reconciled in runLeg when counts reach total
  }

  private enqueue(walletId: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(walletId) ?? Promise.resolve()
    const next = prev.then(fn, fn) // keep chain alive after a leg throws
    this.queues.set(walletId, next)
  }

  private async runLeg(id: string, leg: Leg): Promise<void> {
    const j = this.jobs.get(id)
    if (!j || j.state === 'stopped' || j.state === 'paused') return
    try {
      const r = await leg.run()
      if (this.jobs.get(id)?.state === 'stopped') return
      j.progress.done++
      j.results.push(r.label)
      this.events.onEvent?.(id, r.label)
    } catch (e) {
      if (this.jobs.get(id)?.state === 'stopped') return
      j.progress.failed++
      const msg = (e as Error).message
      j.results.push(`✗ ${msg}`)
      this.events.onEvent?.(id, `✗ ${msg}`)
    }
    this.events.onProgress?.(id, j.progress)
    if (j.mode !== 'daemon' && j.progress.done + j.progress.failed >= j.progress.total) {
      this.setState(id, 'done')
    }
  }

  /**
   * DAEMON loop: repeatedly plan a round of legs, run them to completion, sleep
   * cadence, and repeat until stopped or `params.cycles` rounds complete.
   * Unlike a one-shot job, the job stays `running` (never auto-done) while alive;
   * `stop()` flips it to `stopped`.
   */
  private async daemonRun(job: Job, planner: DaemonPlanner, cadence: () => Promise<void>): Promise<void> {
    let round = 0
    const maxCycles = job.params.cycles ?? 0
    this.setState(job.id, 'running')
    while (!this.stopped.has(job.id)) {
      const j = this.jobs.get(job.id)
      if (!j || (j.state !== 'running' && j.state !== 'paused')) break
      round++
      if (maxCycles !== 0 && round > maxCycles) break
      const legs = await planner.plan(j.wallets, j.params)
      j.progress.total = legs.length
      j.progress.done = 0
      j.progress.failed = 0
      // enqueue all legs serially per wallet (parallel across wallets)
      const tail = Promise.all(
        legs.map((leg) => new Promise<void>((resolve) => {
          this.enqueue(leg.wallet.id, async () => { await this.runLeg(job.id, leg); resolve() })
        })),
      )
      await tail
      if (this.stopped.has(job.id)) break
      if (maxCycles === 0 || round < maxCycles) await cadence()
      else break
    }
    // normal loop exit: either stopped (already set) or cycles complete
    const jNow = this.jobs.get(job.id)
    if (jNow && jNow.state === 'running') this.setState(job.id, 'done')
  }
}