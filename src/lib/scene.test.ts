import { describe, expect, it, vi } from "vitest";

import type { IRoom } from "./room";
import { Scene } from "./scene";

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
      expect(script).toHaveBeenCalledWith(room);
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

      expect(first).toHaveBeenCalledWith(room);
      expect(second).toHaveBeenCalledWith(room);
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
});
