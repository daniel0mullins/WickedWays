import { describe, expect, it, vi } from "vitest";

import type { IRoom } from "./room";
import { Scene } from "./scene";
import { Character } from "./character/character";
import { createKey } from "./inventory";
import { makeCampaign, makeStats } from "../test-utils";

// `Scene` only ever passes the room through to preconditions and the script; it
// never reads off it, so a bare stub cast to `IRoom` is enough.
function makeRoom(): IRoom {
  return {} as IRoom;
}

type SceneArgs = ConstructorParameters<typeof Scene>[0];

function makeScene(overrides: Partial<SceneArgs> = {}) {
  const room = makeRoom();
  const script = vi.fn();
  const scene = new Scene({
    phase: "enter",
    preconditions: [],
    script,
    ...overrides,
  });
  return { scene, script, room };
}

describe("Scene", () => {
  describe("constructor", () => {
    it("assigns an id and stores the preconditions", () => {
      const preconditions = [vi.fn(() => true)];
      const { scene } = makeScene({ preconditions });

      expect(typeof scene.id).toBe("string");
      expect(scene.id.length).toBeGreaterThan(0);
      expect(scene.preconditions).toBe(preconditions);
    });

    it("defaults the trigger phase to 'enter'", () => {
      // `phase` omitted -> playScene("enter") should fire the script.
      const room = makeRoom();
      const script = vi.fn();
      const scene = new Scene({
        preconditions: [],
        script,
      });

      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledOnce();
    });
  });

  describe("playScene", () => {
    it("runs the script when the phase matches and all preconditions pass", () => {
      const { scene, script, room } = makeScene({
        preconditions: [vi.fn(() => true), vi.fn(() => true)],
      });

      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledOnce();
      expect(script).toHaveBeenCalledWith(room, {});
    });

    it("runs the script when there are no preconditions", () => {
      const { scene, script, room } = makeScene({ preconditions: [] });

      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledOnce();
    });

    it("does not run the script when the phase does not match", () => {
      const { scene, script, room } = makeScene({ phase: "enter" });

      scene.playScene("exit", room);

      expect(script).not.toHaveBeenCalled();
    });

    it("does not run the script when any precondition fails", () => {
      const { scene, script, room } = makeScene({
        preconditions: [vi.fn(() => true), vi.fn(() => false)],
      });

      scene.playScene("enter", room);

      expect(script).not.toHaveBeenCalled();
    });

    it("passes the room to each precondition", () => {
      const first = vi.fn(() => true);
      const second = vi.fn(() => true);
      const { scene, room } = makeScene({ preconditions: [first, second] });

      scene.playScene("enter", room);

      expect(first).toHaveBeenCalledWith(room, {});
      expect(second).toHaveBeenCalledWith(room, {});
    });

    it("stops at the first failing precondition (short-circuits)", () => {
      const failing = vi.fn(() => false);
      const later = vi.fn(() => true);
      const { scene } = makeScene({ preconditions: [failing, later] });

      scene.playScene("enter", makeRoom());

      expect(failing).toHaveBeenCalledOnce();
      expect(later).not.toHaveBeenCalled();
    });

    it("does not evaluate preconditions when the phase does not match", () => {
      const precondition = vi.fn(() => true);
      const { scene } = makeScene({ phase: "enter", preconditions: [precondition] });

      scene.playScene("exit", makeRoom());

      expect(precondition).not.toHaveBeenCalled();
    });
  });

  describe("key-gated scene (authoring pattern)", () => {
    // A precondition an author writes with the public surface: the gate opens
    // when any occupant of the room holds a key with the matching code.
    const requiresKey = (keyCode: string) => (room: IRoom) =>
      room.occupants.some((c) =>
        c.inventory.keys.some((k) => k.keyCode === keyCode),
      );

    function roomWithOccupants(occupants: Character[]): IRoom {
      return { occupants } as unknown as IRoom;
    }

    it("does not fire when no occupant holds the key", () => {
      const { scene, script } = makeScene({
        preconditions: [requiresKey("vault")],
      });
      const bystander = new Character(makeCampaign(), "Bystander", makeStats());

      scene.playScene("enter", roomWithOccupants([bystander]));

      expect(script).not.toHaveBeenCalled();
    });

    it("fires once an occupant holds the matching key", () => {
      const { scene, script } = makeScene({
        preconditions: [requiresKey("vault")],
      });
      const hero = new Character(makeCampaign(), "Hero", makeStats());
      hero.addToInventory(createKey({ name: "Vault Key", keyCode: "vault", consumeOnUse: false }));

      const room = roomWithOccupants([hero]);
      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledOnce();
      expect(script).toHaveBeenCalledWith(room, {});
    });
  });

  describe("persistent state", () => {
    it("runs a fire-once scene's body only once across repeated visits", () => {
      const body = vi.fn();
      const scene = new Scene<{ fired: boolean }>({
        preconditions: [(_room, state) => !state.fired],
        script: (_room, state) => {
          body();
          state.fired = true;
        },
        initialState: { fired: false },
      });
      const room = makeRoom();

      scene.playScene("enter", room);
      scene.playScene("enter", room);
      scene.playScene("enter", room);

      expect(body).toHaveBeenCalledOnce();
    });

    it("accumulates a counter in state and can gate a precondition on it", () => {
      const body = vi.fn();
      const scene = new Scene<{ visits: number }>({
        preconditions: [(_room, state) => state.visits < 2],
        script: (_room, state) => {
          state.visits += 1;
          body();
        },
        initialState: { visits: 0 },
      });
      const room = makeRoom();

      scene.playScene("enter", room); // visits 0 -> 1
      scene.playScene("enter", room); // visits 1 -> 2
      scene.playScene("enter", room); // gate closed (visits === 2)

      expect(body).toHaveBeenCalledTimes(2);
    });

    it("passes the same live state object to preconditions and the script", () => {
      const initialState = { visits: 0 };
      const precondition = vi.fn(() => true);
      const script = vi.fn();
      const scene = new Scene<{ visits: number }>({
        preconditions: [precondition],
        script,
        initialState,
      });
      const room = makeRoom();

      scene.playScene("enter", room);

      expect(precondition).toHaveBeenCalledWith(room, initialState);
      expect(script).toHaveBeenCalledWith(room, initialState);
    });

    it("defaults to an empty state bag and fires every matching enter when stateless", () => {
      const script = vi.fn();
      const scene = new Scene({ preconditions: [], script });
      const room = makeRoom();

      scene.playScene("enter", room);
      scene.playScene("enter", room);

      expect(script).toHaveBeenCalledTimes(2);
      expect(script).toHaveBeenCalledWith(room, {});
    });
  });
});
