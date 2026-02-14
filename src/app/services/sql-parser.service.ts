/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Injectable } from '@angular/core';

/**
 * Service that wraps @pgsql/parser for lazy-loaded WASM-based SQL parsing.
 * The WASM module (~2-4MB) is only loaded when first needed.
 *
 * Provides two parsing modes:
 * - parse(): For SQL statements (SELECT, CREATE VIEW, etc.)
 * - parsePlPgSQL(): For PL/pgSQL function bodies
 *
 * Results are cached by source code hash to avoid re-parsing.
 */
@Injectable({
  providedIn: 'root'
})
export class SqlParserService {
  private parser: any = null;
  private loading: Promise<any> | null = null;
  private cache = new Map<string, any>();

  /**
   * Lazily load the WASM parser module.
   * Returns the loaded parser instance, cached after first load.
   *
   * Uses a variable in the import path to prevent the bundler from
   * resolving @pgsql/parser at compile time (its Emscripten WASM
   * wrapper references Node.js builtins that don't exist in browsers).
   * The dynamic import loads the module purely at runtime.
   */
  private async ensureLoaded(): Promise<any> {
    if (this.parser) return this.parser;
    if (this.loading) return this.loading;

    // Use a variable to prevent static analysis by the bundler.
    // This ensures @pgsql/parser is loaded at runtime only.
    const parserPackage = '@pgsql/parser';
    this.loading = import(/* @vite-ignore */ parserPackage).then(module => {
      this.parser = module;
      return module;
    }).catch(() => {
      // WASM parser unavailable — transformer will use regex fallback
      this.loading = null;
      return null;
    });

    return this.loading;
  }

  /**
   * Parse a SQL statement into an AST.
   * Uses the PostgreSQL C parser compiled to WASM.
   */
  async parse(sql: string): Promise<any> {
    const cached = this.cache.get(sql);
    if (cached) return cached;

    try {
      const parser = await this.ensureLoaded();
      const result = await parser.parse(sql);
      this.cache.set(sql, result);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Parse a PL/pgSQL function body into an AST.
   * This decomposes function bodies into individual statements.
   */
  async parsePlPgSQL(body: string): Promise<any> {
    const cacheKey = 'plpgsql:' + body;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const parser = await this.ensureLoaded();
      if (parser.parsePlPgSQL) {
        const result = await parser.parsePlPgSQL(body);
        this.cache.set(cacheKey, result);
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if the parser has been loaded.
   */
  isLoaded(): boolean {
    return this.parser !== null;
  }
}
