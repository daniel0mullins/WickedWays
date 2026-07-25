//! Tokenizer for the infix expression language.
//!
//! Turns an author's single-line expression string into a flat `Vec<(Token,
//! Span)>`. The MVP keeps expressions single-line, so each token's span is
//! `base` offset by the token's starting char index (`line = base.line`,
//! `col = base.col + char_index`) — this points diagnostics back into the TOML
//! file. Strings use single OR double quotes (`'...'` / `"..."`), matching the
//! TOML-embedded style; a string containing one quote kind is written with the other.
//! Panic-free: an unrecognized character or unterminated string is an
//! `ExprParse` error, never a panic.

use crate::error::{CompileError, Span};

/// A lexical token. Punctuation/operators are unit variants; the three
/// value-bearing kinds carry their parsed payload.
#[derive(Clone, Debug, PartialEq)]
pub enum Token {
    Ident(String),
    Str(String),
    Num(f64),
    Bool(bool),
    // grouping / postfix punctuation
    LParen,   // (
    RParen,   // )
    LBracket, // [
    RBracket, // ]
    Dot,      // .
    Comma,    // ,
    Question, // ?
    Colon,    // :
    // operators
    AndAnd, // &&
    OrOr,   // ||
    EqEq,   // ==
    NotEq,  // !=
    Lte,    // <=
    Gte,    // >=
    Lt,     // <
    Gt,     // >
    Plus,   // +
    Minus,  // -
    Star,   // *
    Slash,  // /
    Bang,   // !
}

/// Tokenize `src`. Every token carries the span of its first character.
///
/// `base` is where the expression string starts in the TOML file; because MVP
/// expressions are single-line, a token starting at char index `i` gets span
/// `{ line: base.line, col: base.col + i }`.
pub fn tokenize(src: &str, base: Span) -> Result<Vec<(Token, Span)>, CompileError> {
    // Index by char (not byte) so column math and multi-byte content stay sane.
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<(Token, Span)> = Vec::new();
    let mut i = 0usize;

    let span_at = |i: usize| Span {
        line: base.line,
        col: base.col + i,
    };

    while i < chars.len() {
        let c = chars[i];

        // whitespace
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        let start = i;
        let start_span = span_at(start);

        // two-char operators first, then single-char
        let next = chars.get(i + 1).copied();
        match (c, next) {
            ('&', Some('&')) => {
                out.push((Token::AndAnd, start_span));
                i += 2;
                continue;
            }
            ('|', Some('|')) => {
                out.push((Token::OrOr, start_span));
                i += 2;
                continue;
            }
            ('=', Some('=')) => {
                out.push((Token::EqEq, start_span));
                i += 2;
                continue;
            }
            ('!', Some('=')) => {
                out.push((Token::NotEq, start_span));
                i += 2;
                continue;
            }
            ('<', Some('=')) => {
                out.push((Token::Lte, start_span));
                i += 2;
                continue;
            }
            ('>', Some('=')) => {
                out.push((Token::Gte, start_span));
                i += 2;
                continue;
            }
            _ => {}
        }

        // single-char punctuation / operators
        let single = match c {
            '(' => Some(Token::LParen),
            ')' => Some(Token::RParen),
            '[' => Some(Token::LBracket),
            ']' => Some(Token::RBracket),
            '.' if !next.map(|n| n.is_ascii_digit()).unwrap_or(false) => Some(Token::Dot),
            ',' => Some(Token::Comma),
            '?' => Some(Token::Question),
            ':' => Some(Token::Colon),
            '<' => Some(Token::Lt),
            '>' => Some(Token::Gt),
            '+' => Some(Token::Plus),
            '-' => Some(Token::Minus),
            '*' => Some(Token::Star),
            '/' => Some(Token::Slash),
            '!' => Some(Token::Bang),
            _ => None,
        };
        if let Some(tok) = single {
            out.push((tok, start_span));
            i += 1;
            continue;
        }

        // String literal, delimited by either `'` or `"`. No escapes: a string
        // containing an apostrophe is written with double quotes, and vice versa
        // (the real storyteller lore uses `'…'` inside, so it authors with `"`).
        if c == '\'' || c == '"' {
            let quote = c;
            let mut s = String::new();
            i += 1; // consume opening quote
            let mut terminated = false;
            while i < chars.len() {
                let ch = chars[i];
                if ch == quote {
                    i += 1; // consume closing quote
                    terminated = true;
                    break;
                }
                s.push(ch);
                i += 1;
            }
            if !terminated {
                return Err(CompileError::ExprParse {
                    span: start_span,
                    message: "unterminated string literal".into(),
                });
            }
            out.push((Token::Str(s), start_span));
            continue;
        }

        // number literal: digits with an optional single decimal point
        if c.is_ascii_digit() || c == '.' {
            let num_start = i;
            let mut seen_dot = false;
            while i < chars.len() {
                let ch = chars[i];
                if ch.is_ascii_digit() {
                    i += 1;
                } else if ch == '.' && !seen_dot {
                    seen_dot = true;
                    i += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[num_start..i].iter().collect();
            match text.parse::<f64>() {
                Ok(n) => out.push((Token::Num(n), start_span)),
                Err(_) => {
                    return Err(CompileError::ExprParse {
                        span: start_span,
                        message: "malformed number literal".into(),
                    });
                }
            }
            continue;
        }

        // identifier / keyword: [A-Za-z_][A-Za-z0-9_]*
        if c.is_ascii_alphabetic() || c == '_' {
            let id_start = i;
            while i < chars.len() {
                let ch = chars[i];
                if ch.is_ascii_alphanumeric() || ch == '_' {
                    i += 1;
                } else {
                    break;
                }
            }
            let text: String = chars[id_start..i].iter().collect();
            let tok = match text.as_str() {
                "true" => Token::Bool(true),
                "false" => Token::Bool(false),
                _ => Token::Ident(text),
            };
            out.push((tok, start_span));
            continue;
        }

        // anything else is unrecognized
        return Err(CompileError::ExprParse {
            span: start_span,
            message: format!("unexpected character '{c}'"),
        });
    }

    Ok(out)
}
