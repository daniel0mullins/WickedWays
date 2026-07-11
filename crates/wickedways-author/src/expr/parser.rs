//! Pratt / precedence-climbing parser: token stream → closed [`Expr`] AST.
//!
//! Precedence (loosest→tightest), per the plan's Global Constraints:
//!   ternary `?:`  <  `||`  <  `&&`  <  equality (`== !=`)
//!     <  comparison (`< <= > >=`)  <  additive (`+ -`)
//!     <  multiplicative (`* /`)  <  unary `!`  <  postfix (`[]` `.` call)
//! `&&`/`||` and the comparison/arithmetic operators are left-associative;
//! the ternary is right-associative.
//!
//! MVP mapping decisions (stated where they apply):
//!   - Subscript `x[i]` ALWAYS lowers to `Index` (never `First`), even for a
//!     literal `0` — the oracle is authored to match.
//!   - `.field` → `Get`; `name(args)` → the three typed calls only.
//!   - Bare identifiers resolve to the read-model subjects (`actor`/`party`/
//!     `round`/`maxRounds`/`damage`); any other bare identifier or unknown call
//!     name → `UnknownReference`.
//!
//! Panic-free on author input: every failure is a `CompileError`. No
//! `unwrap`/`expect`/`panic!` on the token stream.

use wickedways_core::script::ast::{BinOp, Expr};
use wickedways_core::script::value::Value;

use super::lexer::{tokenize, Token};
use crate::error::{CompileError, Span};

/// Parse a single-line infix expression string into the closed `Expr` AST.
///
/// `base` is the TOML line/col where the expression string starts, so error
/// spans point into the source file.
pub fn parse_expr(src: &str, base: Span) -> Result<Expr, CompileError> {
    let tokens = tokenize(src, base)?;
    // Span used for "unexpected end of input": one past the last char.
    let eof_span = Span { line: base.line, col: base.col + src.chars().count() };
    let mut p = Parser { tokens, pos: 0, eof_span };
    let expr = p.parse_ternary()?;
    // Nothing may trail a complete expression.
    if let Some((_tok, span)) = p.peek() {
        return Err(CompileError::ExprParse {
            span,
            message: "unexpected trailing tokens after expression".into(),
        });
    }
    Ok(expr)
}

struct Parser {
    tokens: Vec<(Token, Span)>,
    pos: usize,
    eof_span: Span,
}

impl Parser {
    /// The current token + its span, without consuming.
    fn peek(&self) -> Option<(&Token, Span)> {
        self.tokens.get(self.pos).map(|(t, s)| (t, *s))
    }

    /// Consume and return the current token + span.
    fn advance(&mut self) -> Option<(Token, Span)> {
        let item = self.tokens.get(self.pos).cloned();
        if item.is_some() {
            self.pos += 1;
        }
        item
    }

    /// Span to blame when the stream is exhausted mid-parse.
    fn eof_span(&self) -> Span {
        self.eof_span
    }

    /// Consume a token that must equal `expected`, else an `ExprParse` error.
    fn expect(&mut self, expected: &Token, what: &str) -> Result<Span, CompileError> {
        match self.advance() {
            Some((tok, span)) if &tok == expected => Ok(span),
            Some((_tok, span)) => Err(CompileError::ExprParse {
                span,
                message: format!("expected {what}"),
            }),
            None => Err(CompileError::ExprParse {
                span: self.eof_span(),
                message: format!("expected {what} but reached end of expression"),
            }),
        }
    }

    // ── ternary (loosest) ───────────────────────────────────────────────────
    /// `cond ? then : else`, right-associative. `cond` is a full binary
    /// expression; both branches recurse into `parse_ternary`.
    fn parse_ternary(&mut self) -> Result<Expr, CompileError> {
        let cond = self.parse_binary(0)?;
        if matches!(self.peek(), Some((Token::Question, _))) {
            self.advance(); // consume '?'
            let then = self.parse_ternary()?;
            self.expect(&Token::Colon, "':' in ternary expression")?;
            let els = self.parse_ternary()?;
            return Ok(Expr::IfElse {
                cond: Box::new(cond),
                then: Box::new(then),
                r#else: Box::new(els),
            });
        }
        Ok(cond)
    }

