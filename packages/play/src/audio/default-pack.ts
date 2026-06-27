import { soundForCue, soundForMobAttack, errorSound, type SynthVoice } from "./cue-sound.js";
import type { AudioCue, AudioDirector, SoundPack, SoundSpec } from "./contracts.js";

// Maps an engine PresentationCue to base AudioCue(s). Mirrors the prior soundForCue triggers.
function cuesFor(cue: Parameters<AudioDirector["react"]>[0]): AudioCue[] {
  switch (cue.kind) {
    case "action":
      switch (cue.action) {
        case "attack": case "takeDamage": return [{ type: "strike", entityId: cue.actor.id }];
        case "pickUp": return [{ type: "pickup", entityId: cue.actor.id }];
        case "drop": return [{ type: "drop", entityId: cue.actor.id }];
        case "move": return [{ type: "move", entityId: cue.actor.id }];
        default: return [];
      }
    case "encounter": return [{ type: "encounter", entityId: cue.mob.id }];
    case "visibility": return [{ type: "light" }];
    case "resolution": return [{ type: cue.outcome === "won" ? "win" : "lose" }];
    default: return [];
  }
}

// Base cue → SynthVoice. Re-uses the original cue-sound voices by reconstructing a
// representative PresentationCue, so the chiptune timbre is unchanged.
function voiceFor(cue: AudioCue): SynthVoice | null {
  switch (cue.type) {
    case "strike": return soundForMobAttack({ name: "", stat: "sanity", amount: 1 });
    case "error": return errorSound();
    case "pickup": return soundForCue({ kind: "action", action: "pickUp", actor: { id: cue.entityId ?? "", name: "" } });
    case "drop": return soundForCue({ kind: "action", action: "drop", actor: { id: cue.entityId ?? "", name: "" } });
    case "move": return soundForCue({ kind: "action", action: "move", actor: { id: cue.entityId ?? "", name: "" } });
    case "light": return soundForCue({ kind: "visibility", room: { id: "", name: "" }, lit: true });
    case "encounter": return soundForCue({ kind: "encounter", mob: { id: cue.entityId ?? "", name: "" }, room: { id: "", name: "" } });
    case "death": return soundForMobAttack({ name: "", stat: "sanity", amount: 1 });
    case "win": return soundForCue({ kind: "resolution", outcome: "won" });
    case "lose": return soundForCue({ kind: "resolution", outcome: "lost" });
    default: return null;
  }
}

export const defaultChiptunePack: SoundPack = {
  id: "chiptune",
  label: "Chiptune",
  voice: (cue): SoundSpec | null => {
    const v = voiceFor(cue);
    return v ? { kind: "synth", voice: v } : null;
  },
  ambient: (t) => ({ bedTension: t }),
};

export function defaultDirector(): AudioDirector {
  return { react: (cue) => cuesFor(cue), tension: () => 0 };
}
