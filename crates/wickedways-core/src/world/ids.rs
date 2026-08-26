//! Branded entity-id newtypes. Serialize as a bare string (transparent) to
//! preserve the existing string-id snapshot format.
// `alloc::` rather than `std::`: this crate is no_std-capable, so heap types come from
// the `alloc` crate (same `String`, different import path).
use alloc::string::String;
use serde::{Deserialize, Serialize};

// `macro_rules!` stamps out one wrapper type per invocation below — compile-time code
// generation, not a runtime factory. Each id is a "newtype": a one-field tuple struct
// wrapping `String`, giving it a distinct type so a `RoomId` cannot be passed where a
// `CharacterId` is expected (the branding TS approximates with intersection types,
// Rust enforces natively). `#[serde(transparent)]` makes it serialize as the bare
// inner string, so the JSON shape is unchanged.
macro_rules! branded_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl core::fmt::Display for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.into())
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

branded_id!(CharacterId);
branded_id!(RoomId);
branded_id!(ItemId);
branded_id!(LootId);
branded_id!(MaterialCacheId);
branded_id!(ExitId);

#[cfg(test)]
mod tests {
    use super::CharacterId;

    #[test]
    fn id_serializes_as_bare_string() {
        let id = CharacterId("abc-123".into());
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"abc-123\"");
        let back: CharacterId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }
}
