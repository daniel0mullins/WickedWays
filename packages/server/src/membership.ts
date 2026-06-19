import type { Identity, Actor } from "@wickedways/transport-shared";

/**
 * One campaign's seat-ownership map: which identity owns each character seat, plus
 * the GM identity. Server-side protocol state (NOT in the campaign snapshot), so the
 * server can enforce appends without reading opaque payloads. Seeded with the GM at
 * room creation; mutated by self-service join (self-claim) and GM control messages.
 */
export class Membership {
  #gmIdentity: Identity;
  #seats = new Map<string, Identity>();

  constructor(gmIdentity: Identity) {
    this.#gmIdentity = gmIdentity;
  }

  /** The campaign's current GM identity. */
  get gmIdentity(): Identity {
    return this.#gmIdentity;
  }

  /** The owner of a character seat, or null if unowned. */
  ownerOf(characterId: string): Identity | null {
    return this.#seats.get(characterId) ?? null;
  }

  /** All seats as `[characterId, owner]` pairs. */
  seats(): [string, Identity][] {
    return [...this.#seats];
  }

  /** Whether `identity` may act as `actor`. */
  mayAct(identity: Identity, actor: Actor): boolean {
    switch (actor.kind) {
      case "character":
        return this.#seats.get(actor.actorId) === identity;
      case "gm":
        return identity === this.#gmIdentity;
      case "join":
        return !this.#seats.has(actor.characterId); // self-claim only an unowned seat
    }
  }

  /** Binds a newly-joined character to its claiming identity (self-service join). */
  claim(characterId: string, identity: Identity): void {
    this.#seats.set(characterId, identity);
  }

  /** GM override: (re)assign a seat to an identity. */
  assign(characterId: string, identity: Identity): void {
    this.#seats.set(characterId, identity);
  }

  /** GM override: free a seat. */
  unassign(characterId: string): void {
    this.#seats.delete(characterId);
  }

  /** GM override: hand the GM role to another identity. */
  transferGM(identity: Identity): void {
    this.#gmIdentity = identity;
  }
}
