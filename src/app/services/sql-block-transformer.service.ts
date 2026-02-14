/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { Injectable, inject } from '@angular/core';
import { SqlParserService } from './sql-parser.service';

/**
 * Blockly serialization format interfaces.
 * These match the JSON format that Blockly.serialization.workspaces.load() expects.
 */
export interface BlocklySerializedWorkspace {
  blocks: {
    languageVersion: number;
    blocks: BlocklyBlock[];
  };
}

export interface BlocklyBlock {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  fields?: Record<string, any>;
  inputs?: Record<string, { block: BlocklyBlock }>;
  next?: { block: BlocklyBlock };
}

/**
 * Transforms SQL source code into Blockly workspace serialization JSON.
 *
 * Strategy:
 * 1. Try to parse SQL with @pgsql/parser (WASM)
 * 2. If parsing succeeds, walk the AST and map nodes to Blockly blocks
 * 3. If parsing fails, fall back to regex-based line-by-line extraction
 *
 * The regex fallback ensures we always produce blocks even for SQL
 * that the parser can't handle (custom domains, extensions, etc.).
 */
@Injectable({
  providedIn: 'root'
})
export class SqlBlockTransformerService {
  private sqlParser = inject(SqlParserService);
  private blockIdCounter = 0;

  /**
   * Transform SQL source code into a Blockly workspace JSON.
   * This is the main entry point used by BlocklyViewerComponent.
   */
  async toBlocklyWorkspace(sourceCode: string, objectType?: string): Promise<BlocklySerializedWorkspace> {
    this.blockIdCounter = 0;

    // Try AST-based transformation first
    const blocks = await this.transformSource(sourceCode, objectType);

    return {
      blocks: {
        languageVersion: 0,
        blocks: blocks.map((block, i) => ({
          ...block,
          x: 20,
          y: 20 + (i * 200)
        }))
      }
    };
  }

  private async transformSource(sourceCode: string, objectType?: string): Promise<BlocklyBlock[]> {
    // For simple types, use direct block mapping without parsing
    if (objectType === 'check_constraint') {
      return [this.createCheckBlock(sourceCode)];
    }
    if (objectType === 'column_default') {
      return [this.createDefaultBlock(sourceCode)];
    }
    if (objectType === 'rls_policy') {
      return this.createRlsPolicyBlocks(sourceCode);
    }

    // Try regex-based extraction for function/trigger/view definitions
    return this.extractBlocksFromSource(sourceCode, objectType);
  }

