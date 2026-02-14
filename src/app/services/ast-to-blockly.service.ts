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
 * Maps pre-parsed PL/pgSQL AST JSON (from pg_query_go) to Blockly workspace JSON.
 *
 * The Go consolidated worker parses functions/views using libpg_query's
 * ParsePlPgSqlToJSON() and stores the result in metadata.parsed_source_code.
 * This service takes that AST and deterministically maps each node type
 * to the corresponding Blockly block definition from sql-blocks.ts.
 *
 * This replaces the regex-based SqlBlockTransformerService for functions
 * that have pre-parsed ASTs available.
 *
 * @since v0.29.0
 */
@Injectable({ providedIn: 'root' })
export class AstToBlocklyService {

  private nextBlockId = 1;
  /** Maps variable name → unique variable ID for Blockly's variable model. */
  private variableMap = new Map<string, string>();

  /**
   * Convert a pre-parsed PL/pgSQL AST into a Blockly workspace JSON structure.
   *
   * @param astJson The parsed AST from metadata.parsed_source_code.ast_json
   * @param functionName The function name (for the definition block)
   * @param returnType The function's return type (e.g., 'jsonb')
   * @param language The function language ('plpgsql' or 'sql')
   * @returns Blockly workspace JSON compatible with Blockly.serialization.workspaces.load()
   */
  toBlocklyWorkspace(
    astJson: any,
    functionName: string,
    returnType: string,
    language: string
  ): any {
    this.nextBlockId = 1;
    this.variableMap.clear();

    // The AST is an array with a single PLpgSQL_function element
    const funcNode = this.extractFunctionNode(astJson);
    if (!funcNode) {
      return { blocks: { languageVersion: 0, blocks: [] } };
    }

    // Build datums lookup for variable name resolution
    const datums = this.buildDatumsMap(funcNode.datums || []);

    // Pre-register all variables from datums for Blockly's variable model
    this.registerVariablesFromDatums(funcNode.datums || []);

    // Extract parameters from datums (PLpgSQL_var entries that are arguments)
    const params = this.extractParams(funcNode.datums || []);

    // Build function definition block
    const bodyStatements = this.extractBodyStatements(funcNode);
    const bodyBlocks = this.mapStatements(bodyStatements, datums);

    // Declare blocks come from datums (skip 'found' and params)
    const declareBlocks = this.mapDeclarations(funcNode.datums || []);

    // Chain declares + body
    const allBlocks = [...declareBlocks, ...bodyBlocks];
    const chainedBody = this.chainBlocks(allBlocks);

    const functionBlock: any = {
      type: 'sql_function_def',
      id: this.newId(),
      x: 20,
      y: 20,
      fields: {
        NAME: this.truncate(functionName, 60),
        PARAMS: this.truncate(params, 80),
        RETURN_TYPE: this.truncate(returnType, 40)
      },
      inputs: {}
    };

    if (chainedBody) {
      functionBlock.inputs.BODY = { block: chainedBody };
    }

    return {
      variables: this.buildVariablesArray(),
      blocks: {
        languageVersion: 0,
        blocks: [functionBlock]
      }
    };
  }

  /**
   * Convert a pre-parsed SQL view AST into a Blockly workspace JSON structure.
   */
  toBlocklyWorkspaceForView(
    astJson: any,
    viewName: string
  ): any {
    this.nextBlockId = 1;

    // For views, the AST is a standard SQL parse tree
    // We create a simple view definition block with a raw SQL body
    const viewBlock: any = {
      type: 'sql_view_def',
      id: this.newId(),
      x: 20,
      y: 20,
      fields: {
        NAME: this.truncate(viewName, 60)
      },
      inputs: {}
    };

    // Try to extract SELECT components from the parse tree
    const selectBlocks = this.mapSqlParseTree(astJson);
    const chainedBody = this.chainBlocks(selectBlocks);

    if (chainedBody) {
      viewBlock.inputs.BODY = { block: chainedBody };
    }

    return {
      blocks: {
        languageVersion: 0,
        blocks: [viewBlock]
      }
    };
  }

  // =========================================================================
  // AST Node Extraction
  // =========================================================================

  private extractFunctionNode(astJson: any): any {
    if (Array.isArray(astJson)) {
      for (const item of astJson) {
        if (item?.PLpgSQL_function) return item.PLpgSQL_function;
      }
    } else if (astJson?.PLpgSQL_function) {
      return astJson.PLpgSQL_function;
    }
    return null;
  }

