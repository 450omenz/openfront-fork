import { Archetype } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { Player } from "./Game";

/**
 * Nation personalities (fork).
 *
 * Every nation gets an archetype and five integer traits, 0..100, drawn
 * from its own PRNG (seeded from the nation's id and the game id), so the
 * nation's main PRNG stream — and every decision that draws from it — is
 * untouched by the draw itself.
 *
 *   aggression    attacks sooner and more often; builds tanks
 *   loyalty       sticks with allies and coalitions; betrays less
 *   mercantilism  builds trade, protects trade partners, embargoes less
 *   caution       keeps more troops back, defends more
 *   ambition      goes for the leader; founds and leads coalitions
 *
 * 50 is the baseline: every helper below returns the unchanged value at
 * 50, so a trait of 50 behaves exactly like the code before personalities.
 * NEUTRAL (all 50) is what non-nations and games with
 * nationPersonalities() off get.
 *
 * Helpers only rescale numbers the code already uses (ratios, odds,
 * thresholds) and never add PRNG draws, so turning personalities off
 * reproduces the old game exactly.
 */
export interface Personality {
  archetype: Archetype;
  aggression: number;
  loyalty: number;
  mercantilism: number;
  caution: number;
  ambition: number;
}

export type Trait = Exclude<keyof Personality, "archetype">;

export const NEUTRAL: Readonly<Personality> = Object.freeze({
  archetype: Archetype.Balanced,
  aggression: 50,
  loyalty: 50,
  mercantilism: 50,
  caution: 50,
  ambition: 50,
});

const PRESETS: Record<Archetype, Omit<Personality, "archetype">> = {
  [Archetype.Balanced]: {
    aggression: 50,
    loyalty: 50,
    mercantilism: 50,
    caution: 50,
    ambition: 50,
  },
  [Archetype.Warmonger]: {
    aggression: 85,
    loyalty: 35,
    mercantilism: 25,
    caution: 30,
    ambition: 65,
  },
  [Archetype.Merchant]: {
    aggression: 30,
    loyalty: 60,
    mercantilism: 90,
    caution: 55,
    ambition: 40,
  },
  [Archetype.Diplomat]: {
    aggression: 35,
    loyalty: 85,
    mercantilism: 60,
    caution: 50,
    ambition: 60,
  },
  [Archetype.Opportunist]: {
    aggression: 60,
    loyalty: 15,
    mercantilism: 50,
    caution: 40,
    ambition: 75,
  },
  [Archetype.Turtle]: {
    aggression: 20,
    loyalty: 60,
    mercantilism: 55,
    caution: 90,
    ambition: 25,
  },
};

// Balanced appears twice: a third of nations stay close to the baseline.
const ARCHETYPE_POOL: Archetype[] = [
  Archetype.Balanced,
  Archetype.Balanced,
  Archetype.Warmonger,
  Archetype.Merchant,
  Archetype.Diplomat,
  Archetype.Opportunist,
  Archetype.Turtle,
];
const JITTER = 10;
const SALT = 0x9e3779b9;
const TRAITS: Trait[] = [
  "aggression",
  "loyalty",
  "mercantilism",
  "caution",
  "ambition",
];

export function rollPersonality(nationID: string, gameID: string): Personality {
  const rand = new PseudoRandom(
    (simpleHash(nationID) + simpleHash(gameID) + SALT) | 0,
  );
  const archetype = rand.randElement(ARCHETYPE_POOL);
  const preset = PRESETS[archetype];
  const p = { archetype } as Personality;
  for (const t of TRAITS) {
    const v = preset[t] + rand.nextInt(-JITTER, JITTER + 1);
    p[t] = Math.max(0, Math.min(100, v));
  }
  return p;
}

// Live personalities by player. NationExecution sets them in init and
// restoreSnapshot (the personality itself is in its snapshot), so this map
// never holds state a snapshot doesn't.
const registry = new WeakMap<Player, Personality>();

export function setPersonality(player: Player, p: Personality): void {
  registry.set(player, p);
}

/** The archetype of a nation with a personality, else undefined. */
export function archetypeOf(player: Player): Archetype | undefined {
  return registry.get(player)?.archetype;
}

export function personalityOf(player: Player): Readonly<Personality> {
  return registry.get(player) ?? NEUTRAL;
}

/** Trait offset from the baseline, -1..1. */
function lean(trait: number): number {
  return (trait - 50) / 50;
}

/**
 * `base` scaled by up to ±`spread` (a fraction) as the trait goes from 50
 * to 100 / 0. E.g. scaled(0.5, 100, 0.2) = 0.6; scaled(0.5, 50, x) = 0.5.
 */
export function scaled(base: number, trait: number, spread: number): number {
  if (trait === 50) return base;
  return base * (1 + lean(trait) * spread);
}

/** Integer version of scaled(), rounded, at least `min`. */
export function scaledInt(
  base: number,
  trait: number,
  spread: number,
  min = 1,
): number {
  if (trait === 50) return base;
  return Math.max(min, Math.round(scaled(base, trait, spread)));
}

/**
 * Odds for PseudoRandom.chance() ("1 in n") made more likely as the trait
 * rises: n shrinks by up to `spread` at 100 and grows at 0.
 */
export function likelierOdds(n: number, trait: number, spread: number): number {
  if (trait === 50) return n;
  return Math.max(1, Math.round(n * (1 - lean(trait) * spread)));
}
