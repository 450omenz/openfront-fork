/**
 * The Rust/WASM kernels (packages/engine-wasm) must give exactly what the
 * TypeScript they replace gives, or clients with and without WASM drift
 * apart. Two checks: the kernel against the TypeScript fill on random
 * territories, and whole games run both ways ending on the same hash.
 */
import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  BorderClusters,
  installKernelWasm,
  kernelsFor,
  setKernelsDisabled,
} from "@openfront/engine/wasm/Kernels";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "./util/Setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "../resources/wasm/engine_kernels.wasm");

function hash(game: Game): number {
  return (game as unknown as { hash(): number }).hash();
}

/** The TypeScript path of PlayerExecution.calculateClusters. */
function tsClusters(game: Game, player: Player): BorderClusters {
  setKernelsDisabled(true);
  try {
    const exec = new PlayerExecution(player);
    exec.init(game, game.ticks());
    return (
      exec as unknown as { calculateClusters(): BorderClusters }
    ).calculateClusters();
  } finally {
    setKernelsDisabled(false);
  }
}

describe("WASM kernels", () => {
  beforeAll(() => installKernelWasm(new Uint8Array(fs.readFileSync(WASM))));
  afterAll(() => installKernelWasm(null));

  test("border clusters match the TypeScript fill on random territories", async () => {
    const game = await setup("big_plains", {}, [
      new PlayerInfo("p", PlayerType.Human, null, "p"),
    ]);
    const p = game.player("p");
    const random = new PseudoRandom(7);
    const w = game.width();
    const h = game.height();
    // Scattered blobs and lone tiles: many clusters, diagonal touches, edges.
    for (let blob = 0; blob < 60; blob++) {
      const cx = random.nextInt(0, w);
      const cy = random.nextInt(0, h);
      const r = random.nextInt(0, 6);
      for (let y = cy - r; y <= cy + r; y++) {
        for (let x = cx - r; x <= cx + r; x++) {
          if (!game.isValidCoord(x, y)) continue;
          const t = game.ref(x, y);
          if (game.isLand(t) && random.chance(4) === false) p.conquer(t);
        }
      }
    }
    expect(p.borderTiles().size).toBeGreaterThan(100);

    const kernels = kernelsFor(game, w, h)!;
    expect(kernels).not.toBeNull();
    for (let round = 0; round < 3; round++) {
      const want = tsClusters(game, p);
      const got = kernels.borderClusters(p.borderTiles());
      expect(got.clusters.length).toBeGreaterThan(1);
      expect(got.clusters).toEqual(want.clusters);
      expect([...got.boxes]).toEqual([
        ...want.boxes.slice(0, want.clusters.length * 4),
      ]);
      // Change the territory and go again: generations must not leak.
      for (let i = 0; i < 200; i++) {
        const t = game.ref(random.nextInt(0, w), random.nextInt(0, h));
        if (game.isLand(t) && game.owner(t) !== p) p.conquer(t);
      }
    }
  });

  test("a nation game ends on the same hash with and without WASM", async () => {
    const run = async (useWasm: boolean) => {
      setKernelsDisabled(!useWasm);
      try {
        const manifest = JSON.parse(
          fs.readFileSync(
            path.join(__dirname, "testdata/maps/world/manifest.json"),
            "utf8",
          ),
        ) as { nations: { coordinates: [number, number]; name: string }[] };
        const nations = manifest.nations.map(
          (n) =>
            new Nation(
              new Cell(n.coordinates[0], n.coordinates[1]),
              new PlayerInfo(n.name, PlayerType.Nation, null, n.name),
            ),
        );
        const game = await setup(
          "world",
          { difficulty: Difficulty.Impossible },
          [],
          undefined,
          EngineConfig,
          false,
          nations,
        );
        for (const nation of nations) {
          game.addExecution(new NationExecution("game_id", nation));
        }
        const hashes: number[] = [];
        let spawnEnded = false;
        for (let t = 0; t < 1500; t++) {
          if (!spawnEnded && game.allPlayers().every((q) => q.hasSpawned())) {
            game.endSpawnPhase();
            spawnEnded = true;
          }
          game.executeNextTick();
          if (t % 100 === 0) hashes.push(hash(game));
        }
        return hashes;
      } finally {
        setKernelsDisabled(false);
      }
    };
    const withWasm = await run(true);
    const without = await run(false);
    expect(withWasm).toEqual(without);
  }, 600_000);
});