  private extractBodyStatements(funcNode: any): any[] {
    const block = funcNode?.action?.PLpgSQL_stmt_block;
    if (!block) return [];
    return block.body || [];
  }

  // =========================================================================
  // Datums (Variable) Handling
  // =========================================================================

  private buildDatumsMap(datums: any[]): Map<number, string> {
    const map = new Map<number, string>();
    for (let i = 0; i < datums.length; i++) {
      const datum = datums[i];
      if (datum?.PLpgSQL_var) {
        map.set(i, datum.PLpgSQL_var.refname);
      } else if (datum?.PLpgSQL_row) {
        map.set(i, datum.PLpgSQL_row.refname || `row_${i}`);
      } else if (datum?.PLpgSQL_rec) {
        map.set(i, datum.PLpgSQL_rec.refname || `rec_${i}`);
      }
    }
    return map;
  }

  /**
   * Register all PL/pgSQL local variables in the variable map for Blockly's
   * built-in variables_set / variables_get blocks.
   * Skips function parameters (before 'found') and internal datum types.
   */
  private registerVariablesFromDatums(datums: any[]): void {
    let pastFound = false;
    for (const datum of datums) {
      if (datum?.PLpgSQL_var?.refname === 'found') {
        pastFound = true;
        continue;
      }
      if (!pastFound) continue;

      if (datum?.PLpgSQL_row || datum?.PLpgSQL_recfield) continue;

      if (datum?.PLpgSQL_var) {
        this.getOrCreateVarId(datum.PLpgSQL_var.refname);
      } else if (datum?.PLpgSQL_rec) {
        this.getOrCreateVarId(datum.PLpgSQL_rec.refname || 'record');
      }
    }
  }

  /** Get or create a stable variable ID for a variable name. */
  private getOrCreateVarId(name: string): string {
    if (!this.variableMap.has(name)) {
      this.variableMap.set(name, `var_${name}`);
    }
    return this.variableMap.get(name)!;
  }

  /** Build the workspace-level variables array for Blockly serialization. */
  private buildVariablesArray(): any[] {
    return Array.from(this.variableMap.entries()).map(([name, id]) => ({
      name,
      id
    }));
  }

  private extractParams(datums: any[]): string {
    // In PL/pgSQL AST, function parameters are the first datums
    // (after the implicit 'found' variable). They have isconst or isnull flags.
    // For now, extract parameter-like datums based on convention.
    // Parameters are typically the datums with lower indices that aren't 'found'.
    const params: string[] = [];
    for (const datum of datums) {
      if (datum?.PLpgSQL_var) {
        const v = datum.PLpgSQL_var;
        // Skip 'found' (implicit) and variables that look like local declarations
        if (v.refname === 'found') continue;
        // Parameters don't have default_val in the AST
        // This is a heuristic - parameters come before local vars
        if (v.default_val) break; // Local vars with defaults
      }
    }
    // Fallback: we don't distinguish params from locals perfectly.
    // The function signature is better extracted from source.
    return params.join(', ');
  }

  private mapDeclarations(datums: any[]): any[] {
    const blocks: any[] = [];
    // Parameters come before 'found' in the datums array — skip them.
    // Also skip internal datum types (PLpgSQL_row, PLpgSQL_recfield).
    let pastFound = false;
    for (const datum of datums) {
      if (datum?.PLpgSQL_var?.refname === 'found') {
        pastFound = true;
        continue;
      }
      if (!pastFound) continue;

      // Skip internal datum types that shouldn't generate DECLARE blocks
      if (datum?.PLpgSQL_row || datum?.PLpgSQL_recfield) continue;

      if (datum?.PLpgSQL_var) {
        const v = datum.PLpgSQL_var;
        const typeName = v.datatype?.PLpgSQL_type?.typname || 'UNKNOWN';
        blocks.push({
          type: 'plpgsql_declare',
          id: this.newId(),
          fields: {
            NAME: v.refname,
            TYPE: this.truncate(typeName, 40)
          }
        });
      } else if (datum?.PLpgSQL_rec) {
        const r = datum.PLpgSQL_rec;
        blocks.push({
          type: 'plpgsql_declare',
          id: this.newId(),
          fields: {
            NAME: r.refname || 'record',
            TYPE: 'RECORD'
          }
        });
      }
    }
    return blocks;
  }

  // =========================================================================
  // Statement Mapping
  // =========================================================================

