declare const brand: unique symbol;

/**
 * Nominal ("branded") type built from a base type and a unique string tag.
 *
 * Two `Brand`s with different tags are incompatible even when their underlying
 * type is identical, which lets otherwise-interchangeable primitives (such as
 * the various `string` ids in the engine) be kept distinct at compile time. The
 * brand exists only in the type system; at runtime a branded value is just its
 * underlying base type.
 *
 * @typeParam Base - The underlying runtime type (commonly `string`).
 * @typeParam Name - A unique string literal identifying this brand.
 *
 * @example
 * ```ts
 * type UserId = Brand<string, "UserId">;
 * const id = "abc" as UserId; // distinct from a plain string or other ids
 * ```
 */
export type Brand<Base, Name extends string> = Base & { [brand]: Name };
