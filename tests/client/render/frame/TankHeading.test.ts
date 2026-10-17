import {
  DEFAULT_HEADING,
  octant,
  TankHeadingTracker,
} from "../../../../src/client/render/frame/TankHeading";

const W = 100;
const ref = (x: number, y: number) => y * W + x;

// Drive one tank through tiles, one frame per tile; return the last heading.
function drive(tiles: [number, number][], t = new TankHeadingTracker(W)) {
  let dir = DEFAULT_HEADING;
  for (const [x, y] of tiles) {
    t.beginFrame();
    dir = t.heading(1, ref(x, y));
    t.endFrame();
  }
  return dir;
}

describe("octant", () => {
  test("cardinals and diagonals, y down, clockwise from north", () => {
    expect(octant(0, -1)).toBe(0); // N
    expect(octant(1, -1)).toBe(1); // NE
    expect(octant(1, 0)).toBe(2); // E
    expect(octant(1, 1)).toBe(3); // SE
    expect(octant(0, 1)).toBe(4); // S
    expect(octant(-1, 1)).toBe(5); // SW
    expect(octant(-1, 0)).toBe(6); // W
    expect(octant(-1, -1)).toBe(7); // NW
  });
});

describe("TankHeadingTracker", () => {
  test("straight runs face the run direction", () => {
    const east: [number, number][] = [];
    for (let x = 10; x <= 16; x++) east.push([x, 10]);
    expect(drive(east)).toBe(2);
    const south: [number, number][] = [];
    for (let y = 10; y <= 16; y++) south.push([10, y]);
    expect(drive(south)).toBe(4);
  });

  test("a staircase path reads as a diagonal", () => {
    // E, S, E, S ... from (10,10)
    const tiles: [number, number][] = [[10, 10]];
    let [x, y] = [10, 10];
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) x++;
      else y++;
      tiles.push([x, y]);
    }
    expect(drive(tiles)).toBe(3); // SE
  });

  test("a sharp turn is taken on the first step", () => {
    const t = new TankHeadingTracker(W);
    const run: [number, number][] = [];
    for (let x = 10; x <= 16; x++) run.push([x, 10]);
    expect(drive(run, t)).toBe(2); // E
    expect(drive([[16, 11]], t)).toBe(4); // one step south: face S now
  });

  test("standing still keeps the heading", () => {
    const t = new TankHeadingTracker(W);
    const run: [number, number][] = [];
    for (let x = 20; x >= 14; x--) run.push([x, 10]);
    expect(drive(run, t)).toBe(6); // W
    expect(
      drive(
        [
          [14, 10],
          [14, 10],
        ],
        t,
      ),
    ).toBe(6);
  });

  test("forgets tanks that disappear", () => {
    const t = new TankHeadingTracker(W);
    const run: [number, number][] = [];
    for (let x = 10; x <= 16; x++) run.push([x, 10]);
    expect(drive(run, t)).toBe(2);
    t.beginFrame(); // tank 1 absent this frame
    t.endFrame();
    t.beginFrame();
    expect(t.heading(1, ref(16, 10))).toBe(DEFAULT_HEADING);
    t.endFrame();
  });
});
