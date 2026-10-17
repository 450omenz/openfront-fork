# Extending the fork: units and buildings

The fork's features are built from small reusable parts. A new building or
unit should mostly be a matter of filling in entries, not writing new
systems. This page lists each part and the steps to use it.

## Every new unit type (checklist)

1. Append the type to `UnitType` in `packages/engine-api/src/game/GameTypes.ts`.
   Always append: the wire format is positional.
2. Give it a `unitInfo` case in `packages/engine-lib/src/configuration/Config.ts`
   and a cost in `packages/engine/src/configuration/EngineConfig.ts`.
3. Add a `UnitParamsMap` entry in `packages/engine/src/game/Game.ts`.
4. Add the client type constant in `src/client/render/types/UnitType.ts`. Then
   add it to the build menu (`hud/layers/BuildMenu.ts`), the hotkey
   (`UserSettings.ts`, `InputHandler.ts`, `UserSettingModal.ts`), the unit bar
   (`hud/layers/UnitDisplay.ts`) and the lobby's disable list
   (`components/GameConfigSettings.ts`).
5. Every new execution class needs a snapshot type and an entry in
   `packages/engine/src/snapshot/ExecutionRegistry.ts`. If no AI builds the
   unit yet, also add it to `neverStored` in
   `tests/core/snapshot/FullGameSnapshot.test.ts`.
6. Put new UI text in `resources/lang/en.json`. Keep the keys sorted.

## Stackable buildings

Set `upgradable: true` in the type's `unitInfo`. Building on top of an
existing one then raises its level instead of placing a new one. The engine,
the build menu and the level number drawn on the map all handle this already.
Each extra level costs what one more building would.

To make an effect grow with the stack, read the levels and not the building
count:

```ts
config.workingLevels(player, UnitType.MyBuilding, cap);
```

This sums the levels of finished, active, paid-up buildings, up to `cap`. The
Civic Center does this in `Config.workingCivicCenters`.

## Buildings with upkeep

`packages/engine/src/execution/UpkeepStructureExecution.ts` charges the owner
`goldPerLevel × level` once every interval. A building whose owner can't pay
gets `UnitStatus.NoFunds`: it stops counting in `workingLevels` and shows a
"!" badge. To add one:

1. Add an entry to `UPKEEP_STRUCTURES`, for example
   `{ goldPerLevel: c => c.myUpkeep(), interval: c => c.myInterval() }`.
2. In `ConstructionExecution`, send the type to `UpkeepStructureExecution`
   (copy the `CivicCenter` case).

## Population density sources

Troops die where people live. When land is conquered or nuked, the troops
lost come from that tile's population density, not an even split of the
player's army. The model lives in
`packages/engine-lib/src/game/PopulationDensity.ts`.

To make a building pack people around it, add a row to
`Config.populationDensitySources()`:

```ts
[UnitType.MyBuilding]: { peak: 2, radius: 15 },
```

`peak` is the extra density at the building, per level. It fades to nothing
at `radius` tiles. A player with no sources loses troops exactly as before.

Density is derived from buildings and never stored, so adding a source needs
no snapshot change. Players see it in the hover panel as "Population here:
N× average".

## Unit behaviors

Reusable unit AI lives in `packages/engine/src/execution/behaviors/`.

Three pieces work together:

- `FrontMap.frontSlots(mg, owner)` turns the fighting into weighted slots,
  one per aura-sized cell of front line:
  - **Attack**: tiles one of the owner's attacks on a player is fighting
    over. Weight doubles near an enemy Defense Post.
  - **Defend**: the owner's tiles an incoming attack is about to take,
    weighted by the attacker's troops against ours.
  - **Watch**: border with a Hostile player, used only when nothing is being
    fought over.

  Each slot has a stage tile `tankStandoff` tiles behind the line, so units
  wait inside aura range without standing where they'd be overrun.

- `FrontAssigner` places all of an owner's units of one type together, in
  rounds. Each round sends the nearest free unit to the uncovered slot with
  the most weight left. A fight counts for less with each unit it already
  has, so units spread over several attacks and defenses. A unit only
  leaves its slot for one heavier by `tankReassignMargin` percent.
- `FrontSeeker.seekFront(mg, unit)` is the one call a unit execution makes.

`TankExecution` shows how to use them:

