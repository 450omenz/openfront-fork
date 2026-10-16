import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { MinHeap } from "./PriorityQueue";

// 4-direction A* over land, confined to the bounding box of start and goal
// (plus a margin). Buffers are sized for the largest allowed box, so one
// instance can be shared by every tank in a game. Passability is decided by
// the caller (e.g. "land owned by the tank's owner").
//
// Deterministic: integer costs, fixed neighbor order (N, S, W, E).
export class AStarLandBounded {
  private stamp = 1;
  private readonly closedStamp: Uint32Array;
  private readonly gScoreStamp: Uint32Array;
  private readonly gScore: Uint32Array;
  private readonly cameFrom: Int32Array;
  private readonly queue: MinHeap;

  constructor(
    private readonly map: GameMap,
    private readonly maxArea: number,
    private readonly margin: number = 16,
  ) {
    this.closedStamp = new Uint32Array(maxArea);
    this.gScoreStamp = new Uint32Array(maxArea);
    this.gScore = new Uint32Array(maxArea);
    this.cameFrom = new Int32Array(maxArea);
    this.queue = new MinHeap(maxArea * 4);
  }

  /** Path from start to goal (both inclusive), or null if unreachable. */
  findPath(
    start: TileRef,
    goal: TileRef,
    passable: (t: TileRef) => boolean,
  ): TileRef[] | null {
    if (start === goal) return [start];
    if (!passable(goal)) return null;

    const map = this.map;
    const w = map.width();
    const sx = map.x(start);
    const sy = map.y(start);
    const gx = map.x(goal);
    const gy = map.y(goal);
    const minX = Math.max(0, Math.min(sx, gx) - this.margin);
    const maxX = Math.min(w - 1, Math.max(sx, gx) + this.margin);
    const minY = Math.max(0, Math.min(sy, gy) - this.margin);
    const maxY = Math.min(map.height() - 1, Math.max(sy, gy) + this.margin);
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw * bh > this.maxArea) return null;

    this.stamp++;
    if (this.stamp > 0xffffffff) {
      this.closedStamp.fill(0);
      this.gScoreStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const local = (x: number, y: number) => (y - minY) * bw + (x - minX);

    const queue = this.queue;
    queue.clear();
    const startL = local(sx, sy);
    const goalL = local(gx, gy);
    this.gScore[startL] = 0;
    this.gScoreStamp[startL] = stamp;
    this.cameFrom[startL] = -1;
    queue.push(startL, Math.abs(sx - gx) + Math.abs(sy - gy));

    while (!queue.isEmpty()) {
      const cur = queue.pop();
      if (this.closedStamp[cur] === stamp) continue;
      this.closedStamp[cur] = stamp;
      if (cur === goalL) return this.buildPath(goalL, bw, minX, minY, w);

      const cx = (cur % bw) + minX;
      const cy = ((cur / bw) | 0) + minY;
      const g = this.gScore[cur] + 1;
      // N, S, W, E
      for (let i = 0; i < 4; i++) {
        const nx = i === 2 ? cx - 1 : i === 3 ? cx + 1 : cx;
        const ny = i === 0 ? cy - 1 : i === 1 ? cy + 1 : cy;
        if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
        const nl = local(nx, ny);
        if (this.closedStamp[nl] === stamp) continue;
        if (this.gScoreStamp[nl] === stamp && this.gScore[nl] <= g) continue;
        const tile = ny * w + nx;
        if (!passable(tile)) continue;
        this.gScore[nl] = g;
        this.gScoreStamp[nl] = stamp;
        this.cameFrom[nl] = cur;
        queue.push(nl, g + Math.abs(nx - gx) + Math.abs(ny - gy));
      }
    }
    return null;
  }

  private buildPath(
    goalL: number,
    bw: number,
    minX: number,
    minY: number,
    w: number,
  ): TileRef[] {
    const path: TileRef[] = [];
    for (let l = goalL; l !== -1; l = this.cameFrom[l]) {
      path.push((((l / bw) | 0) + minY) * w + ((l % bw) + minX));
    }
    return path.reverse();
  }
}
