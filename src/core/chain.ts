import { createPublicClient, createWalletClient, defineChain, http, type Address, type HttpTransport, type PublicClient, type WalletClient } from 'viem'
import type { Account } from 'viem/accounts'

// Robinhood Chain — Arbitrum Orbit L2.
// blockTime is set (85ms blocks) so viem polls receipts fast (~0.25s) instead
// of assuming 12s blocks and polling every 4s.
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL!] } },
  blockTime: 250,
})

export type PublicClientT = PublicClient<HttpTransport, typeof robinhoodChain>
export type WalletClientT = WalletClient<HttpTransport, typeof robinhoodChain, Account>

export function makePublicClient(rpcUrl = process.env.RPC_URL): PublicClientT {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl),
    pollingInterval: 250,
  })
}

export function makeWalletClient(account: Account, rpcUrl = process.env.RPC_URL): WalletClientT {
  return createWalletClient({ chain: robinhoodChain, transport: http(rpcUrl), account })
}