- Call `registerFrontUnit(unit, state)` in `init` and `restoreSnapshot`, so
  the assigner can read whether the unit is free, its auto target, and the
  targets its route search recently failed on.
- Seek on a fixed interval, with every unit on the same tick
  (`ticks % interval === 0`). The assignment is memoized for that tick.
- Remember the target you chose, so you can tell it apart from a player's
  order. Never override an order from the player.
- After an order from the player arrives, hold position for a while.

Tanks also give a **defensive aura**: attacks on tiles near a defender's
tank lose more troops and go slower (`tankDefenseBonus`). Tanks on both
sides cancel out. An idle tank about to be overrun backs off
`tankStandoff` tiles.

Routing uses `AStarLandBounded`, which stops after a fixed search budget.
A route that's cut is repaired from where the tank is. An auto target that
can't be reached is avoided for `tankFailedTargetTicks`; a player's order
that can't be reached shows a message.

The tank's settings are in `EngineConfig`: `tankAutoFront`,
`tankFrontSeekInterval`, `tankManualHoldTicks`, `tankStandoff`,
`tankReassignMargin`, `tankFailedTargetTicks` and `tankDefenseBonus`.

## Status indicators

To show an effect above a unit:

1. Append a bit to `UnitStatus`.
2. Call `unit.setStatus(bit, on)` from the unit's execution.
3. Add an entry to `src/client/render/UnitStatusIndicators.ts`.

The shapes are drawn procedurally, so the renderer needs no other changes.

## Unit sprite size

`src/client/render/gl/UnitScale.ts` keeps units between `minScreenPx` and
`maxScreenPx` on screen at every zoom level. Health bars, veterancy pips and
status rings scale along with the sprite.

- To size a unit type, add it to `unit.typeScale` in
  `src/client/render/gl/render-settings.json`. The key is the unit type's
  name, and a type with no entry draws at 1.
- If an atlas column is a variant of a type rather than a type of its own,
  map it in `COL_TYPE_ALIAS` in `gl/passes/UnitPass.ts`. The tank headings
  and the train cars work this way.
- Players set the overall size in Settings → Graphics → Units → "Unit size".
- Developers can tune all of these live in the render debug GUI, under
  Unit → Per-Type Scale.

## Military Bases and trained troops

A Military Base (`UnitType.MilitaryBase`) is a stackable upkeep building
(see above). Each player has a pool of trained troops, a part of
`troops()`: `trainedTroops()` and `trainedShare()` on the player.

- **Training** runs in `PlayerExecution` through `trainTick` in
  `packages/engine/src/game/Military.ts`, every `TRAIN_INTERVAL` ticks. It
  adds `trainRatePerLevel × level` of the army each tick, up to
  `trainedCap(level)`.
- **Training level** (`trainingLevel`) is the player's working base levels
  plus `allyTrainingShare` × the levels of allies who border them.
- **Losses** take trained troops in proportion (`removeTroops`), so a fight
  doesn't strip out the trained ones first. An attack keeps the trained
  share it launched with, and survivors come home trained.
- **Home climate**: each base is at home in the climate most of its
  surroundings have (`homeClimate`, radius `militaryBaseClimateRadius`).
  Trained troops fighting on a tile of a home climate get
  `homeClimateBonus` on top.

The tunables are in `Config` under "Military Base". To give another
building a training effect, count it in `trainingLevel`.

## Climate zones

`packages/engine-lib/src/game/Climate.ts` derives Temperate, Arid, Cold,
Coastal and Highland from the map: elevation, distance to water, and
latitude. Nothing is stored. The zones are cached per map until the terrain
changes (`waterVersion`). `climateAt(map, tile)` works on both the engine
and the client.

## Entrenchment

`GameImpl` stores the tick each tile was taken (`heldFor(tile)`, 16-tick
resolution, saved in the game snapshot). `entrenchment(tile, owner)` rises
from 0 to 1 over `entrenchTicks(baseLevels)`. In `attackLogic`, the
defender's strength goes from `entrenchFresh()` on fresh land to
`entrenchMax(baseLevels)` on dug-in land.

## Fork combat inputs

`AttackLogicInput` takes optional fork fields: `attackerTrained`,
`defenderTrained`, `entrenchment`, `defenderBaseLevels`,
`defenderHasAllySupport` and `attackerHasJointAttack`. They are applied by
`EngineConfig.forkCombatModifiers`. A field that is left out multiplies by
exactly 1, so older callers and tests are unaffected.