  private mapStatements(statements: any[], datums: Map<number, string>): any[] {
    const blocks: any[] = [];
    for (const stmt of statements) {
      const block = this.mapStatement(stmt, datums);
      if (block) blocks.push(block);
    }
    return blocks;
  }

  private mapStatement(stmt: any, datums: Map<number, string>): any {
    if (stmt.PLpgSQL_stmt_execsql) return this.mapExecSql(stmt.PLpgSQL_stmt_execsql);
    if (stmt.PLpgSQL_stmt_if) return this.mapIf(stmt.PLpgSQL_stmt_if, datums);
    if (stmt.PLpgSQL_stmt_return) return this.mapReturn(stmt.PLpgSQL_stmt_return);
    if (stmt.PLpgSQL_stmt_assign) return this.mapAssign(stmt.PLpgSQL_stmt_assign, datums);
    if (stmt.PLpgSQL_stmt_raise) return this.mapRaise(stmt.PLpgSQL_stmt_raise);
    if (stmt.PLpgSQL_stmt_perform) return this.mapPerform(stmt.PLpgSQL_stmt_perform);
    if (stmt.PLpgSQL_stmt_getdiag) return this.mapGetDiag(stmt.PLpgSQL_stmt_getdiag, datums);
    if (stmt.PLpgSQL_stmt_fors) return this.mapForS(stmt.PLpgSQL_stmt_fors, datums);
    if (stmt.PLpgSQL_stmt_fori) return this.mapForI(stmt.PLpgSQL_stmt_fori, datums);
    if (stmt.PLpgSQL_stmt_block) return this.mapBlock(stmt.PLpgSQL_stmt_block, datums);
    if (stmt.PLpgSQL_stmt_dynexecute) return this.mapDynExecute(stmt.PLpgSQL_stmt_dynexecute);
    if (stmt.PLpgSQL_stmt_case) return this.mapCase(stmt.PLpgSQL_stmt_case, datums);

    // Unknown statement type - create raw block
    const stmtType = Object.keys(stmt)[0] || 'unknown';
    return {
      type: 'sql_raw',
      id: this.newId(),
      fields: { SQL: this.truncate(stmtType, 60) }
    };
  }

  // =========================================================================
  // Individual Statement Mappers
  // =========================================================================

  private mapExecSql(node: any): any {
    const query = node.sqlstmt?.PLpgSQL_expr?.query || '';
    const upperQuery = query.trim().toUpperCase();

    // The PL/pgSQL parser strips INTO from the query and puts the target
    // in node.target. Check the structured 'into' flag first, then fall
    // back to regex for queries that still embed INTO in the text.
    if (node.into && upperQuery.startsWith('SELECT')) {
      return this.mapSelectIntoFromAst(query, node.target);
    }
    if (upperQuery.startsWith('SELECT') && upperQuery.includes(' INTO ')) {
      return this.mapSelectIntoFromRegex(query);
    }
    if (upperQuery.startsWith('UPDATE')) {
      return this.mapUpdate(query);
    }
    if (upperQuery.startsWith('INSERT')) {
      return this.mapInsert(query);
    }
    if (upperQuery.startsWith('DELETE')) {
      return this.mapDelete(query);
    }

    // Generic SQL statement
    return {
      type: 'sql_raw',
      id: this.newId(),
      fields: { SQL: this.truncate(query, 100) }
    };
  }

  /** Map SELECT INTO using the structured AST target field. */
  private mapSelectIntoFromAst(query: string, target: any): any {
    // Extract target variable name from the AST node
    const targetName =
      target?.PLpgSQL_var?.refname ||
      target?.PLpgSQL_rec?.refname ||
      target?.PLpgSQL_row?.refname ||
      '?';

    // Query has INTO stripped — parse SELECT <cols> FROM <table> [WHERE ...]
    const match = query.match(/SELECT\s+(.*?)\s+FROM\s+(.*)/is);
    if (!match) {
      return {
        type: 'sql_select_into',
        id: this.newId(),
        fields: {
          COLUMNS: this.truncate(query, 60),
          TARGET: targetName,
          TABLE: ''
        }
      };
    }

    const columns = match[1].trim();
    let fromClause = match[2].trim();
    const whereMatch = fromClause.match(/(.*?)\s+WHERE\s+(.*)/is);
    const table = whereMatch ? whereMatch[1].trim() : fromClause;

    return {
      type: 'sql_select_into',
      id: this.newId(),
      fields: {
        COLUMNS: this.truncate(columns, 60),
        TARGET: this.truncate(targetName, 40),
        TABLE: this.truncate(table, 60)
      }
    };
  }

