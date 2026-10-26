/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Typed rows, queries and embedding results, generic over a generated
 * `Database` shape (design §8 and Appendix A). Pure types: nothing here
 * exists at runtime, and there is no string parsing. The `with` object is a
 * tree; each level is one mapped-type instantiation, so cost scales with the
 * keys written.
 */

/**
 * One edge of the relation graph: a foreign key (`one`) or an inverse FK or
 * many-to-many (`many`). A many-to-many carries `via: 'junction'`: its default
 * embed is the target's `id`, `display_name` and (when it has one) `color`, not
 * the whole row.
 *
 * @consumer typed compileWith
 */
export type RelationShape =
  | { readonly kind: 'one'; readonly target: string; readonly nullable: boolean }
  | { readonly kind: 'many'; readonly target: string; readonly via?: 'junction' };

/**
 * The per-entity members codegen emits (design §10).
 *
 * @consumer typed compileWith
 */
export interface EntityShape {
  Row: object;
  Insert: object;
  Update: object;
  Embedded: object;
  Relations: { [relation: string]: RelationShape };
}

/**
 * The generated `Database` interface, as far as the typed query API reads it.
 *
 * @consumer custom-app
 */
export interface DatabaseShape {
  entities: { [entity: string]: EntityShape };
}

/**
 * Entity names of a database.
 *
 * @consumer custom-app
 */
export type EntityName<D extends DatabaseShape> = keyof D['entities'] & string;

/**
 * The stored columns of an entity.
 *
 * @consumer custom-app
 */
export type RowOf<D extends DatabaseShape, E extends EntityName<D>> = D['entities'][E]['Row'];

/**
 * The shape a create accepts: required columns, optional defaulted ones.
 *
 * @consumer custom-app
 */
export type InsertOf<D extends DatabaseShape, E extends EntityName<D>> = D['entities'][E]['Insert'];

/**
 * The shape an update accepts.
 *
 * @consumer custom-app
 */
export type UpdateOf<D extends DatabaseShape, E extends EntityName<D>> = D['entities'][E]['Update'];

/**
 * Default embed shapes of the entity's foreign key columns.
 *
 * @consumer custom-app
 */
export type EmbeddedOf<D extends DatabaseShape, E extends EntityName<D>> = D['entities'][E]['Embedded'];

/**
 * The relation graph `with` addresses.
 *
 * @consumer custom-app
 */
export type RelationsOf<D extends DatabaseShape, E extends EntityName<D>> = D['entities'][E]['Relations'];

/**
 * The entity a relation points at.
 *
 * @consumer custom-app
 */
export type TargetOf<D extends DatabaseShape, E extends EntityName<D>, R extends keyof RelationsOf<D, E>> =
  RelationsOf<D, E>[R] extends { target: infer T extends EntityName<D> } ? T : never;

/**
 * Options for one embedded relation.
 *
 * @consumer custom-app
 */
export type SubQuery<D extends DatabaseShape, T extends EntityName<D>> = {
  columns?: readonly (keyof RowOf<D, T>)[];
  with?: With<D, T>;
  limit?: number;
  order?: { column: keyof RowOf<D, T>; direction: 'asc' | 'desc' };
};

/**
 * The `with` object: relation name to `true` (default shape) or options.
 *
 * @consumer custom-app
 */
export type With<D extends DatabaseShape, E extends EntityName<D>> = {
  [R in keyof RelationsOf<D, E>]?: true | SubQuery<D, TargetOf<D, E, R>>;
};

/**
 * The query constraint for an entity.
 *
 * @consumer custom-app
 */
export type TypedQuery<D extends DatabaseShape, E extends EntityName<D>> = {
  select?: readonly (keyof RowOf<D, E>)[];
  with?: With<D, E>;
};

// Exactness: the constraint alone lets extra keys through when mixed with valid ones (weak-type detection),
// and an explicit `undefined` value would read as a present key in the result type, so both map to `never`.
type Defined<V> = undefined extends V ? never : V;
type ExactSub<D extends DatabaseShape, T extends EntityName<D>, S> = {
  [K in keyof S]: K extends 'columns' | 'limit' | 'order' ? Defined<S[K]>
    : K extends 'with' ? ExactWith<D, T, Defined<S[K]>>
    : never;
};
type ExactWith<D extends DatabaseShape, E extends EntityName<D>, W> = {
  [R in keyof W]: R extends keyof RelationsOf<D, E>
    ? (W[R] extends true ? W[R] : W[R] extends object ? ExactSub<D, TargetOf<D, E, R>, W[R]> : never)
    : never;
};

