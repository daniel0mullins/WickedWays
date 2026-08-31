//! The eight compass directions and their pinned wire names (room exit-map keys).
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    North,
    South,
    East,
    West,
    Northeast,
    Northwest,
    Southeast,
    Southwest,
}

impl Direction {
    pub const ALL: [Direction; 8] = [
        Direction::North,
        Direction::South,
        Direction::East,
        Direction::West,
        Direction::Northeast,
        Direction::Northwest,
        Direction::Southeast,
        Direction::Southwest,
    ];

    /// Parse a wire name back to a direction (the inverse of `as_key`).
    /// `None` for anything that is not one of the eight compass keys.
    pub fn from_key(key: &str) -> Option<Direction> {
        Direction::ALL.into_iter().find(|d| d.as_key() == key)
    }

    /// The compass opposite — the direction the return leg of a two-way
    /// passage occupies in the far room.
    pub const fn opposite(self) -> Direction {
        match self {
            Direction::North => Direction::South,
            Direction::South => Direction::North,
            Direction::East => Direction::West,
            Direction::West => Direction::East,
            Direction::Northeast => Direction::Southwest,
            Direction::Northwest => Direction::Southeast,
            Direction::Southeast => Direction::Northwest,
            Direction::Southwest => Direction::Northeast,
        }
    }

    /// The wire name of this direction — identical to its serde serialization
    /// (pinned by the `wire_names_match_serde` test below). Room exit maps are
    /// keyed by these strings.
    pub const fn as_key(self) -> &'static str {
        match self {
            Direction::North => "north",
            Direction::South => "south",
            Direction::East => "east",
            Direction::West => "west",
            Direction::Northeast => "northeast",
            Direction::Northwest => "northwest",
            Direction::Southeast => "southeast",
            Direction::Southwest => "southwest",
        }
    }
}

impl core::fmt::Display for Direction {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_key())
    }
}

impl AsRef<str> for Direction {
    fn as_ref(&self) -> &str {
        self.as_key()
    }
}

#[cfg(test)]
mod tests {
    use super::Direction;

    /// `as_key` and serde must agree — exit-map keys and the serialized enum
    /// are the same namespace, so drift here would corrupt room wiring.
    #[test]
    fn wire_names_match_serde() {
        for dir in Direction::ALL {
            let json = serde_json::to_string(&dir).unwrap();
            assert_eq!(json, alloc::format!("\"{}\"", dir.as_key()));
        }
    }
}