  /** Fallback: parse SELECT INTO from the raw query text (regex-based transformer path). */
  private mapSelectIntoFromRegex(query: string): any {
    const match = query.match(/SELECT\s+(.*?)\s+INTO\s+(.*?)\s+FROM\s+(.*)/is);
    if (!match) {
      return {
        type: 'sql_select_into',
        id: this.newId(),
        fields: {
          COLUMNS: this.truncate(query, 60),
          TARGET: '',
          TABLE: ''
        }
      };
    }

    const columns = match[1].trim();
    const target = match[2].trim();
    let fromClause = match[3].trim();
    const whereMatch = fromClause.match(/(.*?)\s+WHERE\s+(.*)/is);
    const table = whereMatch ? whereMatch[1].trim() : fromClause;

    return {
      type: 'sql_select_into',
      id: this.newId(),
      fields: {
        COLUMNS: this.truncate(columns, 60),
        TARGET: this.truncate(target, 40),
        TABLE: this.truncate(table, 60)
      }
    };
  }

  private mapUpdate(query: string): any {
    const match = query.match(/UPDATE\s+(\S+)\s+SET\s+(.*?)(?:\s+WHERE\s+(.*))?$/is);
    if (!match) {
      return {
        type: 'sql_update',
        id: this.newId(),
        fields: { TABLE: this.truncate(query, 60), ASSIGNMENTS: '' }
      };
    }

    const block: any = {
      type: 'sql_update',
      id: this.newId(),
      fields: {
        TABLE: this.truncate(match[1], 40),
        ASSIGNMENTS: this.truncate(match[2].trim(), 80)
      }
    };

    if (match[3]) {
      block.fields.WHERE = this.truncate(match[3].trim(), 80);
    }

    return block;
  }