  /**
   * Regex-based block extraction that works without WASM parsing.
   * Parses the source line by line and creates appropriate blocks.
   */
  private extractBlocksFromSource(source: string, objectType?: string): BlocklyBlock[] {
    const blocks: BlocklyBlock[] = [];
    const lines = source.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--'));

    // Detect function definition
    const funcMatch = source.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)\s*\(([^)]*)\).*?RETURNS\s+(\S+)/si);
    if (funcMatch) {
      const funcBlock = this.createFunctionDefBlock(funcMatch[1], funcMatch[2], funcMatch[3]);
      const bodyBlocks = this.extractFunctionBody(source);
      if (bodyBlocks.length > 0) {
        funcBlock.inputs = { BODY: { block: this.chainBlocks(bodyBlocks) } };
      }
      blocks.push(funcBlock);
      return blocks;
    }

    // Detect view definition
    const viewMatch = source.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:\w+\.)?(\w+)\s+AS\s*/si);
    if (viewMatch) {
      const viewBlock = this.createViewDefBlock(viewMatch[1]);
      const bodyBlocks = this.extractViewBody(source);
      if (bodyBlocks.length > 0) {
        viewBlock.inputs = { BODY: { block: this.chainBlocks(bodyBlocks) } };
      }
      blocks.push(viewBlock);
      return blocks;
    }

    // Detect trigger definition
    const triggerMatch = source.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\w\s,]+?)\s+ON\s+(?:\w+\.)?(\w+).*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:\w+\.)?(\w+)\s*\(\)/si);
    if (triggerMatch) {
      blocks.push(this.createTriggerDefBlock(
        triggerMatch[1],
        triggerMatch[2],
        triggerMatch[3].trim(),
        triggerMatch[4],
        triggerMatch[5]
      ));
      return blocks;
    }

    // Fallback: create raw SQL block for each statement
    if (source.trim()) {
      blocks.push(this.createRawBlock(this.truncate(source, 120)));
    }

    return blocks;
  }

  /**
   * Extract PL/pgSQL function body statements into blocks.
   */
  private extractFunctionBody(source: string): BlocklyBlock[] {
    const blocks: BlocklyBlock[] = [];

    // Find the body between BEGIN and END
    const bodyMatch = source.match(/\bBEGIN\b([\s\S]*?)\bEND\b/i);
    if (!bodyMatch) return blocks;

    const body = bodyMatch[1];
    const statements = this.splitStatements(body);

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;

      const block = this.statementToBlock(trimmed);
      if (block) blocks.push(block);
    }

    return blocks;
  }

  /**
   * Extract SELECT body from a VIEW definition.
   */
  private extractViewBody(source: string): BlocklyBlock[] {
    const blocks: BlocklyBlock[] = [];

    // Strip the CREATE VIEW ... AS prefix
    const bodyMatch = source.match(/\bAS\b\s*([\s\S]+?)(?:;|\s*$)/i);
    if (!bodyMatch) return blocks;

    const selectBody = bodyMatch[1].trim();

    // Extract SELECT clause
    const selectMatch = selectBody.match(/\bSELECT\b\s+([\s\S]+?)\bFROM\b/i);
    if (selectMatch) {
      blocks.push(this.createBlock('sql_select', { COLUMNS: this.truncate(selectMatch[1].trim(), 80) }));
    }

    // Extract FROM clause
    const fromMatch = selectBody.match(/\bFROM\b\s+([\s\S]+?)(?:\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bLEFT\b|\bJOIN\b|\bRIGHT\b|\bINNER\b|$)/i);
    if (fromMatch) {
      const lastSelectBlock = blocks[blocks.length - 1];
      if (lastSelectBlock && lastSelectBlock.type === 'sql_select') {
        lastSelectBlock.fields!['TABLE'] = this.truncate(fromMatch[1].trim(), 60);
      }
    }

    // Extract JOINs
    const joinRegex = /\b(LEFT|RIGHT|INNER|FULL|CROSS)?\s*JOIN\s+([\w.]+)\s+(?:\w+\s+)?ON\s+(.+?)(?=\bLEFT\b|\bRIGHT\b|\bINNER\b|\bJOIN\b|\bWHERE\b|\bGROUP\b|\bORDER\b|$)/gi;
    let joinMatch;
    while ((joinMatch = joinRegex.exec(selectBody)) !== null) {
      blocks.push(this.createBlock('sql_join', {
        TYPE: (joinMatch[1] || 'INNER').trim(),
        TABLE: joinMatch[2].trim(),
        CONDITION: this.truncate(joinMatch[3].trim(), 60)
      }));
    }

    // Extract WHERE clause
    const whereMatch = selectBody.match(/\bWHERE\b\s+([\s\S]+?)(?:\bGROUP\b|\bORDER\b|\bLIMIT\b|$)/i);
    if (whereMatch) {
      blocks.push(this.createBlock('sql_where', { CONDITION: this.truncate(whereMatch[1].trim(), 80) }));
    }

    // Extract GROUP BY
    const groupMatch = selectBody.match(/\bGROUP\s+BY\b\s+([\s\S]+?)(?:\bHAVING\b|\bORDER\b|\bLIMIT\b|$)/i);
    if (groupMatch) {
      blocks.push(this.createBlock('sql_group_by', { COLUMNS: this.truncate(groupMatch[1].trim(), 60) }));
    }

    // Extract ORDER BY
    const orderMatch = selectBody.match(/\bORDER\s+BY\b\s+([\s\S]+?)(?:\bLIMIT\b|$)/i);
    if (orderMatch) {
      blocks.push(this.createBlock('sql_order_by', { COLUMNS: this.truncate(orderMatch[1].trim(), 60) }));
    }

    return blocks;
  }

  /**
   * Convert a single PL/pgSQL statement into a Blockly block.
   */
  private statementToBlock(stmt: string): BlocklyBlock | null {
    const upper = stmt.toUpperCase();

    // IF statement
    if (upper.startsWith('IF ')) {
      return this.parseIfStatement(stmt);
    }

    // Variable assignment
    const assignMatch = stmt.match(/^(\w+)\s*:=\s*(.+?);?$/s);
    if (assignMatch) {
      return this.createBlock('plpgsql_set_var', {
        NAME: assignMatch[1],
        VALUE: this.truncate(assignMatch[2], 60)
      });
    }

    // RETURN
    if (upper.startsWith('RETURN ')) {
      return this.createBlock('plpgsql_return', {
        VALUE: this.truncate(stmt.replace(/^RETURN\s+/i, '').replace(/;$/, ''), 80)
      });
    }

    // PERFORM
    if (upper.startsWith('PERFORM ')) {
      return this.createBlock('plpgsql_perform', {
        EXPRESSION: this.truncate(stmt.replace(/^PERFORM\s+/i, '').replace(/;$/, ''), 80)
      });
    }

    // RAISE
    const raiseMatch = stmt.match(/^RAISE\s+(EXCEPTION|NOTICE|WARNING|DEBUG|LOG|INFO)\s+(.+?);?$/si);
    if (raiseMatch) {
      return this.createBlock('plpgsql_raise', {
        LEVEL: raiseMatch[1].toUpperCase(),
        MESSAGE: this.truncate(raiseMatch[2], 60)
      });
    }

    // SELECT ... INTO
    if (upper.match(/^SELECT\b.*\bINTO\b/)) {
      const intoMatch = stmt.match(/^SELECT\s+(.+?)\s+INTO\s+(\w+)\s+FROM\s+(.+?);?$/si);
      if (intoMatch) {
        return this.createBlock('sql_select_into', {
          COLUMNS: this.truncate(intoMatch[1], 40),
          TARGET: intoMatch[2],
          TABLE: this.truncate(intoMatch[3], 40)
        });
      }
    }

    // INSERT
    if (upper.startsWith('INSERT INTO')) {
      const insertMatch = stmt.match(/^INSERT\s+INTO\s+(?:\w+\.)?(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+?)\)/si);
      if (insertMatch) {
        return this.createBlock('sql_insert', {
          TABLE: insertMatch[1],
          COLUMNS: this.truncate(insertMatch[2], 40),
          VALUES: this.truncate(insertMatch[3], 40)
        });
      }
      return this.createBlock('sql_insert', {
        TABLE: this.truncate(stmt.replace(/^INSERT\s+INTO\s+/i, '').split(/\s/)[0], 40),
        COLUMNS: '...',
        VALUES: '...'
      });
    }

    // UPDATE
    if (upper.startsWith('UPDATE ')) {
      const updateMatch = stmt.match(/^UPDATE\s+(?:\w+\.)?(\w+)\s+SET\s+(.+?)(?:\s+WHERE\b|;|$)/si);
      if (updateMatch) {
        return this.createBlock('sql_update', {
          TABLE: updateMatch[1],
          ASSIGNMENTS: this.truncate(updateMatch[2], 60)
        });
      }
    }

    // DELETE
    if (upper.startsWith('DELETE FROM')) {
      return this.createBlock('sql_delete', {
        TABLE: this.truncate(stmt.replace(/^DELETE\s+FROM\s+/i, '').split(/\s/)[0], 40)
      });
    }

    // NOTIFY
    const notifyMatch = stmt.match(/^NOTIFY\s+(\w+)(?:\s*,\s*(.+?))?;?$/i);
    if (notifyMatch) {
      return this.createBlock('plpgsql_notify', {
        CHANNEL: notifyMatch[1],
        PAYLOAD: notifyMatch[2] || ''
      });
    }

    // FOR loop
    const forMatch = stmt.match(/^FOR\s+(\w+)\s+IN\s+(.+)/si);
    if (forMatch) {
      return this.createBlock('plpgsql_for_each', {
        VARIABLE: forMatch[1],
        QUERY: this.truncate(forMatch[2].replace(/\bLOOP\b.*$/si, '').trim(), 60)
      });
    }

    // Fallback: raw SQL
    return this.createRawBlock(this.truncate(stmt.replace(/;$/, ''), 100));
  }

  /**
   * Parse an IF statement into an if/if-else block.
   */
  private parseIfStatement(stmt: string): BlocklyBlock {
    const condMatch = stmt.match(/^IF\s+(.+?)\s+THEN/si);
    const condition = condMatch ? this.truncate(condMatch[1], 60) : 'condition';

    const hasElse = /\bELSE\b/i.test(stmt);

    if (hasElse) {
      return this.createBlock('plpgsql_if_else', { CONDITION: condition });
    }
    return this.createBlock('plpgsql_if', { CONDITION: condition });
  }

  /**
   * Split PL/pgSQL body into individual statements.
   * Handles nested BEGIN/END, IF/END IF, etc.
   */
  private splitStatements(body: string): string[] {
    const statements: string[] = [];
    let current = '';
    let depth = 0;

    const lines = body.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;

      // Track nesting depth
      const upperTrimmed = trimmed.toUpperCase();
      if (upperTrimmed.startsWith('IF ') || upperTrimmed.startsWith('FOR ') ||
          upperTrimmed.startsWith('LOOP') || upperTrimmed.startsWith('BEGIN') ||
          upperTrimmed.startsWith('CASE')) {
        depth++;
      }
      if (upperTrimmed.startsWith('END IF') || upperTrimmed.startsWith('END LOOP') ||
          upperTrimmed === 'END' || upperTrimmed === 'END;' ||
          upperTrimmed.startsWith('END CASE')) {
        depth = Math.max(0, depth - 1);
      }

      current += (current ? '\n' : '') + trimmed;

      // Statement ends at semicolon when not nested
      if (depth === 0 && trimmed.endsWith(';')) {
        statements.push(current.replace(/;$/, ''));
        current = '';
      }
    }

    if (current.trim()) {
      statements.push(current);
    }

    return statements;
  }

  // =========================================================================
  // Block creation helpers
  // =========================================================================

  private createFunctionDefBlock(name: string, params: string, returnType: string): BlocklyBlock {
    return {
      type: 'sql_function_def',
      id: this.nextId(),
      fields: {
        NAME: name,
        PARAMS: this.truncate(params.trim(), 60),
        RETURN_TYPE: returnType
      }
    };
  }

  private createViewDefBlock(name: string): BlocklyBlock {
    return {
      type: 'sql_view_def',
      id: this.nextId(),
      fields: { NAME: name }
    };
  }

  private createTriggerDefBlock(name: string, timing: string, events: string, table: string, func: string): BlocklyBlock {
    return {
      type: 'sql_trigger_def',
      id: this.nextId(),
      fields: {
        NAME: name,
        TIMING: timing,
        EVENTS: events,
        TABLE: table,
        FUNCTION: func + '()'
      }
    };
  }

  private createCheckBlock(expr: string): BlocklyBlock {
    return this.createBlock('sql_check', { EXPRESSION: expr });
  }

  private createDefaultBlock(expr: string): BlocklyBlock {
    return this.createBlock('sql_default', { EXPRESSION: expr });
  }

  private createRlsPolicyBlocks(source: string): BlocklyBlock[] {
    const blocks: BlocklyBlock[] = [];

    const usingMatch = source.match(/USING\s*\((.+?)\)/si);
    if (usingMatch) {
      blocks.push(this.createBlock('rls_using', { EXPRESSION: this.truncate(usingMatch[1], 80) }));
    }

    const withCheckMatch = source.match(/WITH\s+CHECK\s*\((.+?)\)/si);
    if (withCheckMatch) {
      blocks.push(this.createBlock('rls_with_check', { EXPRESSION: this.truncate(withCheckMatch[1], 80) }));
    }

    if (blocks.length === 0) {
      blocks.push(this.createRawBlock(this.truncate(source, 100)));
    }

    return blocks;
  }

  private createBlock(type: string, fields: Record<string, string>): BlocklyBlock {
    return { type, id: this.nextId(), fields };
  }

  private createRawBlock(sql: string): BlocklyBlock {
    return this.createBlock('sql_raw', { SQL: sql });
  }

  /**
   * Chain an array of blocks into a linked list using the `next` property.
   */
  private chainBlocks(blocks: BlocklyBlock[]): BlocklyBlock {
    for (let i = 0; i < blocks.length - 1; i++) {
      blocks[i].next = { block: blocks[i + 1] };
    }
    return blocks[0];
  }

  private nextId(): string {
    return `block_${++this.blockIdCounter}`;
  }

  private truncate(str: string, maxLen: number): string {
    if (!str) return '';
    const clean = str.replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.substring(0, maxLen - 3) + '...' : clean;
  }
}
