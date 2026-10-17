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

`FrontSeeker.seekFront(mg, owner, unit, opts)` answers two questions: is the
unit already at a front, and if not, which owned tile next to the nearest
front should it drive to? A front is a tile that one of the owner's attacks
on another player is fighting over. The `spread` option keeps a group from
piling onto one tile.

`TankExecution.autoDeploy()` shows how to use it:

- Search on a staggered interval: `(ticks + unit.id()) % interval`.
- Remember the target you chose, so you can tell it apart from a player's
  order. Never override an order from the player.
- After an order from the player arrives, hold position for a while.

The tank's settings are in `EngineConfig`: `tankAutoFront`,
`tankFrontSeekInterval`, `tankManualHoldTicks` and `tankFrontSpread`.

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
