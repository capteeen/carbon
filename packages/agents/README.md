# @carbon/agents

The six protons (Scout, Forge, Sentinel, Herald, Keeper, Treasurer) and the
`MoleculeRunner` that runs a launch per shape. Agents touch the world only
through `AgentContext`.

## Wiring (apps/worker)

```ts
import { MoleculeRunner, type AgentContext, type AssetStore } from '@carbon/agents';
const ctx: AgentContext = { bus, handoffs, approvals, budgets, llm, x, chain, config, launchId, now: Date.now, assets };
const runner = new MoleculeRunner(ctx, { chooseNarrative, signLaunchTx, revise });
await runner.run();          // Scout → … → deploy → announcement
const stop = runner.start(); // RING loop / fee-claim schedule
```

- `AssetStore` is a local port of this package: `put(launchId, name, bytes, mime) → { uri }`.
  Forge uses it for the logo copy, the banner and the one-page site HTML. The
  worker implements it (public, immutable URLs).
- `fetchBytes` is optional (Sentinel fetches existing coins' images for the logo
  hash); default is a size- and time-limited HTTPS GET.

## Approvals: agents consume, hooks only check

Agents call `approvals.consume(launchId, approvalId, action)` themselves,
immediately before the irreversible call:

| Agent | Consumes | Then calls |
|---|---|---|
| Herald | `post` | `x.post(launchId, text, approvalId)` |
| Keeper | `reply` | `x.reply(launchId, inReplyTo, text, approvalId)` |
| Treasurer | `launch` | `chain.buildLaunchTx({ …, approvalId })` |
| Treasurer | `buyback` | `chain.buyCarbon(lamports, splitId)` |
| any (DIAMOND) | `action` | the gated action |

**The X and chain approval hooks must CHECK that a consumed approval exists for
that launch + action + approvalId. They must never call `consume` a second
time.** A second consume throws (already consumed) and the post or launch fails.

## Events the agents emit

The X and chain clients do not append events; the agents do:
`scout.proposals`, `forge.draft` (twice: draft, then deploy-ready with
`metadataUri` after Sentinel passes), `sentinel.score`, `launch.deployed`,
`post.published`, `fee.claimed`, `split.receipt`, `buyback.executed`,
`handoff` (through `handoffs.send`), `error` (refusals), and a `reasoning`
event for every one of them.

## Fees (native pump.fun fee sharing)

`chain.createLaunchWallet(launchId)` returns the launch's fee address (native
mode: the sharing-config PDA). Treasurer calls it at most once per launch and
reads it back from the log afterwards (`launch.deployed.creatorWallet`, or the
`launchWallet` on its launch approval card). `claimCreatorFees` is treated as
the crank and `runSplit` as the receipt source; Treasurer records receipts and
never sends legs itself. Buybacks spend only confirmed `carbon-buyback` legs,
capped per tick, and always pass the `splitId`.

## Sentinel

`src/sentinel/formula.ts` is the public formula; `renderFormulaMarkdown()`
renders it for /how. Hard fails: content-rule violations, impersonation, and a
content check that could not run.