/**
 * Maps unknown keys, at any depth, to `never`. Use as `q: Q & ExactQuery<D, E, Q>`.
 *
 * @consumer custom-app
 */
export type ExactQuery<D extends DatabaseShape, E extends EntityName<D>, Q> = {
  [K in keyof Q]: K extends 'select' ? Defined<Q[K]>
    : K extends 'with' ? ExactWith<D, E, Defined<Q[K]>>
    : never;
};

// ---- result inference ----
type ColResult<D extends DatabaseShape, E extends EntityName<D>, C extends keyof RowOf<D, E>> =
  C extends keyof EmbeddedOf<D, E> ? EmbeddedOf<D, E>[C] : RowOf<D, E>[C];
type WithOf<S> = S extends { with: infer W } ? W : Record<never, never>;
type ColsOf<D extends DatabaseShape, E extends EntityName<D>, S> =
  S extends { columns: readonly (infer C)[] } ? C & keyof RowOf<D, E> : keyof RowOf<D, E>;
type SelOf<D extends DatabaseShape, E extends EntityName<D>, Q> =
  Q extends { select: readonly (infer C)[] } ? C & keyof RowOf<D, E> : keyof RowOf<D, E>;

/**
 * Result row of a column set plus a `with` object (recursion point of {@link QueryResult}; exported so the
 * API report can print it by name).
 *
 * @consumer custom-app
 */
export type ResultShape<D extends DatabaseShape, E extends EntityName<D>, C extends keyof RowOf<D, E>, W> = {
  [K in Exclude<C, keyof W> | (keyof W & keyof RelationsOf<D, E>)]:
    K extends keyof W
      ? K extends keyof RelationsOf<D, E> ? RelationResult<D, E, K, W[K]> : never // `with` wins over a same-named column
      : K extends keyof RowOf<D, E> ? ColResult<D, E, K> : never;
};
// A many-to-many embedded without `columns` or `with` (`true`, or only `limit`) is the property's own embed
// (`manyToManySelect`): the target's id, display_name and color, as far as the target has them.
type M2mDefault<D extends DatabaseShape, T extends EntityName<D>> = Extract<'id' | 'display_name' | 'color', keyof RowOf<D, T>>;
type IsDefaultEmbed<S> = S extends true ? true : S extends { columns: unknown } | { with: unknown } ? false : true;
type Wrap<Rel, X> =
  Rel extends { kind: 'many' } ? X[]
  : Rel extends { kind: 'one'; nullable: true } ? X | null
  : X;
/**
 * Result of one embedded relation (recursion point of {@link QueryResult}).
 *
 * @consumer custom-app
 */
export type RelationResult<D extends DatabaseShape, E extends EntityName<D>, R extends keyof RelationsOf<D, E>, S> =
  Wrap<RelationsOf<D, E>[R],
    RelationsOf<D, E>[R] extends { via: 'junction' }
      ? IsDefaultEmbed<S> extends true
        ? ResultShape<D, TargetOf<D, E, R>, M2mDefault<D, TargetOf<D, E, R>>, Record<never, never>>
        : ResultShape<D, TargetOf<D, E, R>, ColsOf<D, TargetOf<D, E, R>, S>, WithOf<S>>
      : S extends true
        ? ResultShape<D, TargetOf<D, E, R>, keyof RowOf<D, TargetOf<D, E, R>>, Record<never, never>>
        : ResultShape<D, TargetOf<D, E, R>, ColsOf<D, TargetOf<D, E, R>, S>, WithOf<S>>>;

/**
 * The row type a query returns.
 *
 * @consumer custom-app
 */
export type QueryResult<D extends DatabaseShape, E extends EntityName<D>, Q> =
  ResultShape<D, E, SelOf<D, E, Q>, WithOf<Q>>;