`AttackExecution.buildTickCtx` computes the per-tick parts once per attack
per tick. To add a new combat effect:

1. Add the field.
2. Fold it into `forkCombatModifiers`.
3. Fill it in `AttackExecution.forkInputs`.

## Alliances in war

- **Ally support**: a tile next to land held by an ally of the defender is
  harder to take.
- **Joint attack**: attacking a player that one of your allies is also
  attacking is cheaper and faster.
- **Call to arms**: nations attack whoever is attacking their allies
  (`AiAttackBehavior.defendAllies`) before saving up to their trigger ratio.
  Human allies get an "ally under attack" message.
- **Lent training**: see the training level above.

## Map view modes

`src/client/render/ViewMode.ts` lists the view modes. The picker
(`hud/layers/ViewModePicker.ts`, under the top-right bar) and the V hotkey
switch between them, and `controllers/ViewModeController.ts` applies them.

To add an overlay mode:

1. Add a value to `ViewMode`.
2. Return true for it from `isOverlayMode`.
3. Write a function that returns a `TileOverlay` (one palette index per
   tile, 0 = transparent) in `render/ViewOverlayData.ts`.
4. Push it from `ViewModeController.setMode`.
5. Add `view_mode.<value>` to `en.json`.

`TileOverlayPass` draws the overlay between territory and borders.

## Adding a WASM kernel (Rust)

Hot, self-contained engine loops can have a Rust twin compiled to
WebAssembly. The first one is the border-cluster flood fill in
`PlayerExecution.calculateClusters`. In a real game it runs 2.9× faster than
the TypeScript version, including the cost of copying data in and out.

**How it fits together:**

- **Rust crate:** `packages/engine-wasm/` (`src/lib.rs`). It has no
  dependencies and no wasm-bindgen; kernels are plain `extern "C"` functions
  over pointers into linear memory, and `kernel_alloc` hands out buffers.
- **Build:** `npm run build:wasm` writes `resources/wasm/engine_kernels.wasm`.
  The built file is committed, so contributors without Rust and the Docker
  build don't need a toolchain. Rebuild it and commit whenever `lib.rs`
  changes. One-time setup: `rustup target add wasm32-unknown-unknown`.
- **Loader:** `packages/engine/src/wasm/Kernels.ts`.
  - The host installs the module's bytes with `installKernelWasm()`. In the
    browser, `WorkerClient` fetches the file and passes the bytes in the
    worker's init message.
  - Each game gets its own instance through `kernelsFor(game, w, h)`, which
    returns null when no kernels are installed.
  - Make fresh typed-array views of `memory.buffer` on every call: growing
    memory detaches the old ones.
- **Turning it off:** set localStorage `fork:nowasm` to `1`, or call
  `setKernelsDisabled(true)` in tests and benchmarks. Without the bytes,
  every caller runs its TypeScript path.

**Rules, so clients with and without WASM stay in sync:**

- Integer math only.
- Visit and output in exactly the order the TypeScript does: same neighbor
  order, same stack discipline.
- Keep the TypeScript path as the fallback, behind a single
  `kernelsFor(...)` check at the call site.

**To add a kernel:**

1. Write it in `lib.rs` as a safe `*_impl` function plus a thin
   `#[no_mangle] extern "C"` wrapper. Add a `cargo test` for it.
2. Declare it in `KernelExports` and wrap it in a `GameKernels` method.
3. Call it from the hot spot when `kernelsFor()` isn't null.
4. Add parity checks to `tests/WasmKernels.test.ts`: the kernel against the
   TypeScript path on random input, and a whole game run with and without
   WASM producing the same hashes.
5. Measure with `npm run perf:game -- --wasm` against a run without the flag.
   The final hash must match. Keep the kernel only if it is clearly faster
   (at least 1.5× including the copies).

Profile before porting anything. Most engine time sits in code that touches
game objects, not flat arrays, and Rust can't help there; see the per-tick
numbers in the commit history.

## Nation personalities

`packages/engine/src/game/NationPersonality.ts`. Before this, nations
differed only by game difficulty plus four random ratios each
(`triggerRatio`, `reserveRatio`, `expandRatio`, `attackRate`). Each nation
now also rolls an archetype and five traits, 0..100, from its own PRNG
(nation id + game id), so the main PRNG stream is unchanged:

