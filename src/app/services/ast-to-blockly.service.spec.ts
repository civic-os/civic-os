/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AstToBlocklyService } from './ast-to-blockly.service';

describe('AstToBlocklyService', () => {
  let service: AstToBlocklyService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()]
    });
    service = TestBed.inject(AstToBlocklyService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('toBlocklyWorkspace', () => {
    it('should return empty workspace for null AST', () => {
      const result = service.toBlocklyWorkspace(null, 'test_fn', 'void', 'plpgsql');
      expect(result.blocks.blocks).toEqual([]);
    });

    it('should return empty workspace for empty array AST', () => {
      const result = service.toBlocklyWorkspace([], 'test_fn', 'void', 'plpgsql');
      expect(result.blocks.blocks).toEqual([]);
    });

    it('should create function def block with name and return type', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: { lineno: 1, body: [] }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'my_function', 'jsonb', 'plpgsql');
      expect(result.blocks.blocks.length).toBe(1);

      const funcBlock = result.blocks.blocks[0];
      expect(funcBlock.type).toBe('sql_function_def');
      expect(funcBlock.fields.NAME).toBe('my_function');
      expect(funcBlock.fields.RETURN_TYPE).toBe('jsonb');
    });

    it('should map DECLARE variables (skipping found and parameters before found)', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            // Parameter comes before 'found' — should be skipped
            { PLpgSQL_var: { refname: 'p_entity_id', datatype: { PLpgSQL_type: { typname: 'INT8' } } } },
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } },
            // Local variables come after 'found' — should appear as DECLARE
            { PLpgSQL_var: { refname: 'v_count', datatype: { PLpgSQL_type: { typname: 'INT' } } } },
            { PLpgSQL_rec: { refname: 'v_record' } }
          ],
          action: {
            PLpgSQL_stmt_block: { lineno: 1, body: [] }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];

      // Should have BODY with declare blocks
      expect(funcBlock.inputs.BODY).toBeTruthy();
      const firstBlock = funcBlock.inputs.BODY.block;
      expect(firstBlock.type).toBe('plpgsql_declare');
      expect(firstBlock.fields.NAME).toBe('v_count');
      expect(firstBlock.fields.TYPE).toBe('INT');

      // Second declare block via next
      const secondBlock = firstBlock.next?.block;
      expect(secondBlock).toBeTruthy();
      expect(secondBlock.type).toBe('plpgsql_declare');
      expect(secondBlock.fields.NAME).toBe('v_record');
      expect(secondBlock.fields.TYPE).toBe('RECORD');
    });

    it('should NOT include function parameters in DECLARE blocks', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'p_entity_id', datatype: { PLpgSQL_type: { typname: 'INT8' } } } },
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } },
            { PLpgSQL_var: { refname: 'v_result', datatype: { PLpgSQL_type: { typname: 'TEXT' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: { lineno: 1, body: [] }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const firstBlock = funcBlock.inputs.BODY.block;

      // Only v_result should appear, NOT p_entity_id
      expect(firstBlock.type).toBe('plpgsql_declare');
      expect(firstBlock.fields.NAME).toBe('v_result');
      expect(firstBlock.next).toBeUndefined();
    });

    it('should skip PLpgSQL_row and PLpgSQL_recfield datums in DECLARE', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } },
            { PLpgSQL_var: { refname: 'v_fee', datatype: { PLpgSQL_type: { typname: 'MONEY' } } } },
            { PLpgSQL_row: { refname: '(unnamed row)', fields: [] } },
            { PLpgSQL_recfield: { fieldname: 'time_slot', recparentno: 2 } }
          ],
          action: {
            PLpgSQL_stmt_block: { lineno: 1, body: [] }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const firstBlock = funcBlock.inputs.BODY.block;

      // Only v_fee should appear, PLpgSQL_row and PLpgSQL_recfield are internal
      expect(firstBlock.type).toBe('plpgsql_declare');
      expect(firstBlock.fields.NAME).toBe('v_fee');
      expect(firstBlock.next).toBeUndefined();
    });

    it('should map PLpgSQL_stmt_return', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                { PLpgSQL_stmt_return: { lineno: 5, expr: { PLpgSQL_expr: { query: 'jsonb_build_object(\'success\', true)' } } } }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'jsonb', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const returnBlock = funcBlock.inputs.BODY.block;
      expect(returnBlock.type).toBe('plpgsql_return');
      expect(returnBlock.fields.VALUE).toContain('jsonb_build_object');
    });

    it('should map PLpgSQL_stmt_assign using datums lookup', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } },
            { PLpgSQL_var: { refname: 'v_fee', datatype: { PLpgSQL_type: { typname: 'MONEY' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                { PLpgSQL_stmt_assign: { lineno: 5, varno: 1, expr: { PLpgSQL_expr: { query: 'calculate_fee(v_id)' } } } }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');

      // Verify variables array is populated for Blockly's variable model
      expect(result.variables).toBeDefined();
      expect(result.variables.find((v: any) => v.name === 'v_fee')).toBeTruthy();

      const funcBlock = result.blocks.blocks[0];
      // Skip declare block, find assign
      const declareBlock = funcBlock.inputs.BODY.block;
      expect(declareBlock.type).toBe('plpgsql_declare');

      // Assignment uses Blockly's built-in variables_set with sql_expression value
      const assignBlock = declareBlock.next.block;
      expect(assignBlock.type).toBe('variables_set');
      expect(assignBlock.fields.VAR.id).toBe('var_v_fee');
      expect(assignBlock.inputs.VALUE.block.type).toBe('sql_expression');
      expect(assignBlock.inputs.VALUE.block.fields.EXPRESSION).toContain('calculate_fee');
    });

    it('should strip := prefix from assignment expression query', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } },
            { PLpgSQL_var: { refname: 'v_fee', datatype: { PLpgSQL_type: { typname: 'MONEY' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_assign: {
                    lineno: 5,
                    varno: 1,
                    expr: { PLpgSQL_expr: { query: 'v_fee := calculate_facility_fee(lower(v_request.time_slot))' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      // Skip declare, get to assign
      const assignBlock = funcBlock.inputs.BODY.block.next.block;
      expect(assignBlock.type).toBe('variables_set');
      // Expression should be ONLY the RHS — no "v_fee :=" prefix
      const exprBlock = assignBlock.inputs.VALUE.block;
      expect(exprBlock.fields.EXPRESSION).toBe('calculate_facility_fee(lower(v_request.time_slot))');
      expect(exprBlock.fields.EXPRESSION).not.toContain(':=');
    });

    it('should map PLpgSQL_stmt_if without else', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_if: {
                    lineno: 3,
                    cond: { PLpgSQL_expr: { query: 'NOT FOUND' } },
                    then_body: [
                      { PLpgSQL_stmt_return: { lineno: 4, expr: { PLpgSQL_expr: { query: 'NULL' } } } }
                    ]
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const ifBlock = funcBlock.inputs.BODY.block;
      expect(ifBlock.type).toBe('plpgsql_if');
      expect(ifBlock.fields.CONDITION).toBe('NOT FOUND');
      expect(ifBlock.inputs.THEN_BODY).toBeTruthy();
      expect(ifBlock.inputs.THEN_BODY.block.type).toBe('plpgsql_return');
    });

    it('should map PLpgSQL_stmt_if with else as plpgsql_if_else', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_if: {
                    lineno: 3,
                    cond: { PLpgSQL_expr: { query: 'v_count > 0' } },
                    then_body: [
                      { PLpgSQL_stmt_return: { lineno: 4, expr: { PLpgSQL_expr: { query: 'true' } } } }
                    ],
                    else_body: [
                      { PLpgSQL_stmt_return: { lineno: 6, expr: { PLpgSQL_expr: { query: 'false' } } } }
                    ]
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'boolean', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const ifBlock = funcBlock.inputs.BODY.block;
      expect(ifBlock.type).toBe('plpgsql_if_else');
      expect(ifBlock.inputs.THEN_BODY).toBeTruthy();
      expect(ifBlock.inputs.ELSE_BODY).toBeTruthy();
    });

    it('should map execsql SELECT INTO using AST target field', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_execsql: {
                    lineno: 5,
                    into: true,
                    target: { PLpgSQL_var: { refname: 'v_status_id' } },
                    sqlstmt: { PLpgSQL_expr: { query: 'SELECT id FROM statuses WHERE name = \'approved\'' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const selectBlock = funcBlock.inputs.BODY.block;
      expect(selectBlock.type).toBe('sql_select_into');
      expect(selectBlock.fields.COLUMNS).toBe('id');
      expect(selectBlock.fields.TARGET).toBe('v_status_id');
      expect(selectBlock.fields.TABLE).toContain('statuses');
    });

    it('should map SELECT INTO with record target', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_execsql: {
                    lineno: 5,
                    into: true,
                    target: { PLpgSQL_rec: { refname: 'v_request', dno: 2 } },
                    sqlstmt: { PLpgSQL_expr: { query: 'SELECT * FROM reservation_requests WHERE id = p_entity_id' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const selectBlock = funcBlock.inputs.BODY.block;
      expect(selectBlock.type).toBe('sql_select_into');
      expect(selectBlock.fields.TARGET).toBe('v_request');
      expect(selectBlock.fields.COLUMNS).toBe('*');
    });

    it('should fall back to regex for SELECT INTO embedded in query text', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_execsql: {
                    lineno: 5,
                    sqlstmt: { PLpgSQL_expr: { query: 'SELECT id INTO v_status_id FROM statuses WHERE name = \'approved\'' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const selectBlock = funcBlock.inputs.BODY.block;
      expect(selectBlock.type).toBe('sql_select_into');
      expect(selectBlock.fields.COLUMNS).toBe('id');
      expect(selectBlock.fields.TARGET).toBe('v_status_id');
    });

    it('should map execsql UPDATE statement with WHERE', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_execsql: {
                    lineno: 5,
                    sqlstmt: { PLpgSQL_expr: { query: 'UPDATE requests SET status_id = v_approved WHERE id = p_entity_id' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const updateBlock = funcBlock.inputs.BODY.block;
      expect(updateBlock.type).toBe('sql_update');
      expect(updateBlock.fields.TABLE).toBe('requests');
      expect(updateBlock.fields.WHERE).toBeTruthy();
    });

    it('should map PLpgSQL_stmt_perform', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                {
                  PLpgSQL_stmt_perform: {
                    lineno: 5,
                    expr: { PLpgSQL_expr: { query: 'notify_user(v_user_id)' } }
                  }
                }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const performBlock = funcBlock.inputs.BODY.block;
      expect(performBlock.type).toBe('plpgsql_perform');
      expect(performBlock.fields.EXPRESSION).toContain('notify_user');
    });

    it('should handle unknown statement types gracefully', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: {
              lineno: 1,
              body: [
                { PLpgSQL_stmt_unknown_future_type: { lineno: 5 } }
              ]
            }
          }
        }
      }];

      const result = service.toBlocklyWorkspace(ast, 'test_fn', 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      const rawBlock = funcBlock.inputs.BODY.block;
      expect(rawBlock.type).toBe('sql_raw');
    });
  });

  describe('toBlocklyWorkspaceForView', () => {
    it('should create view def block', () => {
      const ast = { stmts: [{ stmt: { SelectStmt: {} } }] };
      const result = service.toBlocklyWorkspaceForView(ast, 'my_view');
      expect(result.blocks.blocks.length).toBe(1);
      expect(result.blocks.blocks[0].type).toBe('sql_view_def');
      expect(result.blocks.blocks[0].fields.NAME).toBe('my_view');
    });

    it('should handle null AST for view', () => {
      const result = service.toBlocklyWorkspaceForView(null, 'my_view');
      expect(result.blocks.blocks.length).toBe(1);
      expect(result.blocks.blocks[0].type).toBe('sql_view_def');
    });
  });

  describe('truncation', () => {
    it('should truncate long function names', () => {
      const ast = [{
        PLpgSQL_function: {
          datums: [
            { PLpgSQL_var: { refname: 'found', datatype: { PLpgSQL_type: { typname: 'BOOLEAN' } } } }
          ],
          action: {
            PLpgSQL_stmt_block: { lineno: 1, body: [] }
          }
        }
      }];

      const longName = 'a'.repeat(100);
      const result = service.toBlocklyWorkspace(ast, longName, 'void', 'plpgsql');
      const funcBlock = result.blocks.blocks[0];
      expect(funcBlock.fields.NAME.length).toBeLessThanOrEqual(60);
      expect(funcBlock.fields.NAME).toContain('...');
    });
  });
});
