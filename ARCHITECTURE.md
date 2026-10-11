# Carbon architecture (integrator notes)

Read SPEC.md first; it wins over this file.

## Layout
```
packages/core     @carbon/core     contracts, event bus (Postgres+Redis→SSE), bonds, valence, config table, state machine, approvals, budgets, llm/
packages/agents   @carbon/agents   the six protons
packages/visual   @carbon/visual   3D scroll story + live views (React 19, r3f 9, drei 10, three, lenis, animejs v4)
packages/x        @carbon/x        X OAuth 2.0 PKCE, post/reply/search, rate limits
packages/solana   @carbon/solana   fees research, per-launch wallets, pump.fun deploy, claims, split, $CARBON buy, snapshots, decay
apps/web          @carbon/web      Next.js app (Vercel)
apps/worker       @carbon/worker   agent runtime, Treasurer schedules, decay watchers (Railway)
tests             @carbon/tests    Agent G adversarial suite
vendor/qsd-market git submodule of capteeen/QSD-market; @qsd/protocol (+crypto, quantum) are workspace packages from it
```

## Contracts
`packages/core/src/contracts.ts` (types, THE config table, footer, fee split) and
`packages/core/src/ports.ts` (interfaces between packages). Build against them;
propose changes to the integrator instead of editing them.

## Rules every package follows
- LIVE ONLY. No mock/sample/placeholder data in anything a user can see. Empty
  states are honest: `--.--`, `No molecules yet. Launch the first one.`
- Test doubles live only under `test/` and are never importable from `src/`.
- Every live visual maps to a logged CarbonEvent (by id).
- Devnet by default. Mainnet only when `CARBON_NETWORK=mainnet-beta` AND
  `CARBON_MAINNET_ENABLED=true` are both set by the owner.
- Secrets only from env. Never log, print, commit or return a key, seed or token.
- Money moves only with a receipt event. Budgets enforced in code.
- Posts and launches only with a consumed approval.
- TypeScript strict, ESM, vitest. pnpm workspace, `workspace:*` deps.

## Local services
Postgres 16 `postgres://carbon:carbon@localhost:5432/carbon` (test db `carbon_test`),
Redis `redis://localhost:6379`.