| Trait        | Changes                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| aggression   | lower trigger ratio, faster decisions, `hated`/`weakest` pulled forward, more Military Bases, builds tanks (40+) |
| loyalty      | betrayal thresholds (85+: only traitors), assists allies it's merely neutral to (70+)                            |
| mercantilism | port/factory ratios, how big a trade share makes a valued partner                                                |
| caution      | bigger reserve, more SAMs, defense posts against smaller attacks                                                 |
| ambition     | `crown` pulled forward (75+)                                                                                     |

Archetypes (Balanced ×2, Warmonger, Merchant, Diplomat, Opportunist,
Turtle) are presets plus ±10 jitter. Players see the archetype in the hover
panel ("Nation · Merchant").

Rules for adding a trait effect:

- Use the helpers (`scaled`, `scaledInt`, `likelierOdds`). They return the
  input unchanged at 50, so a trait of 50 behaves like the old code.
- Never add a PRNG draw for a trait; rescale numbers already in use.
- Read traits with `personalityOf(player)`. It returns `NEUTRAL` for bots,
  humans and games with `nationPersonalities()` off.

The personality is saved in the `NationExecution` snapshot (v2) and
re-registered on restore.

## Trade ledger and trading nations

`Player.recordTrade(partner, gold)` is called for both sides when a trade
ship arrives and when a train stops at a foreign station.
`tradeVolumeWith(p)` reads it. The ledger halves every
`tradeLedgerDecayTicks` (600), so it shows recent trade. It's in the player
snapshot (v3).

`execution/nation/NationTradeBehavior.ts` turns that into diplomacy, scaled
by mercantilism and only with personalities on:

- **Trade breeds friendship.** Relation with each partner rises with its
  share of our trade, up to Friendly.
- **Valued partners are protected.** A partner with a big enough share of
  our trade is skipped by `juicy`, `hated` and `weakest` (unless aggression
  is 70+). It isn't embargoed over a grudge, an embargo against it lifts at
  Neutral, and alliance requests from it are accepted.

## Coalitions

`packages/engine/src/game/Coalitions.ts` (`game.coalitions()`). A
coalition is a lasting group of players at peace with each other. Its
leader can ban trade with outsiders and give attack orders.

- **Peace.** Members are `isFriendly` with each other, like teammates. They
  can't attack each other, and joining cancels nukes already in flight
  between them. Membership never expires. Joining drops any pairwise
  alliance with other members, because it's no longer needed.
- **War effects.** `Military.friendsForWar(player)` (allies plus coalition
  members) feeds ally support, joint attacks, lent training and the call
  to arms.
- **Sanctions.** `PlayerImpl.canTrade` returns false between a sanctioned
  player and every member of the coalition. Ships, ports and trains
  already check `canTrade`.
- **Attack order.** The leader names a target. It's added to every member's
  `transitiveTargets()`, and attacking it counts as a joint attack. It
  lasts `coalitionTargetDuration`, with `coalitionTargetCooldown` between
  orders. Human members get a call-to-arms message.
- **Leaving** breaks the peace: the leaver is marked a traitor, the way
  breaking an alliance does. A nuke that hits a member also counts as
  leaving. Being kicked doesn't make you a traitor. Either way, the player
  can't join any coalition for `coalitionRejoinCooldown`.
- **Leadership.** If the leader leaves or is eliminated, the member with
  the most land takes over. A coalition left with one member dissolves.
- **When it's off.** Coalitions are disabled in team games and when
  alliances are disabled.

**Intents and executions.** There are eight `coalition_*` intents, appended
to `IntentSchema`. All of them map to the one-shot `CoalitionExecution`.
The manager validates every action itself, because intents come from
clients.

**Updates to clients.**

- `GameUpdateType.Coalitions` carries the full `CoalitionView` list after
  every change. Replays store it as a misc update.
- `GameUpdateType.CoalitionInvite` is sent for each invite.

**Saving.** Pending invites, cooldowns and coalitions are saved in the game
snapshot (v3, `coalitions`).

### Nations in coalitions

`execution/nation/NationCoalitionBehavior.ts` runs on every nation decision
tick. It only applies to nations with a personality, and it never draws
from the PRNG.