    // ── binary operators (precedence climbing) ──────────────────────────────
    /// Parse a left-associative binary expression whose operators bind at least
    /// as tightly as `min_bp`. Binding powers (loosest→tightest):
    /// `||`=1, `&&`=2, equality=3, comparison=4, additive=5, multiplicative=6.
    fn parse_binary(&mut self, min_bp: u8) -> Result<Expr, CompileError> {
        let mut left = self.parse_unary()?;
        loop {
            let (op, bp) = match self.peek() {
                Some((Token::OrOr, _)) => (BinOp::Or, 1),
                Some((Token::AndAnd, _)) => (BinOp::And, 2),
                Some((Token::EqEq, _)) => (BinOp::Eq, 3),
                Some((Token::NotEq, _)) => (BinOp::Ne, 3),
                Some((Token::Lt, _)) => (BinOp::Lt, 4),
                Some((Token::Lte, _)) => (BinOp::Lte, 4),
                Some((Token::Gt, _)) => (BinOp::Gt, 4),
                Some((Token::Gte, _)) => (BinOp::Gte, 4),
                Some((Token::Plus, _)) => (BinOp::Add, 5),
                Some((Token::Minus, _)) => (BinOp::Sub, 5),
                Some((Token::Star, _)) => (BinOp::Mul, 6),
                Some((Token::Slash, _)) => (BinOp::Div, 6),
                _ => break,
            };
            if bp < min_bp {
                break;
            }
            self.advance(); // consume the operator
            // Left-assoc: the right operand only takes strictly-tighter ops.
            let right = self.parse_binary(bp + 1)?;
            left = Expr::Bin { op, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }

    // ── unary `!` ───────────────────────────────────────────────────────────
    fn parse_unary(&mut self) -> Result<Expr, CompileError> {
        if matches!(self.peek(), Some((Token::Bang, _))) {
            self.advance(); // consume '!'
            let inner = self.parse_unary()?;
            return Ok(Expr::Not { expr: Box::new(inner) });
        }
        self.parse_postfix()
    }

    // ── postfix `.field`, `[index]` (tightest) ──────────────────────────────
    fn parse_postfix(&mut self) -> Result<Expr, CompileError> {
        let mut expr = self.parse_primary()?;
        loop {
            match self.peek() {
                Some((Token::Dot, _)) => {
                    self.advance(); // consume '.'
                    let field = match self.advance() {
                        Some((Token::Ident(name), _)) => name,
                        Some((_tok, span)) => {
                            return Err(CompileError::ExprParse {
                                span,
                                message: "expected a field name after '.'".into(),
                            });
                        }
                        None => {
                            return Err(CompileError::ExprParse {
                                span: self.eof_span(),
                                message: "expected a field name after '.'".into(),
                            });
                        }
                    };
                    expr = Expr::Get { of: Box::new(expr), field };
                }
                Some((Token::LBracket, _)) => {
                    self.advance(); // consume '['
                    let index = self.parse_ternary()?;
                    self.expect(&Token::RBracket, "']' to close an index")?;
                    // MVP: subscript ALWAYS lowers to `Index`, never `First`.
                    expr = Expr::Index { list: Box::new(expr), index: Box::new(index) };
                }
                _ => break,
            }
        }
        Ok(expr)
    }

    // ── primary: literals, subjects, grouping, calls ────────────────────────
    fn parse_primary(&mut self) -> Result<Expr, CompileError> {
        let (tok, span) = match self.advance() {
            Some(item) => item,
            None => {
                return Err(CompileError::ExprParse {
                    span: self.eof_span(),
                    message: "expected an expression but reached end of input".into(),
                });
            }
        };
        match tok {
            Token::Num(n) => Ok(Expr::Lit { value: Value::Number(n) }),
            Token::Str(s) => Ok(Expr::Lit { value: Value::Str(s) }),
            Token::Bool(b) => Ok(Expr::Lit { value: Value::Bool(b) }),
            // Prefix `-`: valid ONLY immediately before a numeric literal, where
            // it produces a negative numeric `Lit` (there is no unary-negation
            // AST node — `-actor` is an error). A `-` *between* two operands is
            // consumed in `parse_binary` as the `Sub` operator and never reaches
            // `parse_primary`, so this leaves subtraction/precedence untouched.
            Token::Minus => {
                // Peek the following token (copying the number out) so the
                // immutable borrow ends before we `advance` past it.
                let num = match self.peek() {
                    Some((Token::Num(n), _)) => Some(*n),
                    _ => None,
                };
                match num {
                    Some(n) => {
                        self.advance(); // consume the numeric literal
                        Ok(Expr::Lit { value: Value::Number(-n) })
                    }
                    None => Err(CompileError::ExprParse {
                        span,
                        message: "expected a number literal after unary '-'".into(),
                    }),
                }
            }
            Token::LParen => {
                let inner = self.parse_ternary()?;
                self.expect(&Token::RParen, "')' to close a group")?;
                Ok(inner)
            }
            Token::Ident(name) => {
                if matches!(self.peek(), Some((Token::LParen, _))) {
                    self.parse_call(name, span)
                } else {
                    resolve_subject(&name, span)
                }
            }
            _ => Err(CompileError::ExprParse {
                span,
                message: "expected an expression".into(),
            }),
        }
    }

    /// `name( arg0, arg1, … )` — only the three known 2-arg calls are legal; the
    /// second argument MUST be a string literal. Anything else named like a call
    /// is an `UnknownReference`.
    fn parse_call(&mut self, name: String, name_span: Span) -> Result<Expr, CompileError> {
        self.expect(&Token::LParen, "'(' to open call arguments")?;
        let mut args: Vec<Expr> = Vec::new();
        // Empty arg list is legal syntactically; arity is validated per-call.
        if !matches!(self.peek(), Some((Token::RParen, _))) {
            loop {
                args.push(self.parse_ternary()?);
                match self.peek() {
                    Some((Token::Comma, _)) => {
                        self.advance(); // consume ','
                    }
                    _ => break,
                }
            }
        }
        self.expect(&Token::RParen, "')' to close call arguments")?;

        // `stateGet(field, default)` has its own shape (Task 5 read): 2 args, the
        // 1st a string literal (→ `field: String`), the 2nd ANY literal (→
        // `default: Value`, the inner `Value` of a `Lit`). A non-literal 2nd arg
        // is an `ExprParse` — the default must be a compile-time constant.
        if name == "stateGet" {
            if args.len() != 2 {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("stateGet expects exactly 2 arguments, got {}", args.len()),
                });
            }
            let mut it = args.into_iter();
            let field = match it.next() {
                Some(Expr::Lit { value: Value::Str(s) }) => s,
                _ => {
                    return Err(CompileError::ExprParse {
                        span: name_span,
                        message: "stateGet's first argument must be a string literal".into(),
                    });
                }
            };
            let default = match it.next() {
                Some(Expr::Lit { value }) => value,
                _ => {
                    return Err(CompileError::ExprParse {
                        span: name_span,
                        message: "stateGet's second argument must be a literal".into(),
                    });
                }
            };
            return Ok(Expr::StateGet { field, default });
        }

        // `stateGetIn(map_field, key, default)` — dynamic string-keyed state read
        // (the storyteller's `seen[roomName]`): 3 args — a string-literal field, a
        // key EXPRESSION, and a literal default.
        if name == "stateGetIn" {
            if args.len() != 3 {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("stateGetIn expects exactly 3 arguments, got {}", args.len()),
                });
            }
            let mut it = args.into_iter();
            let map_field = str_lit_arg(it.next(), name_span, "stateGetIn's first argument")?;
            let key = it.next().expect("arity checked above");
            let default = match it.next() {
                Some(Expr::Lit { value }) => value,
                _ => {
                    return Err(CompileError::ExprParse {
                        span: name_span,
                        message: "stateGetIn's third argument must be a literal".into(),
                    });
                }
            };
            return Ok(Expr::StateGetIn { map_field, key: Box::new(key), default });
        }

        // `mapLit(k1, v1, k2, v2, …)` — a static string→value table (the storyteller's
        // `lore`), authored as an even-length list of alternating string-literal keys
        // and literal values. Only legal as the `map` operand of `has`/`lookup`
        // (enforced at load, engine-side); here it just builds the `MapLit` node.
        if name == "mapLit" {
            if args.len() % 2 != 0 {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: "mapLit expects alternating key/value arguments (an even count)".into(),
                });
            }
            let mut entries: std::collections::BTreeMap<String, Value> =
                std::collections::BTreeMap::new();
            let mut it = args.into_iter();
            while let Some(k) = it.next() {
                let key = match k {
                    Expr::Lit { value: Value::Str(s) } => s,
                    _ => {
                        return Err(CompileError::ExprParse {
                            span: name_span,
                            message: "mapLit keys must be string literals".into(),
                        });
                    }
                };
                let value = match it.next() {
                    Some(Expr::Lit { value }) => value,
                    _ => {
                        return Err(CompileError::ExprParse {
                            span: name_span,
                            message: "mapLit values must be literals".into(),
                        });
                    }
                };
                entries.insert(key, value);
            }
            return Ok(Expr::MapLit { entries });
        }

        // `has(map, key)` / `lookup(map, key)` — membership / value-at over a static
        // `MapLit`. Both take 2 expression arguments (the `map` is typically a
        // `mapLit(...)`; the `key` any expression).
        if name == "has" || name == "lookup" {
            if args.len() != 2 {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("{name} expects exactly 2 arguments, got {}", args.len()),
                });
            }
            let mut it = args.into_iter();
            let map = Box::new(it.next().expect("arity checked above"));
            let key = Box::new(it.next().expect("arity checked above"));
            return Ok(if name == "has" {
                Expr::Has { map, key }
            } else {
                Expr::Lookup { map, key }
            });
        }

        // Only these three call names are known; everything else is unknown.
        let known = matches!(name.as_str(), "hasKey" | "hasItem" | "hasEquipped");
        if !known {
            return Err(CompileError::UnknownReference { span: name_span, name });
        }

        // All three take exactly 2 args; the 2nd must be a string literal.
        if args.len() != 2 {
            return Err(CompileError::ExprParse {
                span: name_span,
                message: format!("{name} expects exactly 2 arguments, got {}", args.len()),
            });
        }
        let mut it = args.into_iter();
        let of = match it.next() {
            Some(e) => e,
            None => {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("{name} is missing its first argument"),
                });
            }
        };
        let second = match it.next() {
            Some(e) => e,
            None => {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("{name} is missing its second argument"),
                });
            }
        };
        let key = match second {
            Expr::Lit { value: Value::Str(s) } => s,
            _ => {
                return Err(CompileError::ExprParse {
                    span: name_span,
                    message: format!("{name}'s second argument must be a string literal"),
                });
            }
        };
        Ok(match name.as_str() {
            "hasKey" => Expr::HasKey { of: Box::new(of), key_code: key },
            "hasItem" => Expr::HasItem { of: Box::new(of), item_key: key },
            // The `known` guard restricts this arm to "hasEquipped".
            _ => Expr::HasEquipped { of: Box::new(of), item_key: key },
        })
    }
}

