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

/** Fork: one coalition intent. Targets are player ids from the wire. */
export type CoalitionAction =
  | { kind: "create"; name: string }
  | { kind: "invite"; target: PlayerID }
  | { kind: "reply"; coalitionID: number; accept: boolean }
  | { kind: "leave" }
  | { kind: "kick"; target: PlayerID }
  | { kind: "sanction"; target: PlayerID; on: boolean }
  | { kind: "target"; target: PlayerID }
  | { kind: "transfer"; target: PlayerID };

/**
 * Applies one coalition action for `player` in init, then ends. The
 * coalition manager (game/Coalitions.ts) validates every action, so a
 * stale or forged intent just does nothing.
 */
export class CoalitionExecution implements Execution {
  constructor(
    private player: Player,
    private action: CoalitionAction,
  ) {}

  init(mg: Game, _: number): void {
    const c = mg.coalitions();
    const a = this.action;
    const target = (id: PlayerID): Player | null =>
      mg.hasPlayer(id) ? mg.player(id) : null;
    switch (a.kind) {
      case "create":
        c.create(this.player, a.name);
        return;
      case "reply":
        c.reply(this.player, a.coalitionID, a.accept);
        return;
      case "leave":
        c.leave(this.player);
        return;
    }
    const other = target(a.target);
    if (other === null) return;
    switch (a.kind) {
      case "invite":
        c.invite(this.player, other);
        return;
      case "kick":
        c.kick(this.player, other);
        return;
      case "sanction":
        c.setSanction(this.player, other, a.on);
        return;
      case "target":
        c.setTarget(this.player, other);
        return;
      case "transfer":
        c.transfer(this.player, other);
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
    return CoalitionExecutionSnapshot.write({
      player: w.player(this.player),
      action: this.action,
    });
  }

  restoreSnapshot(s: CoalitionState, r: SnapshotReader): void {
    this.player = r.player(s.player);
    this.action = s.action;
  }
}

const CoalitionStateSchema = z.object({
  player: zPlayerRef(),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create"), name: z.string() }),
    z.object({ kind: z.literal("invite"), target: z.string() }),
    z.object({
      kind: z.literal("reply"),
      coalitionID: z.number().int(),
      accept: z.boolean(),
    }),
    z.object({ kind: z.literal("leave") }),
    z.object({ kind: z.literal("kick"), target: z.string() }),
    z.object({
      kind: z.literal("sanction"),
      target: z.string(),
      on: z.boolean(),
    }),
    z.object({ kind: z.literal("target"), target: z.string() }),
    z.object({ kind: z.literal("transfer"), target: z.string() }),
  ]),
});
type CoalitionState = z.infer<typeof CoalitionStateSchema>;

export const CoalitionExecutionSnapshot = execSnapshotType({
  name: "Coalition",
  version: 1,
  schema: CoalitionStateSchema,
  cls: () => CoalitionExecution,
});