- **Invites.** A nation accepts if it doesn't distrust the inviter and has
  at least one of these reasons:
  - the inviter is a friend,
  - a trade partner is already a member,
  - safety in numbers (only nations with caution 60+ count this),
  - loyalty 70+.

  It never joins a coalition that has a member it hates.

- **Founding.** A nation with ambition 60+ founds "<Name> Pact" once it has
  at least two friends or trade partners to invite. If it is still alone
  after 3 minutes, it disbands the pact.
- **Leading.** Each cycle the leader invites one candidate, best trade
  partner first. It sanctions any player that two or more members are
  Hostile to, and lifts the sanction once none are. While no order is
  active, it orders an attack on the weakest Hostile neighbor of the
  coalition.
- **Following.** `AiAttackBehavior.followCoalitionOrder` attacks the
  ordered target before the nation saves up troops; members with loyalty
  under 25 ignore orders. `defendAllies` also defends fellow coalition
  members.
- **Leaving.** A member leaves when it comes to distrust the leader and its
  loyalty is under 40. A member with loyalty under 25 also leaves when it
  has 3× the troops of a bordering member.

### Weapon bans

The coalition leader can ban any of `BANNABLE_WEAPONS`: atom bomb,
hydrogen bomb, MIRV, tank and warship (`coalition_ban` intent; checkboxes
in the coalition panel).

- **Members** can't build or launch a banned weapon. `PlayerImpl.canBuild`
  refuses it, so the build menu greys it out. Units built before the ban
  stay.
- **Outsiders** who use a banned weapon on a member are sanctioned
  automatically, and every member's relation with them drops.
  `Coalitions.reportWeaponUse` is called when:
  - a nuke hits a member,
  - a MIRV is launched at a member,
  - a tank supports an attack on a member's tile,
  - a warship fires on a member's ship.

  The coalition remembers violators. Nation leaders order attacks on recent
  violators first.

- **Tank auto-deploy** stays away from fronts against a coalition that
  banned tanks. A player can still drive there on purpose.
- **Nations decide by personality:**
  - As leaders, nations with caution 60+ and Diplomats ban hydrogen bombs
    and MIRVs; caution 75+ bans atom bombs too; aggression ≤ 30 bans
    tanks; aggression 70+ bans nothing.
  - As members, warlike (75+) and not loyal (< 60) nations leave a
    coalition, or refuse to join one, that bans weapons they own (tanks,
    or silos for the nuclear bans).
  - Cautious nations count a nuke ban as a reason to join.
  - As outsiders, nations don't use a banned weapon on members
    (`NationTreaties.respectsWeaponBan`) unless they're aggressive (70+)
    and not cautious.

## Non-aggression pacts

`packages/engine/src/game/Pacts.ts` (`game.pacts()`). Two players promise
not to attack each other for 5, 10 or 20 minutes (`PACT_MINUTES`).

- A pact isn't friendship: there's no shared defense, no donations, and
  embargoes still work.
- Attacks aren't blocked. Attacking a partner, sailing a boat attack at
  them or nuking them breaks the pact immediately: the attacker is marked a
  traitor (the same penalty as breaking an alliance), and the victim's
  relation with them drops by 100. Breaking a pact on purpose
  (`pact_break`) costs the same.
- If a proposal is refused, the proposer waits 2 minutes before asking that
  player again.
- **Intents:** `pact_propose`, `pact_reply`, `pact_break`, all handled by
  `PactExecution`.
- **Updates:** `GameUpdateType.Pacts` (the full list) and `PactProposal`.
- **Saving:** game snapshot v4.

`execution/nation/NationPactBehavior.ts`:

- **Accepting.** A nation accepts a proposal if any of these is true:
  - the proposer is stronger,
  - the nation is busy fighting someone else,
  - the proposer is a valued trade partner,
  - the nation is cautious (60+).

  It refuses if:
  - it hates the proposer,
  - the proposer is a traitor and the nation is loyal (50+),
  - it is greedy (aggression 75+) and the proposer is weaker.

- **Proposing.** Nations with caution 55+ ask their strongest non-friendly
  neighbor that outnumbers them. The more cautious they are, the longer
  the pact they ask for.
- **Keeping the pact.** `respectsPact` keeps nations from attacking or
  nuking a partner. The exception is a backstab: a nation with loyalty
  under 25 that has 3× the partner's troops.
