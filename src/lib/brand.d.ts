declare const brand: unique symbol;

/**
 * Nominal ("branded") type built from a base type `T` and a unique string tag.
 *
 * Two `Brand`s with different tags are incompatible even when their underlying
 * type is identical, which lets otherwise-interchangeable primitives (such as
 * the various `string` ids in the engine) be kept distinct at compile time. The
 * brand exists only in the type system; at runtime a branded value is just its
 * underlying `T`.
 *
 * @typeParam T - The underlying runtime type (commonly `string`).
 * @typeParam TBrand - A unique string literal identifying this brand.
 *
 * @example
 * ```ts
 * type UserId = Brand<string, "UserId">;
 * const id = "abc" as UserId; // distinct from a plain string or other ids
 * ```
 */
export type Brand<T, TBrand extends string> = T & { [brand]: TBrand };