/// Require a call argument to be a string literal, returning the inner `String`
/// (used for the `field`/`map_field` arguments that must be compile-time keys).
fn str_lit_arg(arg: Option<Expr>, span: Span, what: &str) -> Result<String, CompileError> {
    match arg {
        Some(Expr::Lit { value: Value::Str(s) }) => Ok(s),
        _ => Err(CompileError::ExprParse {
            span,
            message: format!("{what} must be a string literal"),
        }),
    }
}

/// Resolve a bare identifier to a read-model subject, else an `UnknownReference`.
/// (Keywords `true`/`false` are lexed as `Bool`, so they never reach here.)
fn resolve_subject(name: &str, span: Span) -> Result<Expr, CompileError> {
    match name {
        "actor" => Ok(Expr::Actor),
        "party" => Ok(Expr::Party),
        "round" => Ok(Expr::Round),
        "maxRounds" => Ok(Expr::MaxRounds),
        // The damage subject (`modify_damage` context) — its `.amount`/`.target`
        // fields are read via postfix `.field` (`Get`). Bound only inside a
        // `modifyDamage` body; elsewhere the interpreter yields `Null`.
        "damage" => Ok(Expr::Damage),
        // The action subject (action contexts, e.g. a mechanic `onAction` hook):
        // `.kind`/`.room` read via postfix `.field`. `Null` outside an action ctx.
        "action" => Ok(Expr::Action),
        // The bound quantifier element (`some`/`every` predicate bodies).
        "element" => Ok(Expr::Element),
        _ => Err(CompileError::UnknownReference {
            span,
            name: name.to_string(),
        }),
    }
}
