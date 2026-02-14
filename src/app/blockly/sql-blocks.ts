/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * Blockly JSON block definitions for SQL/PL/pgSQL visualization.
 * ~30 blocks organized by category with consistent shapes and colors.
 *
 * Block shapes:
 * - Hat blocks (top-only): Definition blocks (FUNCTION_DEF, VIEW_DEF, TRIGGER_DEF)
 * - C-blocks (wraps children): Control flow (IF, CASE, LOOP, EXCEPTION)
 * - Statement blocks: Most SQL statements (SELECT, INSERT, etc.)
 * - Value blocks: Expressions that return values (VAR_REF, FUNC_CALL)
 */

export const SQL_BLOCK_DEFINITIONS = [
  // =========================================================================
  // DEFINITION BLOCKS (Gray #607D8B) - Hat shape
  // =========================================================================
  {
    type: 'sql_function_def',
    message0: 'FUNCTION %1 (%2)',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'function_name' },
      { type: 'field_label', name: 'PARAMS', text: '' }
    ],
    message1: 'RETURNS %1',
    args1: [
      { type: 'field_label', name: 'RETURN_TYPE', text: 'void' }
    ],
    message2: '%1',
    args2: [
      { type: 'input_statement', name: 'BODY' }
    ],
    style: 'definition_blocks',
    tooltip: 'PL/pgSQL function definition',
    helpUrl: ''
  },
  {
    type: 'sql_view_def',
    message0: 'VIEW %1 AS',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'view_name' }
    ],
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'BODY' }
    ],
    style: 'definition_blocks',
    tooltip: 'SQL view definition',
    helpUrl: ''
  },
  {
    type: 'sql_trigger_def',
    message0: 'TRIGGER %1',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'trigger_name' }
    ],
    message1: '%1 %2 ON %3',
    args1: [
      { type: 'field_label', name: 'TIMING', text: 'AFTER' },
      { type: 'field_label', name: 'EVENTS', text: 'INSERT' },
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    message2: 'EXECUTE %1',
    args2: [
      { type: 'field_label', name: 'FUNCTION', text: 'function_name()' }
    ],
    style: 'definition_blocks',
    tooltip: 'Trigger definition',
    helpUrl: ''
  },

  // =========================================================================
  // QUERY BLOCKS (Blue #2196F3)
  // =========================================================================
  {
    type: 'sql_select',
    message0: 'SELECT %1',
    args0: [
      { type: 'field_label', name: 'COLUMNS', text: '*' }
    ],
    message1: 'FROM %1',
    args1: [
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'SELECT query',
    helpUrl: ''
  },
  {
    type: 'sql_select_into',
    message0: 'SELECT %1 INTO %2',
    args0: [
      { type: 'field_label', name: 'COLUMNS', text: 'expression' },
      { type: 'field_label', name: 'TARGET', text: 'variable' }
    ],
    message1: 'FROM %1',
    args1: [
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'SELECT INTO variable',
    helpUrl: ''
  },
  {
    type: 'sql_where',
    message0: 'WHERE %1',
    args0: [
      { type: 'field_label', name: 'CONDITION', text: 'condition' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'WHERE clause',
    helpUrl: ''
  },
  {
    type: 'sql_join',
    message0: '%1 JOIN %2 ON %3',
    args0: [
      { type: 'field_label', name: 'TYPE', text: 'LEFT' },
      { type: 'field_label', name: 'TABLE', text: 'table_name' },
      { type: 'field_label', name: 'CONDITION', text: 'condition' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'JOIN clause',
    helpUrl: ''
  },
  {
    type: 'sql_order_by',
    message0: 'ORDER BY %1',
    args0: [
      { type: 'field_label', name: 'COLUMNS', text: 'column' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'ORDER BY clause',
    helpUrl: ''
  },
  {
    type: 'sql_limit',
    message0: 'LIMIT %1',
    args0: [
      { type: 'field_label', name: 'COUNT', text: '10' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'LIMIT clause',
    helpUrl: ''
  },
  {
    type: 'sql_group_by',
    message0: 'GROUP BY %1',
    args0: [
      { type: 'field_label', name: 'COLUMNS', text: 'column' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'GROUP BY clause',
    helpUrl: ''
  },

  // =========================================================================
  // MUTATION BLOCKS (Indigo #3F51B5)
  // =========================================================================
  {
    type: 'sql_insert',
    message0: 'INSERT INTO %1',
    args0: [
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    message1: '(%1)',
    args1: [
      { type: 'field_label', name: 'COLUMNS', text: 'columns' }
    ],
    message2: 'VALUES (%1)',
    args2: [
      { type: 'field_label', name: 'VALUES', text: 'values' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'mutation_blocks',
    tooltip: 'INSERT statement',
    helpUrl: ''
  },
  {
    type: 'sql_update',
    message0: 'UPDATE %1',
    args0: [
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    message1: 'SET %1',
    args1: [
      { type: 'field_label', name: 'ASSIGNMENTS', text: 'column = value' }
    ],
    message2: 'WHERE %1',
    args2: [
      { type: 'field_label', name: 'WHERE', text: '' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'mutation_blocks',
    tooltip: 'UPDATE statement',
    helpUrl: ''
  },
  {
    type: 'sql_delete',
    message0: 'DELETE FROM %1',
    args0: [
      { type: 'field_label', name: 'TABLE', text: 'table_name' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'mutation_blocks',
    tooltip: 'DELETE statement',
    helpUrl: ''
  },

  // =========================================================================
  // CONTROL FLOW BLOCKS (Amber #FF9800) - C-block shape
  // =========================================================================
  {
    type: 'plpgsql_if',
    message0: 'IF %1 THEN',
    args0: [
      { type: 'field_label', name: 'CONDITION', text: 'condition' }
    ],
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'THEN_BODY' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'IF/THEN conditional',
    helpUrl: ''
  },
  {
    type: 'plpgsql_if_else',
    message0: 'IF %1 THEN',
    args0: [
      { type: 'field_label', name: 'CONDITION', text: 'condition' }
    ],
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'THEN_BODY' }
    ],
    message2: 'ELSE',
    message3: '%1',
    args3: [
      { type: 'input_statement', name: 'ELSE_BODY' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'IF/THEN/ELSE conditional',
    helpUrl: ''
  },
  {
    type: 'plpgsql_case_when',
    message0: 'CASE %1',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: '' }
    ],
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'WHEN_CLAUSES' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'CASE/WHEN expression',
    helpUrl: ''
  },
  {
    type: 'plpgsql_when',
    message0: 'WHEN %1 THEN %2',
    args0: [
      { type: 'field_label', name: 'CONDITION', text: 'value' },
      { type: 'field_label', name: 'RESULT', text: 'result' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'WHEN clause of CASE',
    helpUrl: ''
  },
  {
    type: 'plpgsql_loop',
    message0: 'LOOP',
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'BODY' }
    ],
    message2: 'END LOOP',
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'LOOP block',
    helpUrl: ''
  },
  {
    type: 'plpgsql_for_each',
    message0: 'FOR %1 IN %2',
    args0: [
      { type: 'field_label', name: 'VARIABLE', text: 'record' },
      { type: 'field_label', name: 'QUERY', text: 'query' }
    ],
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'BODY' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'control_flow_blocks',
    tooltip: 'FOR loop over query results',
    helpUrl: ''
  },

  // =========================================================================
  // VARIABLE BLOCKS (Green #4CAF50)
  // =========================================================================
  {
    type: 'plpgsql_declare',
    message0: 'DECLARE %1 %2',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'variable' },
      { type: 'field_label', name: 'TYPE', text: 'TEXT' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'variable_blocks',
    tooltip: 'Variable declaration',
    helpUrl: ''
  },
  {
    type: 'plpgsql_set_var',
    message0: '%1 := %2',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'variable' },
      { type: 'field_label', name: 'VALUE', text: 'expression' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'variable_blocks',
    tooltip: 'Variable assignment',
    helpUrl: ''
  },
  {
    type: 'plpgsql_return',
    message0: 'RETURN %1',
    args0: [
      { type: 'field_label', name: 'VALUE', text: 'expression' }
    ],
    previousStatement: null,
    style: 'variable_blocks',
    tooltip: 'Return statement',
    helpUrl: ''
  },

  // =========================================================================
  // SIDE EFFECT BLOCKS (Purple #9C27B0)
  // =========================================================================
  {
    type: 'plpgsql_perform',
    message0: 'PERFORM %1',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: 'function_call()' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'side_effect_blocks',
    tooltip: 'Execute function discarding result',
    helpUrl: ''
  },
  {
    type: 'plpgsql_notify',
    message0: 'NOTIFY %1 , %2',
    args0: [
      { type: 'field_label', name: 'CHANNEL', text: 'channel' },
      { type: 'field_label', name: 'PAYLOAD', text: "'message'" }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'side_effect_blocks',
    tooltip: 'Send a notification',
    helpUrl: ''
  },
  {
    type: 'sql_function_call',
    message0: '%1(%2)',
    args0: [
      { type: 'field_label', name: 'NAME', text: 'function_name' },
      { type: 'field_label', name: 'ARGS', text: '' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'side_effect_blocks',
    tooltip: 'Function call',
    helpUrl: ''
  },

  // =========================================================================
  // ERROR HANDLING BLOCKS (Red #F44336) - C-block shape
  // =========================================================================
  {
    type: 'plpgsql_exception',
    message0: 'EXCEPTION',
    message1: '%1',
    args1: [
      { type: 'input_statement', name: 'HANDLERS' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'error_blocks',
    tooltip: 'Exception handler block',
    helpUrl: ''
  },
  {
    type: 'plpgsql_raise',
    message0: 'RAISE %1 %2',
    args0: [
      { type: 'field_label', name: 'LEVEL', text: 'EXCEPTION' },
      { type: 'field_label', name: 'MESSAGE', text: "'error message'" }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'error_blocks',
    tooltip: 'Raise an exception or notice',
    helpUrl: ''
  },

  // =========================================================================
  // SECURITY BLOCKS (Yellow #FFC107)
  // =========================================================================
  {
    type: 'rls_using',
    message0: 'USING (%1)',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: 'condition' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'security_blocks',
    tooltip: 'RLS USING clause',
    helpUrl: ''
  },
  {
    type: 'rls_with_check',
    message0: 'WITH CHECK (%1)',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: 'condition' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'security_blocks',
    tooltip: 'RLS WITH CHECK clause',
    helpUrl: ''
  },

  // =========================================================================
  // CONSTRAINT BLOCKS (Teal #009688)
  // =========================================================================
  {
    type: 'sql_check',
    message0: 'CHECK (%1)',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: 'condition' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'constraint_blocks',
    tooltip: 'CHECK constraint',
    helpUrl: ''
  },
  {
    type: 'sql_default',
    message0: 'DEFAULT %1',
    args0: [
      { type: 'field_label', name: 'EXPRESSION', text: 'value' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'constraint_blocks',
    tooltip: 'Column default value',
    helpUrl: ''
  },

  // =========================================================================
  // VALUE BLOCKS (for plugging into variable_set and other value inputs)
  // =========================================================================
  {
    type: 'sql_expression',
    message0: '%1',
    args0: [
      { type: 'field_label_serializable', name: 'EXPRESSION', text: 'expression' }
    ],
    output: null,
    style: 'side_effect_blocks',
    tooltip: 'A SQL expression value',
    helpUrl: ''
  },

  // =========================================================================
  // GENERIC SQL BLOCK (for unparsed/fallback)
  // =========================================================================
  {
    type: 'sql_raw',
    message0: '%1',
    args0: [
      { type: 'field_label', name: 'SQL', text: 'SQL statement' }
    ],
    previousStatement: null,
    nextStatement: null,
    style: 'query_blocks',
    tooltip: 'Raw SQL statement',
    helpUrl: ''
  }
];

/**
 * Block style categories matching the definitions above.
 * Used by the Blockly theme to assign colors.
 */
export const SQL_BLOCK_STYLES = {
  definition_blocks: { colourPrimary: '#607D8B' },
  query_blocks: { colourPrimary: '#2196F3' },
  mutation_blocks: { colourPrimary: '#3F51B5' },
  control_flow_blocks: { colourPrimary: '#FF9800' },
  variable_blocks: { colourPrimary: '#4CAF50' },
  side_effect_blocks: { colourPrimary: '#9C27B0' },
  error_blocks: { colourPrimary: '#F44336' },
  security_blocks: { colourPrimary: '#FFC107' },
  constraint_blocks: { colourPrimary: '#009688' }
};
