import { describe, expect, it } from "vitest";
import { buildRelationMatrix } from "../../../../../src/client/render/frame/derive/RelationMatrix";

// Fork: coalitions in the relation matrix the renderer colors borders by.
describe("buildRelationMatrix with coalitions", () => {
  const at = (m: Uint8Array, size: number, a: number, b: number) =>
    m[a * size + b];

  it("marks coalition members friendly and sanctions as embargoes", () => {
    const { matrix, size } = buildRelationMatrix(new Map(), undefined, [
      { memberIDs: [1, 2, 3], sanctionIDs: [5] },
    ]);
    expect(at(matrix, size, 1, 2)).toBe(1);
    expect(at(matrix, size, 3, 1)).toBe(1);
    expect(at(matrix, size, 1, 4)).toBe(0);
    for (const m of [1, 2, 3]) {
      expect(at(matrix, size, m, 5)).toBe(2);
      expect(at(matrix, size, 5, m)).toBe(2);
    }
  });

  it("leaves everything neutral without coalitions", () => {
    const { matrix, size } = buildRelationMatrix(new Map());
    expect(at(matrix, size, 1, 2)).toBe(0);
  });
});
