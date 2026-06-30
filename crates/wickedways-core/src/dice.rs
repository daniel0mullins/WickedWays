/// Rolls a die with `sides` faces from a pre-drawn uniform `unit` in `[0, 1)`.
/// Pure mirror of the TS `roll(sides, rng)`: `floor(unit * sides) + 1`.
pub fn roll(sides: u32, unit: f64) -> u32 {
    (unit * sides as f64) as u32 + 1
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
