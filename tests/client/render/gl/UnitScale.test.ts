import {
  screenScale,
  typeScale,
  type UnitScaleSettings,
} from "../../../../src/client/render/gl/UnitScale";

const s: UnitScaleSettings = {
  unitSize: 10,
  sizeMultiplier: 1,
  minScreenPx: 20,
  maxScreenPx: 80,
  typeScale: { Tank: 0.8 },
};

describe("UnitScale", () => {
  test("scales with the map between the clamps", () => {
    expect(screenScale(4, s)).toBe(1); // 40 px on screen
  });

  test("never draws smaller than minScreenPx", () => {
    // 0.5 px per tile: 5 px unclamped, so grow 4× to 20 px.
    expect(screenScale(0.5, s)).toBeCloseTo(4);
  });

  test("never draws larger than maxScreenPx", () => {
    // 20 px per tile: 200 px unclamped, so shrink to 80 px.
    expect(screenScale(20, s)).toBeCloseTo(0.4);
  });

  test("the user's multiplier applies at every zoom", () => {
    const big = { ...s, sizeMultiplier: 1.5 };
    expect(screenScale(4, big)).toBeCloseTo(1.5);
    expect(screenScale(0.5, big)).toBeCloseTo(6);
    expect(screenScale(20, big)).toBeCloseTo(0.6);
  });

  test("per-type scale defaults to 1", () => {
    expect(typeScale("Tank", s)).toBe(0.8);
    expect(typeScale("Warship", s)).toBe(1);
  });
});
