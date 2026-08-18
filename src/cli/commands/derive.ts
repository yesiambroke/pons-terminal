import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// output a fresh trading wallet for the SDK. DERIVED, not unrecoverable test keys.
export function derive(): void {
  const pk = generatePrivateKey()
  const account = privateKeyToAccount(pk)
  console.log('HOODL trading wallet created.')
  console.log(`Address:  ${account.address}`)
  console.log(`Private key: ${pk}`)
  console.log('⚠️ Save this key NOW — it is shown once. Add it to .env (PRIVATE_KEY), then fund with a little ETH.')
}