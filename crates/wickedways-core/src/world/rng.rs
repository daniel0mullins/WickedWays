//! Transient, seeded PRNG for the World. Bit-exact port of `conformance/seeded-rng.ts`
//! (mulberry32). NOT serialized — the TS engine re-injects `rng` on load; the conformance
//! harness seeds both sides identically via `replay_commands(.., seed)`.

/// mulberry32 state. All ops are u32 wrapping / logical shifts, matching JS `Math.imul`
/// (`wrapping_mul`), `>>>` (`>>` on u32), and `| 0` / `>>> 0` (u32 truncation).
#[derive(Clone, Debug, PartialEq)]
pub struct Rng {
    a: u32,
}

impl Rng {
    pub fn seeded(seed: u32) -> Rng {
        Rng { a: seed }
    }

    /// Advance and return the next float in [0, 1). Equivalent to the TS `mulberry32` closure.
    pub fn next_f64(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = (self.a ^ (self.a >> 15)).wrapping_mul(1 | self.a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mulberry32_matches_ts_seed_1() {
        // Values produced by conformance/seeded-rng.ts mulberry32(1) — first 3 draws.
        // Verified with: node -e "$(sed 's/export //' conformance/seeded-rng.ts); const r=mulberry32(1); console.log(r(),r(),r())"
        // Output: 0.6270739405881613 0.002735721180215478 0.5274470399599522
        let mut rng = Rng::seeded(1);
        let got = [rng.next_f64(), rng.next_f64(), rng.next_f64()];
        let want = [
            0.6270739405881613_f64,
            0.002735721180215478_f64,
            0.5274470399599522_f64,
        ];
        for (g, w) in got.iter().zip(want.iter()) {
            assert_eq!(
                g.to_bits(),
                w.to_bits(),
                "mulberry32 draw mismatch: {g} vs {w}"
            );
        }
    }
}
