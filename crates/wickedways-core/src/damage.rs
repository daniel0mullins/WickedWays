use serde::{Deserialize, Serialize};

pub const MAX_STAT: f64 = 10.0;
pub const MITIGATION_PER_POINT: f64 = 0.2;
pub const LIGHT_VULNERABILITY: f64 = 1.5;

/// Pure inputs to the mitigation formula. Field names cross the boundary in
/// camelCase — the wire shape is pinned by the conformance goldens.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamageInput {
    pub attack_strength: f64,
    pub armor_sum: f64,
    pub mitigator: f64,
    pub light_averse: bool,
    pub room_lit: bool,
}

/// Mitigation formula. The IEEE-754 operation order is load-bearing: the
/// replay goldens pin results byte-for-byte, so do not reassociate the math.
pub fn compute_mitigated_damage(input: DamageInput) -> f64 {
    let mitigated_strength = (input.attack_strength - input.armor_sum).max(0.0);
    let damage_multiplier = (MAX_STAT - input.mitigator).max(0.0) * MITIGATION_PER_POINT;
    let light_multiplier = if input.light_averse && input.room_lit {
        LIGHT_VULNERABILITY
    } else {
        1.0
    };
    mitigated_strength * damage_multiplier * light_multiplier
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn full_mitigator_absorbs_hit() {
        let i = DamageInput {
            attack_strength: 10.0,
            armor_sum: 0.0,
            mitigator: 10.0,
            light_averse: false,
            room_lit: false,
        };
        assert_eq!(compute_mitigated_damage(i), 0.0);
    }

    proptest! {
        #[test]
        fn never_negative(
            attack in 0.0f64..1000.0, armor in 0.0f64..1000.0,
            mit in 0.0f64..20.0, la in any::<bool>(), lit in any::<bool>(),
        ) {
            let d = compute_mitigated_damage(DamageInput {
                attack_strength: attack, armor_sum: armor, mitigator: mit, light_averse: la, room_lit: lit,
            });
            prop_assert!(d >= 0.0);
        }
    }
}
