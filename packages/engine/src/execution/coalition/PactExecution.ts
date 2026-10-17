import { PlayerID } from "@openfront/engine-api/game/GameTypes";
import { zPlayerRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player } from "../../game/Game";
import { execSnapshotType } from "../../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../../snapshot/SnapshotContext";

/** Fork: one non-aggression pact intent. */
export type PactAction =
  | { kind: "propose"; other: PlayerID; minutes: number }
  | { kind: "reply"; other: PlayerID; accept: boolean }
  | { kind: "break"; other: PlayerID };

/**
 * Applies one pact action for `player` in init, then ends. The pact
 * manager (game/Pacts.ts) validates it.
 */
export class PactExecution implements Execution {
  constructor(
    private player: Player,
    private action: PactAction,
  ) {}

  init(mg: Game, _: number): void {
    const a = this.action;
    if (!mg.hasPlayer(a.other)) return;
    const other = mg.player(a.other);
    const pacts = mg.pacts();
    switch (a.kind) {
      case "propose":
        pacts.propose(this.player, other, a.minutes);
        return;
      case "reply":
        pacts.reply(this.player, other, a.accept);
        return;
      case "break":
        pacts.breakPact(this.player, other);
        return;
    }
  }

  tick(_: number): void {}

  isActive(): boolean {
    return false;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return PactExecutionSnapshot.write({
      player: w.player(this.player),
      action: this.action,
    });
  }

  restoreSnapshot(s: PactState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.action = s.action;
  }
}

const PactStateSchema = z.object({
  player: zPlayerRef(),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("propose"),
      other: z.string(),
      minutes: z.number().int(),
    }),
    z.object({
      kind: z.literal("reply"),
      other: z.string(),
      accept: z.boolean(),
    }),
    z.object({ kind: z.literal("break"), other: z.string() }),
  ]),
});
type PactState = z.infer<typeof PactStateSchema>;

export const PactExecutionSnapshot = execSnapshotType({
  name: "Pact",
  version: 1,
  schema: PactStateSchema,
  cls: () => PactExecution,
});
