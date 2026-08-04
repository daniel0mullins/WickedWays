use serde::{Deserialize, Serialize};

/// Rolls a die with `sides` faces from a pre-drawn uniform `unit` in `[0, 1)`.
/// Pure: `floor(unit * sides) + 1`.
pub fn roll(sides: u32, unit: f64) -> u32 {
    (unit * f64::from(sides)) as u32 + 1
}

/// A single physical die a player rolled at the table, carried into the engine as command data.
///
/// The table supplies these via `Command::SupplyDice`; [`World::draw_die`](crate::World::draw_die)
/// consumes the front one whose `sides` match the roll it needs (a "literal outcome" — the face you
/// rolled *is* the result), falling back to the seeded rng ("the house rolls") when none is queued.
/// Recorded on the command log, so a replay reproduces the same roll deterministically.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuppliedDie {
    /// The die's face count (e.g. 20 for a d20).
    pub sides: u32,
    /// The rolled face, in `[1, sides]`.
    pub value: u32,
}

#[cfg(test)]
mod tests {
    use super::roll;

    #[test]
    fn bottom_of_range_is_one() {
        assert_eq!(roll(6, 0.0), 1);
    }

    #[test]
    fn top_of_range_is_sides() {
        assert_eq!(roll(6, 0.999), 6);
        assert_eq!(roll(100, 0.999), 100);
    }
}
