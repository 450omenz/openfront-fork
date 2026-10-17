import { TileRef } from "@openfront/engine-api/game/GameMap";

/**
 * Optional Rust/WASM kernels for hot simulation loops (fork). The crate lives
 * in packages/engine-wasm; `npm run build:wasm` builds it into
 * resources/wasm/engine_kernels.wasm.
 *
 * The host installs the module's bytes once (installKernelWasm) before games
 * are created; without them every caller keeps its TypeScript path. Both
 * paths give identical results (tests/WasmKernels.test.ts), so clients with
 * and without WASM stay in sync.
 *
 * Each game gets its own instance: the kernel keeps per-map scratch (a
 * visited array) in its linear memory. Views into that memory are made fresh
 * on every call, since growing it detaches the old buffer.
 */

interface KernelExports {
  memory: WebAssembly.Memory;
  kernel_alloc(bytes: number): number;
  border_clusters(
    visited: number,
    width: number,
    height: number,
    border: number,
    nBorder: number,
    borderGen: number,
    currentGen: number,
    outTiles: number,
    outStarts: number,
    outBoxes: number,
    stack: number,
  ): number;
}

let kernelModule: WebAssembly.Module | null = null;
let disabled = false;

/** Installs (or with null, removes) the kernels for games created after. */
export function installKernelWasm(bytes: Uint8Array<ArrayBuffer> | null): void {
  kernelModule = bytes === null ? null : new WebAssembly.Module(bytes);
}

/** Turns the kernels off without uninstalling them (benchmarks, tests). */
export function setKernelsDisabled(off: boolean): void {
  disabled = off;
}

export function kernelsInstalled(): boolean {
  return kernelModule !== null && !disabled;
}

/** Border clusters as PlayerExecution.calculateClusters returns them. */
export interface BorderClusters {
  clusters: TileRef[][];
  boxes: Int32Array;
}

export class GameKernels {
  private readonly ex: KernelExports;
  private readonly visitedPtr: number;
  private gen = 0;
  // Scratch sized for the largest border seen so far.
  private cap = 0;
  private borderPtr = 0;
  private outTilesPtr = 0;
  private outStartsPtr = 0;
  private outBoxesPtr = 0;
  private stackPtr = 0;

  constructor(
    module: WebAssembly.Module,
    private readonly width: number,
    private readonly height: number,
  ) {
    const instance = new WebAssembly.Instance(module, {});
    this.ex = instance.exports as unknown as KernelExports;
    this.visitedPtr = this.alloc(width * height * 4);
  }

  private alloc(bytes: number): number {
    const ptr = this.ex.kernel_alloc(bytes);
    if (ptr === 0) throw new Error("WASM kernel out of memory");
    return ptr;
  }

  private ensureCapacity(n: number): void {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2, 1024);
    // Bump allocator: old buffers are abandoned, so capacity only doubles.
    this.borderPtr = this.alloc(cap * 4);
    this.outTilesPtr = this.alloc(cap * 4);
    this.outStartsPtr = this.alloc((cap + 1) * 4);
    this.outBoxesPtr = this.alloc(cap * 16);
    this.stackPtr = this.alloc(cap * 4);
    this.cap = cap;
  }

  /** Two fresh generation stamps; the visited array is never cleared. */
  private bumpGenerations(): number {
    if (this.gen >= 0xfffffff0) {
      new Uint32Array(
        this.ex.memory.buffer,
        this.visitedPtr,
        this.width * this.height,
      ).fill(0);
      this.gen = 0;
    }
    this.gen += 2;
    return this.gen - 1;
  }

  /**
   * Splits `border` (iterated with forEach, in the engine's order) into
   * 8-connected clusters. Same result as PlayerExecution's TypeScript path.
   */
  borderClusters(border: {
    readonly size: number;
    forEach(cb: (t: TileRef) => void): void;
  }): BorderClusters {
    const n = border.size;
    this.ensureCapacity(n);
    const borderGen = this.bumpGenerations();
    const mem = this.ex.memory.buffer;
    const input = new Uint32Array(mem, this.borderPtr, n);
    let i = 0;
    border.forEach((t) => {
      input[i++] = t;
    });
    const count = this.ex.border_clusters(
      this.visitedPtr,
      this.width,
      this.height,
      this.borderPtr,
      n,
      borderGen,
      borderGen + 1,
      this.outTilesPtr,
      this.outStartsPtr,
      this.outBoxesPtr,
      this.stackPtr,
    );
    // The call can't grow memory, so `mem` is still attached.
    const tiles = new Uint32Array(mem, this.outTilesPtr, n);
    const starts = new Uint32Array(mem, this.outStartsPtr, count + 1);
    const clusters: TileRef[][] = new Array(count);
    for (let c = 0; c < count; c++) {
      const from = starts[c];
      const to = starts[c + 1];
      const cluster: TileRef[] = new Array(to - from);
      for (let k = from; k < to; k++) cluster[k - from] = tiles[k];
      clusters[c] = cluster;
    }
    const boxes = new Int32Array(mem, this.outBoxesPtr, count * 4).slice();
    return { clusters, boxes };
  }
}

const perGame = new WeakMap<object, GameKernels | null>();

/**
 * The kernels for a game (keyed by the game object, so nothing shows up in
 * snapshots), or null when none are installed or they're turned off.
 */
export function kernelsFor(
  game: object,
  width: number,
  height: number,
): GameKernels | null {
  if (kernelModule === null || disabled) return null;
  let k = perGame.get(game);
  if (k === undefined) {
    k = new GameKernels(kernelModule, width, height);
    perGame.set(game, k);
  }
  return k;
}