  private mapInsert(query: string): any {
    const match = query.match(/INSERT\s+INTO\s+(\S+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/is);
    if (!match) {
      return {
        type: 'sql_insert',
        id: this.newId(),
        fields: {
          TABLE: this.truncate(query.replace(/INSERT\s+INTO\s+/i, '').split(/\s/)[0] || query, 40),
          COLUMNS: '',
          VALUES: ''
        }
      };
    }

    return {
      type: 'sql_insert',
      id: this.newId(),
      fields: {
        TABLE: this.truncate(match[1], 40),
        COLUMNS: this.truncate(match[2].trim(), 60),
        VALUES: this.truncate(match[3].trim(), 60)
      }
    };
  }

  private mapDelete(query: string): any {
    const match = query.match(/DELETE\s+FROM\s+(\S+)/i);
    return {
      type: 'sql_delete',
      id: this.newId(),
      fields: { TABLE: this.truncate(match?.[1] || query, 40) }
    };
  }

  private mapIf(node: any, datums: Map<number, string>): any {
    const condition = node.cond?.PLpgSQL_expr?.query || 'condition';
    const thenBody = this.mapStatements(node.then_body || [], datums);
    const elseBody = node.else_body ? this.mapStatements(node.else_body, datums) : [];

    const hasElse = elseBody.length > 0;
    const blockType = hasElse ? 'plpgsql_if_else' : 'plpgsql_if';

    const block: any = {
      type: blockType,
      id: this.newId(),
      fields: { CONDITION: this.truncate(condition, 80) },
      inputs: {}
    };

    const chainedThen = this.chainBlocks(thenBody);
    if (chainedThen) {
      block.inputs.THEN_BODY = { block: chainedThen };
    }

    if (hasElse) {
      const chainedElse = this.chainBlocks(elseBody);
      if (chainedElse) {
        block.inputs.ELSE_BODY = { block: chainedElse };
      }
    }

    return block;
  }

  private mapReturn(node: any): any {
    const expr = node.expr?.PLpgSQL_expr?.query || '';
    return {
      type: 'plpgsql_return',
      id: this.newId(),
      fields: { VALUE: this.truncate(expr, 100) }
    };
  }

  private mapAssign(node: any, datums: Map<number, string>): any {
    const varName = datums.get(node.varno) || `var_${node.varno}`;
    let expr = node.expr?.PLpgSQL_expr?.query || '';
    // PLpgSQL parser includes "var := expr" in the query — strip the assignment prefix
    const assignMatch = expr.match(/^.+?:=\s*(.*)/s);
    if (assignMatch) {
      expr = assignMatch[1];
    }
    const varId = this.getOrCreateVarId(varName);
    return {
      type: 'variables_set',
      id: this.newId(),
      fields: {
        VAR: { id: varId }
      },
      inputs: {
        VALUE: {
          block: {
            type: 'sql_expression',
            id: this.newId(),
            fields: { EXPRESSION: this.truncate(expr, 100) }
          }
        }
      }
    };
  }

  private mapRaise(node: any): any {
    const levelMap: Record<string, string> = {
      '0': 'DEBUG',
      '1': 'LOG',
      '2': 'INFO',
      '3': 'NOTICE',
      '4': 'WARNING',
      '5': 'EXCEPTION'
    };
    const level = levelMap[String(node.elog_level)] || node.elog_level || 'EXCEPTION';
    const message = node.message || '';
    return {
      type: 'plpgsql_raise',
      id: this.newId(),
      fields: {
        LEVEL: level,
        MESSAGE: this.truncate(message, 60)
      }
    };
  }

  private mapPerform(node: any): any {
    const query = node.expr?.PLpgSQL_expr?.query || '';
    // PERFORM strips the SELECT keyword, so the expr is the function call
    return {
      type: 'plpgsql_perform',
      id: this.newId(),
      fields: { EXPRESSION: this.truncate(query, 80) }
    };
  }

  private mapGetDiag(node: any, datums: Map<number, string>): any {
    // GET DIAGNOSTICS var = item
    const items = node.diag_items || [];
    if (items.length > 0) {
      const item = items[0];
      const varName = datums.get(item.target) || `var_${item.target}`;
      const diagKind = item.kind === 0 ? 'ROW_COUNT' : `DIAG_${item.kind}`;
      const varId = this.getOrCreateVarId(varName);
      return {
        type: 'variables_set',
        id: this.newId(),
        fields: {
          VAR: { id: varId }
        },
        inputs: {
          VALUE: {
            block: {
              type: 'sql_expression',
              id: this.newId(),
              fields: { EXPRESSION: diagKind }
            }
          }
        }
      };
    }
    return {
      type: 'sql_raw',
      id: this.newId(),
      fields: { SQL: 'GET DIAGNOSTICS ...' }
    };
  }

  private mapForS(node: any, datums: Map<number, string>): any {
    const varName = datums.get(node.var?.PLpgSQL_row?.dno ?? node.var?.PLpgSQL_rec?.dno ?? -1) || 'record';
    const query = node.query?.PLpgSQL_expr?.query || '';
    const bodyBlocks = this.mapStatements(node.body || [], datums);

    const block: any = {
      type: 'plpgsql_for_each',
      id: this.newId(),
      fields: {
        VARIABLE: varName,
        QUERY: this.truncate(query, 60)
      },
      inputs: {}
    };

    const chainedBody = this.chainBlocks(bodyBlocks);
    if (chainedBody) {
      block.inputs.BODY = { block: chainedBody };
    }

    return block;
  }

  private mapForI(node: any, datums: Map<number, string>): any {
    const varName = datums.get(node.var?.PLpgSQL_var?.dno ?? -1) || 'i';
    const lower = node.lower?.PLpgSQL_expr?.query || '1';
    const upper = node.upper?.PLpgSQL_expr?.query || 'N';
    const bodyBlocks = this.mapStatements(node.body || [], datums);

    const block: any = {
      type: 'plpgsql_for_each',
      id: this.newId(),
      fields: {
        VARIABLE: varName,
        QUERY: `${lower} .. ${upper}`
      },
      inputs: {}
    };

    const chainedBody = this.chainBlocks(bodyBlocks);
    if (chainedBody) {
      block.inputs.BODY = { block: chainedBody };
    }

    return block;
  }

  private mapBlock(node: any, datums: Map<number, string>): any {
    // Nested BEGIN...EXCEPTION...END block
    const bodyBlocks = this.mapStatements(node.body || [], datums);

    if (node.exceptions) {
      // Has exception handlers
      const handlerBlocks: any[] = [];
      for (const ex of node.exceptions) {
        if (ex.PLpgSQL_exception) {
          const condNames = (ex.PLpgSQL_exception.conditions || [])
            .map((c: any) => c.sqlstate || c.condition_name || 'OTHERS')
            .join(', ');
          const actionBlocks = this.mapStatements(ex.PLpgSQL_exception.action || [], datums);
          const chainedActions = this.chainBlocks(actionBlocks);

          // Use a WHEN block for each exception condition
          const whenBlock: any = {
            type: 'plpgsql_when',
            id: this.newId(),
            fields: {
              CONDITION: condNames || 'OTHERS',
              RESULT: ''
            }
          };
          handlerBlocks.push(whenBlock);
          if (chainedActions) {
            handlerBlocks.push(chainedActions);
          }
        }
      }

      // Wrap body + exception in an EXCEPTION block
      const chainedBody = this.chainBlocks(bodyBlocks);
      const chainedHandlers = this.chainBlocks(handlerBlocks);

      const block: any = {
        type: 'plpgsql_exception',
        id: this.newId(),
        inputs: {}
      };

      if (chainedHandlers) {
        block.inputs.HANDLERS = { block: chainedHandlers };
      }

      // Chain the body blocks before the exception block
      if (chainedBody) {
        return this.prependToChain(chainedBody, block);
      }
      return block;
    }

    // No exception - just return the body blocks
    return this.chainBlocks(bodyBlocks) || null;
  }

  private mapDynExecute(node: any): any {
    const query = node.query?.PLpgSQL_expr?.query || 'EXECUTE ...';
    return {
      type: 'sql_raw',
      id: this.newId(),
      fields: { SQL: this.truncate(`EXECUTE ${query}`, 80) }
    };
  }

  private mapCase(node: any, datums: Map<number, string>): any {
    const expr = node.t_expr?.PLpgSQL_expr?.query || '';
    const whenBlocks: any[] = [];

    for (const caseWhen of (node.case_when_list || [])) {
      if (caseWhen.PLpgSQL_case_when) {
        const whenExpr = caseWhen.PLpgSQL_case_when.expr?.PLpgSQL_expr?.query || '';
        const stmts = this.mapStatements(caseWhen.PLpgSQL_case_when.stmts || [], datums);
        const result = stmts.length > 0 ? this.getBlockSummary(stmts[0]) : '';

        whenBlocks.push({
          type: 'plpgsql_when',
          id: this.newId(),
          fields: {
            CONDITION: this.truncate(whenExpr, 40),
            RESULT: this.truncate(result, 40)
          }
        });
      }
    }

    const block: any = {
      type: 'plpgsql_case_when',
      id: this.newId(),
      fields: { EXPRESSION: this.truncate(expr, 40) },
      inputs: {}
    };

    const chainedWhens = this.chainBlocks(whenBlocks);
    if (chainedWhens) {
      block.inputs.WHEN_CLAUSES = { block: chainedWhens };
    }

    return block;
  }

  // =========================================================================
  // SQL Parse Tree Mapping (for views)
  // =========================================================================

  private mapSqlParseTree(astJson: any): any[] {
    // For SQL parse trees, extract basic SELECT structure
    try {
      const stmts = astJson?.stmts || (Array.isArray(astJson) ? astJson : []);
      const blocks: any[] = [];

      for (const stmtWrapper of stmts) {
        const stmt = stmtWrapper?.stmt?.SelectStmt || stmtWrapper?.SelectStmt;
        if (stmt) {
          blocks.push({
            type: 'sql_raw',
            id: this.newId(),
            fields: { SQL: 'SELECT query (parsed)' }
          });
        }
      }

      if (blocks.length === 0) {
        blocks.push({
          type: 'sql_raw',
          id: this.newId(),
          fields: { SQL: 'View definition' }
        });
      }

      return blocks;
    } catch {
      return [{
        type: 'sql_raw',
        id: this.newId(),
        fields: { SQL: 'View definition' }
      }];
    }
  }

  // =========================================================================
  // Block Utilities
  // =========================================================================

  private chainBlocks(blocks: any[]): any | null {
    if (blocks.length === 0) return null;

    // Link blocks via next property
    for (let i = 0; i < blocks.length - 1; i++) {
      blocks[i].next = { block: blocks[i + 1] };
    }

    return blocks[0];
  }

  private prependToChain(first: any, second: any): any {
    // Find the last block in the first chain
    let current = first;
    while (current.next?.block) {
      current = current.next.block;
    }
    current.next = { block: second };
    return first;
  }

  private getBlockSummary(block: any): string {
    if (!block) return '';
    const fields = block.fields || {};
    return fields.VALUE || fields.SQL || fields.TABLE || '';
  }

  private truncate(text: string, maxLen: number): string {
    if (!text) return '';
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  }

  private newId(): string {
    return `ast_${this.nextBlockId++}`;
  }
}
