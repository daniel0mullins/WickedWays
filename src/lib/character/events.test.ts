import { describe, expect, it, vi } from "vitest";

import type { ICharacter } from "./character";
import { CharacterEvents } from "./events";

function makeCharacter(): ICharacter {
  return { name: "Hero" } as ICharacter;
}

describe("CharacterEvents", () => {
  describe("constructor", () => {
    it("exposes the character it was created for", () => {
      const character = makeCharacter();

      expect(new CharacterEvents(character).character).toBe(character);
    });

    it("starts with no handlers when none are seeded", () => {
      const events = new CharacterEvents(makeCharacter());

      // Firing either phase with no handlers should be a harmless no-op.
      expect(() => {
        events.onTurnStart();
        events.onTurnEnd();
      }).not.toThrow();
    });

    it("registers seeded start and end handlers", () => {
      const character = makeCharacter();
      const onStart = vi.fn();
      const onEnd = vi.fn();
      const events = new CharacterEvents(character, {
        start: [onStart],
        end: [onEnd],
      });

      events.onTurnStart();
      events.onTurnEnd();

      expect(onStart).toHaveBeenCalledWith({ character });
      expect(onEnd).toHaveBeenCalledWith({ character });
    });
  });

  describe("addEvent", () => {
    it("runs a handler added to the start phase", () => {
      const character = makeCharacter();
      const events = new CharacterEvents(character);
      const handler = vi.fn();

      events.addEvent("start", handler);
      events.onTurnStart();

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ character });
    });

    it("runs a handler added to the end phase", () => {
      const events = new CharacterEvents(makeCharacter());
      const handler = vi.fn();

      events.addEvent("end", handler);
      events.onTurnEnd();

      expect(handler).toHaveBeenCalledOnce();
    });

    it("invokes multiple handlers in registration order", () => {
      const events = new CharacterEvents(makeCharacter());
      const calls: string[] = [];

      events.addEvent("start", () => calls.push("first"));
      events.addEvent("start", () => calls.push("second"));
      events.onTurnStart();

      expect(calls).toEqual(["first", "second"]);
    });

    it("does not run a start handler when the end phase fires", () => {
      const events = new CharacterEvents(makeCharacter());
      const handler = vi.fn();

      events.addEvent("start", handler);
      events.onTurnEnd();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("removeEvent", () => {
    it("stops a removed handler from running", () => {
      const events = new CharacterEvents(makeCharacter());
      const handler = vi.fn();

      events.addEvent("start", handler);
      events.removeEvent("start", handler);
      events.onTurnStart();

      expect(handler).not.toHaveBeenCalled();
    });

    it("removes only the matching handler and leaves the rest", () => {
      const events = new CharacterEvents(makeCharacter());
      const kept = vi.fn();
      const removed = vi.fn();

      events.addEvent("start", kept);
      events.addEvent("start", removed);
      events.removeEvent("start", removed);
      events.onTurnStart();

      expect(kept).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();
    });

    it("is a no-op when removing a handler that was never registered", () => {
      const events = new CharacterEvents(makeCharacter());
      const registered = vi.fn();

      events.addEvent("start", registered);
      expect(() => events.removeEvent("start", vi.fn())).not.toThrow();
      events.onTurnStart();

      expect(registered).toHaveBeenCalledOnce();
    });
  });

  describe("dispatch", () => {
    it("passes the character to every handler", () => {
      const character = makeCharacter();
      const events = new CharacterEvents(character);
      const first = vi.fn();
      const second = vi.fn();

      events.addEvent("end", first);
      events.addEvent("end", second);
      events.onTurnEnd();

      expect(first).toHaveBeenCalledWith({ character });
      expect(second).toHaveBeenCalledWith({ character });
    });

    it("can fire the same phase repeatedly", () => {
      const events = new CharacterEvents(makeCharacter());
      const handler = vi.fn();

      events.addEvent("start", handler);
      events.onTurnStart();
      events.onTurnStart();

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
