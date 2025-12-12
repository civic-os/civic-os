/**
 * Copyright (C) 2023-2025 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


import { Component, inject, ChangeDetectionStrategy, signal } from '@angular/core';
import { Observable, map, mergeMap, of, combineLatest, debounceTime, distinctUntilChanged, take, catchError, finalize, switchMap } from 'rxjs';
import {
  SchemaEntityProperty,
  SchemaEntityTable,
  EntityPropertyType,
  InverseRelationshipData,
  EntityData,
  PaymentValue,
  RenderableItem,
  isStaticText,
  isProperty,
  EntityAction,
  EntityActionResult
} from '../../interfaces/entity';
import { evaluateCondition } from '../../utils/condition-evaluator';
import { ActionBarComponent, ActionButton } from '../../components/action-bar/action-bar.component';

/**
 * Type guard to check if a value is a PaymentValue object.
 */
function isPaymentValue(value: any): value is PaymentValue {
  return value != null && typeof value === 'object' && 'id' in value && 'status' in value;
}
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { AuthService } from '../../services/auth.service';

import { CommonModule } from '@angular/common';
import { DisplayPropertyComponent } from '../../components/display-property/display-property.component';
import { ManyToManyEditorComponent } from '../../components/many-to-many-editor/many-to-many-editor.component';
import { TimeSlotCalendarComponent, CalendarEvent } from '../../components/time-slot-calendar/time-slot-calendar.component';
import { EmptyStateComponent } from '../../components/empty-state/empty-state.component';
import { PaymentCheckoutComponent } from '../../components/payment-checkout/payment-checkout.component';
import { EntityNotesComponent } from '../../components/entity-notes/entity-notes.component';
import { StaticTextComponent } from '../../components/static-text/static-text.component';
import { Subject, startWith } from 'rxjs';
import { tap } from 'rxjs/operators';

export interface CalendarSection {
  meta: {
    sourceTable: string;
    sourceEntityDisplayName: string;
    sourceColumn: string;
    calendarPropertyName: string;
    calendarColorProperty: string | null;
  };
  events: CalendarEvent[];
}

@Component({
  selector: 'app-detail',
  templateUrl: './detail.page.html',
  styleUrl: './detail.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    RouterModule,
    DisplayPropertyComponent,
    ManyToManyEditorComponent,
    EmptyStateComponent,
    PaymentCheckoutComponent,
    EntityNotesComponent,
    StaticTextComponent,
    ActionBarComponent
    // TimeSlotCalendarComponent
  ]
})
export class DetailPage {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private schema = inject(SchemaService);
  private data = inject(DataService);
  public auth = inject(AuthService);

  // Expose Math and SchemaService to template
  protected readonly Math = Math;
  protected readonly SchemaService = SchemaService;

  // Refresh trigger for M:M changes
  private refreshTrigger$ = new Subject<void>();

  // Delete modal state
  showDeleteModal = signal(false);
  deleteLoading = signal(false);
  deleteError = signal<string | undefined>(undefined);

  // Payment initiation state
  paymentLoading = signal(false);
  paymentError = signal<string | undefined>(undefined);
  showCheckoutModal = signal(false);
  currentPaymentId = signal<string | undefined>(undefined);

  // Entity action state (v0.18.0)
  entityActions = signal<EntityAction[]>([]);
  showActionModal = signal(false);
  currentAction = signal<EntityAction | undefined>(undefined);
  actionLoading = signal(false);
  actionOverlayLoading = signal(false);  // For non-confirmation actions
  actionError = signal<string | undefined>(undefined);
  actionSuccess = signal<string | undefined>(undefined);

  // Data loading state
  dataLoading = signal(true);

  public entityKey?: string;
  public entityId?: string;
  public entity$: Observable<SchemaEntityTable | undefined> = this.route.params.pipe(mergeMap(p => {
    this.entityKey = p['entityKey'];
    this.entityId = p['entityId'];
    if(p['entityKey']) {
      return this.schema.getEntity(p['entityKey']);
    } else {
      return of(undefined);
    }
  }));
  public properties$: Observable<SchemaEntityProperty[]> = this.entity$.pipe(mergeMap(e => {
    if(e) {
      let props = this.schema.getPropsForDetail(e);
      return props;
    } else {
      return of([]);
    }
  }));

  // Separate regular properties from M:M properties
  public regularProps$: Observable<SchemaEntityProperty[]> = this.properties$.pipe(
    map(props => props.filter(p => p.type !== EntityPropertyType.ManyToMany))
  );

  public manyToManyProps$: Observable<SchemaEntityProperty[]> = this.properties$.pipe(
    map(props => props.filter(p => p.type === EntityPropertyType.ManyToMany))
  );

  /**
   * Combined renderables (properties + static text) for unified display.
   * Static text blocks are interspersed with properties based on sort_order.
   * @since v0.17.0
   */
  public detailRenderables$: Observable<RenderableItem[]> = this.entity$.pipe(
    mergeMap(e => e ? this.schema.getDetailRenderables(e) : of([]))
  );

  // Expose type guards to template
  protected readonly isStaticText = isStaticText;
  protected readonly isProperty = isProperty;

  public data$: Observable<any> = combineLatest([this.properties$, this.refreshTrigger$.pipe(startWith(null))]).pipe(
    // Batch synchronous emissions during initialization
    debounceTime(0),
    tap(([props, trigger]) => {
      console.log('[DetailPage] data$ pipeline triggered', { propsCount: props?.length, triggerValue: trigger, dataLoading: this.dataLoading() });
      this.dataLoading.set(true);
    }),
    mergeMap(([props, _]) => {
    if(props && props.length > 0 && this.entityKey) {
      let columns = props
        .map(x => SchemaService.propertyToSelectString(x));
      return this.data.getData({key: this.entityKey, fields: columns, entityId: this.entityId})
        .pipe(
          tap((results) => {
            console.log('[DetailPage] getData returned', { resultsCount: results?.length, entityKey: this.entityKey });
          }),
          map(results => {
          const data = results[0];

          // Transform M:M junction data to flat arrays of related entities
          props.forEach(p => {
            if (p.type === EntityPropertyType.ManyToMany && p.many_to_many_meta) {
              const dataAny = data as any;
              const junctionData = dataAny[p.column_name] || [];
              dataAny[p.column_name] = DataService.transformManyToManyData(
                junctionData,
                p.many_to_many_meta.relatedTable
              );
            }
          });

          return data;
        }),
          catchError(err => {
            console.error('[DetailPage] getData failed', err);
            return of(undefined);
          }),
          finalize(() => {
            this.dataLoading.set(false);
          })
        );
    } else {
      this.dataLoading.set(false);
      return of(undefined);
    }
  }));

  // Check if payment can be initiated (metadata-driven via payment_initiation_rpc)
  public canInitiatePayment$: Observable<boolean> = combineLatest([
    this.properties$,
    this.data$,
    this.entity$
  ]).pipe(
    map(([props, data, entity]) => {
      console.log('[Payment Debug] Checking payment eligibility:', {
        entityTable: entity?.table_name,
        hasData: !!data,
        propsCount: props?.length
      });

      // Must have Payment property type
      const hasPaymentProp = props.some(p => p.type === EntityPropertyType.Payment);
      console.log('[Payment Debug] Has payment property:', hasPaymentProp);

      if (!hasPaymentProp || !data || !entity) {
        console.log('[Payment Debug] Early return: missing requirements');
        return false;
      }

      // Find payment property
      const paymentProp = props.find(p => p.type === EntityPropertyType.Payment);
      console.log('[Payment Debug] Payment property:', paymentProp);

      if (!paymentProp) {
        console.log('[Payment Debug] No payment property found');
        return false;
      }

      // Check payment status
      const paymentValue = data[paymentProp.column_name];
      console.log('[Payment Debug] Payment value:', paymentValue);

      // If payment exists, check if it's completed
      if (isPaymentValue(paymentValue)) {
        console.log('[Payment Debug] Payment status:', paymentValue.status);

        // Hide button if payment succeeded (completed)
        // Show button if payment is pending/pending_intent/failed (allow retry)
        if (paymentValue.status === 'succeeded') {
          console.log('[Payment Debug] Payment already succeeded');
          return false;
        }
        // For pending/pending_intent/failed/canceled, allow retry
        console.log('[Payment Debug] Payment incomplete, allow retry');
      }

      // Check if entity has payment_initiation_rpc configured in metadata
      const canPay = hasPaymentProp &&
        entity.payment_initiation_rpc != null &&
        entity.payment_initiation_rpc !== '';
      console.log('[Payment Debug] Can initiate payment:', canPay, 'for table:', entity.table_name, 'RPC:', entity.payment_initiation_rpc);
      return canPay;
    })
  );

  // Payment button text (changes based on whether payment exists)
  public paymentButtonText$: Observable<string> = combineLatest([
    this.properties$,
    this.data$
  ]).pipe(
    map(([props, data]) => {
      const paymentProp = props.find(p => p.type === EntityPropertyType.Payment);
      const existingPayment = data?.[paymentProp?.column_name || ''];

      // If payment exists but isn't completed, show "Complete Payment"
      if (isPaymentValue(existingPayment) && existingPayment.status !== 'succeeded') {
        return 'Complete Payment';
      }

      return 'Pay Now';
    })
  );

  // =========================================================================
  // ENTITY ACTIONS (v0.18.0)
  // =========================================================================

  /**
   * Fetch entity actions for the current entity.
   * Actions are filtered by permission (can_execute) on the server side.
   */
  public actions$: Observable<EntityAction[]> = this.entity$.pipe(
    switchMap(entity => entity ? this.schema.getEntityActions(entity.table_name) : of([]))
  );

  /**
   * Filter actions by permission and visibility condition.
   *
   * Actions are hidden (not just disabled) when:
   * 1. can_execute is false (user lacks RPC permission based on roles)
   * 2. visibility_condition evaluates to false against record data
   *
   * This provides clean UX - users only see actions they can actually perform.
   *
   * Note: visibility_condition currently only supports entity field checks.
   * TODO: Future enhancement - support user context in conditions for scenarios like:
   *   - Role-based visibility: {"field": "$user.role", "operator": "in", "value": ["admin"]}
   *   - Ownership checks: {"field": "$user.id", "operator": "eq", "value": "$record.requested_by"}
   *   See: docs/ROADMAP.md (Entity Action Buttons section)
   */
  public visibleActions$: Observable<EntityAction[]> = combineLatest([
    this.actions$,
    this.data$
  ]).pipe(
    map(([actions, data]) => {
      if (!data) return [];
      return actions.filter(action =>
        action.can_execute &&
        evaluateCondition(action.visibility_condition, data)
      );
    })
  );

  /**
   * Combined action buttons for the action bar.
   * Includes: Edit, Delete, Payment, and Entity Actions.
   * All buttons flow through ActionBarComponent for responsive overflow handling.
   */
  public actionButtons$: Observable<ActionButton[]> = combineLatest([
    this.entity$,
    this.data$,
    this.visibleActions$,
    this.canInitiatePayment$,
    this.paymentButtonText$
  ]).pipe(
    map(([entity, data, actions, canPay, paymentText]) => {
      const buttons: ActionButton[] = [];

      if (!entity || !data) return buttons;

      // Edit button
      if (entity.update) {
        buttons.push({
          id: 'edit',
          label: 'Edit',
          icon: 'edit',
          style: 'btn-accent',
          disabled: false
        });
      }

      // Delete button
      if (entity.delete) {
        buttons.push({
          id: 'delete',
          label: 'Delete',
          icon: 'delete',
          style: 'btn-error',
          disabled: false
        });
      }

      // Payment button
      if (canPay) {
        buttons.push({
          id: 'payment',
          label: paymentText,
          icon: 'payment',
          style: 'btn-primary',
          disabled: this.paymentLoading()
        });
      }

      // Entity actions (sorted by sort_order from metadata)
      actions.forEach(action => {
        const isEnabled = evaluateCondition(action.enabled_condition, data);
        buttons.push({
          id: `action:${action.action_name}`,
          label: action.display_name,
          icon: action.icon,
          style: `btn-${action.button_style}`,
          disabled: !isEnabled,
          tooltip: !isEnabled ? action.disabled_tooltip : action.description
        });
      });

      return buttons;
    })
  );

  // Fetch inverse relationships (entities that reference this entity)
  public inverseRelationships$: Observable<InverseRelationshipData[]> =
    combineLatest([
      this.entity$,
      this.data$
    ]).pipe(
      // Batch synchronous emissions during initialization
      debounceTime(0),
      // Skip emissions when entity or data ID haven't changed
      distinctUntilChanged((prev, curr) => {
        return prev[0]?.table_name === curr[0]?.table_name &&
               prev[1]?.id === curr[1]?.id;
      }),
      mergeMap(([entity, data]) => {
        if (!entity || !data) return of([]);

        // Get inverse relationship metadata
        return this.schema.getInverseRelationships(entity.table_name).pipe(
          mergeMap(relationships => {
            // Fetch data for each relationship in parallel
            const dataObservables = relationships.map(meta =>
              this.data.getInverseRelationshipData(meta, data.id)
            );

            return dataObservables.length > 0
              ? combineLatest(dataObservables)
              : of([]);
          })
        );
      }),
      // Filter out relationships with zero count
      map(relationships => relationships.filter(r => r.totalCount > 0)),
      // Sort by entity sort_order
      mergeMap(relationships =>
        this.schema.getEntities().pipe(
          map(entities => {
            return relationships.sort((a, b) => {
              const entityA = entities.find(e => e.table_name === a.meta.sourceTable);
              const entityB = entities.find(e => e.table_name === b.meta.sourceTable);
              return (entityA?.sort_order || 0) - (entityB?.sort_order || 0);
            });
          })
        )
      )
    );

  // Calendar sections for entities with time_slot properties
  public calendarSections$: Observable<CalendarSection[]> =
    combineLatest([
      this.entity$,
      this.data$,
      this.schema.getEntities()
    ]).pipe(
      debounceTime(0),
      distinctUntilChanged((prev, curr) => {
        return prev[0]?.table_name === curr[0]?.table_name &&
               prev[1]?.id === curr[1]?.id;
      }),
      mergeMap(([entity, data, allEntities]) => {
        if (!entity || !data) return of([]);

        // Get inverse relationship metadata
        return this.schema.getInverseRelationships(entity.table_name).pipe(
          mergeMap(relationships => {
            // Filter to only relationships where source entity has calendar enabled
            const calendarRelationships = relationships
              .map(rel => {
                const sourceEntity = allEntities.find(e => e.table_name === rel.sourceTable);
                return { rel, sourceEntity };
              })
              .filter(({ sourceEntity }) =>
                sourceEntity?.show_calendar && sourceEntity?.calendar_property_name
              );

            if (calendarRelationships.length === 0) {
              return of([]);
            }

            // Fetch calendar data for each relationship
            const calendarDataObservables = calendarRelationships.map(({ rel, sourceEntity }) =>
              this.data.getData({
                key: rel.sourceTable,
                fields: ['id', 'display_name', sourceEntity!.calendar_property_name!, sourceEntity!.calendar_color_property || ''].filter(f => f),
                filters: [{
                  column: rel.sourceColumn,
                  operator: 'eq',
                  value: data.id
                }],
                orderField: sourceEntity!.calendar_property_name!,
                orderDirection: 'asc'
              }).pipe(
                map(records => ({
                  meta: {
                    sourceTable: rel.sourceTable,
                    sourceEntityDisplayName: sourceEntity!.display_name,
                    sourceColumn: rel.sourceColumn,
                    calendarPropertyName: sourceEntity!.calendar_property_name!,
                    calendarColorProperty: sourceEntity!.calendar_color_property
                  },
                  events: records.map((record: any) => {
                    const { start, end } = this.parseTimeSlot(record[sourceEntity!.calendar_property_name!]);
                    return {
                      id: record.id,
                      title: record.display_name || `${sourceEntity!.display_name} #${record.id}`,
                      start: start,
                      end: end,
                      color: sourceEntity!.calendar_color_property ? record[sourceEntity!.calendar_color_property] : '#3B82F6',
                      extendedProps: { data: record }
                    } as CalendarEvent;
                  })
                } as CalendarSection))
              )
            );

            return calendarDataObservables.length > 0
              ? combineLatest(calendarDataObservables)
              : of([]);
          })
        );
      }),
      // Filter out sections with no events
      map(sections => sections.filter(s => s.events.length > 0))
    );

  // Threshold for showing preview vs "View all" only
  readonly LARGE_RELATIONSHIP_THRESHOLD = 20;

  // Refresh data after M:M changes
  refreshData() {
    console.log('[DetailPage] refreshData() called - emitting refreshTrigger');
    this.refreshTrigger$.next();
  }

  // Delete modal methods
  openDeleteModal() {
    this.deleteError.set(undefined);
    this.showDeleteModal.set(true);
  }

  closeDeleteModal() {
    this.showDeleteModal.set(false);
  }

  confirmDelete() {
    if (!this.entityKey || !this.entityId) return;

    this.deleteError.set(undefined);
    this.deleteLoading.set(true);

    this.data.deleteData(this.entityKey, this.entityId).subscribe({
      next: (response) => {
        this.deleteLoading.set(false);
        if (response.success) {
          // Navigate back to list view on success
          this.router.navigate(['/view', this.entityKey]);
        } else {
          this.deleteError.set(response.error?.humanMessage || 'Failed to delete record');
        }
      },
      error: (err) => {
        this.deleteLoading.set(false);
        this.deleteError.set('Failed to delete record. Please try again.');
      }
    });
  }

  /**
   * Initiate payment for entities with Payment property type.
   * Uses metadata-driven configuration (payment_initiation_rpc) to call domain-specific RPC.
   *
   * Pattern for adding payments to entities:
   * 1. Add payment_transaction_id column (UUID FK to payment_transactions)
   * 2. Create initiate_{entity}_payment(p_entity_id) RPC with domain logic
   * 3. Configure metadata: payment_initiation_rpc = 'initiate_{entity}_payment'
   * 4. Framework calls configured RPC when "Pay Now" clicked
   */
  initiatePayment() {
    if (!this.entityKey || !this.entityId) return;

    this.paymentError.set(undefined);
    this.paymentLoading.set(true);

    // Check if payment already exists (from embedded data) and get entity metadata
    combineLatest([this.properties$, this.data$, this.entity$]).pipe(
      take(1)
    ).subscribe(([props, data, entity]: [SchemaEntityProperty[], EntityData | undefined, SchemaEntityTable | undefined]) => {
      // Validate entity has payment_initiation_rpc configured
      if (!entity?.payment_initiation_rpc) {
        console.error('[Payment] Payment initiation RPC not configured for entity:', this.entityKey);
        this.paymentError.set('Payment not configured for this entity');
        this.paymentLoading.set(false);
        return;
      }
      const paymentProp = props.find((p: SchemaEntityProperty) => p.type === EntityPropertyType.Payment);
      const existingPayment = data?.[paymentProp?.column_name || ''];

      // IMPORTANT: Distinguish between "reuse" and "retry" based on payment status
      // - Reuse (pending_intent/pending): Skip RPC, open modal with existing PaymentIntent
      // - Retry (failed/canceled): Call RPC to create NEW PaymentIntent (old one can't be reused)
      if (isPaymentValue(existingPayment)) {
        console.log('[Payment] Found existing payment:', existingPayment.id, 'status:', existingPayment.status);

        // For pending_intent/pending: Reuse existing PaymentIntent
        if (existingPayment.status === 'pending_intent' || existingPayment.status === 'pending') {
          console.log('[Payment] Reusing existing payment (same PaymentIntent)');
          this.paymentLoading.set(false);
          this.currentPaymentId.set(existingPayment.id);
          this.showCheckoutModal.set(true);
          return;
        }

        // For failed/canceled: Call RPC to create NEW PaymentIntent (worker will generate fresh intent)
        console.log('[Payment] Retrying failed/canceled payment (will create new PaymentIntent)');
        // Fall through to RPC call below
      }

      // No existing payment OR payment is failed/canceled - call RPC
      console.log('[Payment] Calling RPC to initiate payment:', entity.payment_initiation_rpc);
      this.data.callRpc(entity.payment_initiation_rpc, {
        p_entity_id: this.entityId
      }).subscribe({
      next: (response: any) => {
        this.paymentLoading.set(false);

        console.log('[Payment RPC] Raw response:', response);
        console.log('[Payment RPC] Response type:', typeof response);
        console.log('[Payment RPC] Is array?:', Array.isArray(response));

        // PostgREST returns scalar values as strings directly, not wrapped in arrays
        // But for functions returning SETOF or TABLE, it returns an array
        const paymentId = typeof response === 'string' ? response : response[0];
        console.log('Payment initiated:', paymentId);

        if (paymentId) {
          // Open PaymentCheckoutComponent modal
          this.currentPaymentId.set(paymentId);
          this.showCheckoutModal.set(true);
        } else {
          this.paymentError.set('Failed to initiate payment');
        }
      },
        error: (err: any) => {
          this.paymentLoading.set(false);
          const errorMessage = err.error?.message || 'Failed to initiate payment. Please try again.';
          this.paymentError.set(errorMessage);
        }
      });
    });
  }

  /**
   * Handle successful payment (or any status change)
   */
  handlePaymentSuccess(paymentId: string) {
    console.log('[DetailPage] handlePaymentSuccess called', {
      paymentId,
      showCheckoutModal: this.showCheckoutModal(),
      currentPaymentId: this.currentPaymentId()
    });
    this.showCheckoutModal.set(false);
    this.currentPaymentId.set(undefined);

    // Refresh data to show updated payment status
    // (PaymentCheckoutComponent already waits 500ms before emitting to ensure DB consistency)
    console.log('[DetailPage] Calling refreshData() from handlePaymentSuccess');
    this.refreshData();
    console.log('[DetailPage] refreshData() called, refreshTrigger emitted');
  }

  /**
   * Handle checkout modal close (user clicked X button)
   * Refresh data to show any payment status changes that occurred before close
   */
  handleCheckoutClose() {
    console.log('[DetailPage] handleCheckoutClose called', {
      showCheckoutModal: this.showCheckoutModal(),
      currentPaymentId: this.currentPaymentId()
    });
    this.showCheckoutModal.set(false);
    this.currentPaymentId.set(undefined);

    // Refresh data in case payment status changed before user closed modal
    console.log('[DetailPage] Calling refreshData() from handleCheckoutClose');
    this.refreshData();
    console.log('[DetailPage] refreshData() called, refreshTrigger emitted');
  }

  /**
   * Navigate to Create page for a related entity with pre-filled query params.
   *
   * Use Cases:
   * - "Add Appointment" from Resource detail page → pre-fills resource_id
   * - Calendar date selection → pre-fills time_slot + resource_id
   * - "Add Issue for User" → pre-fills assigned_user_id
   *
   * @param tableName - Target entity to create (e.g., 'appointments', 'issues')
   * @param fkColumn - Foreign key column name to pre-fill (e.g., 'resource_id', 'user_id')
   * @param additionalParams - Optional extra query params (e.g., { time_slot: '[start,end)', status: 'pending' })
   *
   * Example template usage:
   * <button (click)="navigateToCreateRelated('appointments', 'resource_id')">
   *   Add Appointment
   * </button>
   *
   * Example with additional params:
   * <button (click)="navigateToCreateRelated('appointments', 'resource_id', { status: 'pending' })">
   *   Add Pending Appointment
   * </button>
   */
  navigateToCreateRelated(tableName: string, fkColumn: string, additionalParams?: Record<string, any>) {
    this.router.navigate(['/create', tableName], {
      queryParams: {
        [fkColumn]: this.entityId,
        ...additionalParams
      }
    });
  }

  /**
   * Navigate to detail page when calendar event is clicked
   */
  onCalendarEventClick(event: CalendarEvent, section: CalendarSection) {
    this.router.navigate(['/view', section.meta.sourceTable, event.id]);
  }

  /**
   * Handle date selection in calendar - navigate to Create with pre-filled time slot
   */
  onCalendarDateSelect(selection: { start: Date; end: Date }, section: CalendarSection) {
    const tstzrange = `[${selection.start.toISOString()},${selection.end.toISOString()})`;
    this.navigateToCreateRelated(section.meta.sourceTable, section.meta.sourceColumn, {
      [section.meta.calendarPropertyName]: tstzrange
    });
  }

  /**
   * Parse tstzrange string to Date objects
   */
  private parseTimeSlot(tstzrange: string): { start: Date; end: Date } {
    const match = tstzrange.match(/\[(.+?),(.+?)\)/);
    if (!match) {
      // Return empty dates if parsing fails
      return { start: new Date(), end: new Date() };
    }
    return {
      start: new Date(match[1]),
      end: new Date(match[2])
    };
  }

  // =========================================================================
  // ENTITY ACTION METHODS (v0.18.0)
  // =========================================================================

  /**
   * Handle clicks from the action bar.
   * Routes to appropriate handler based on button ID.
   */
  onActionButtonClick(buttonId: string): void {
    if (buttonId === 'edit') {
      this.data$.pipe(take(1)).subscribe(data => {
        if (data) {
          this.router.navigate(['/edit', this.entityKey, data.id]);
        }
      });
    } else if (buttonId === 'delete') {
      this.openDeleteModal();
    } else if (buttonId === 'payment') {
      this.initiatePayment();
    } else if (buttonId.startsWith('action:')) {
      const actionName = buttonId.substring(7);
      this.visibleActions$.pipe(take(1)).subscribe(actions => {
        const action = actions.find(a => a.action_name === actionName);
        if (action) {
          this.onEntityActionClick(action);
        }
      });
    }
  }

  /**
   * Handle entity action button click.
   * Shows confirmation modal if required, otherwise executes immediately with overlay.
   */
  onEntityActionClick(action: EntityAction): void {
    this.currentAction.set(action);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);

    if (action.requires_confirmation) {
      this.showActionModal.set(true);
    } else {
      // Show loading overlay and execute immediately
      this.actionOverlayLoading.set(true);
      this.executeEntityAction(action);
    }
  }

  /**
   * Confirm action from modal.
   */
  confirmEntityAction(): void {
    const action = this.currentAction();
    if (!action) return;

    this.actionLoading.set(true);
    this.executeEntityAction(action);
  }

  /**
   * Close action modal and reset state.
   */
  closeActionModal(): void {
    this.showActionModal.set(false);
    this.currentAction.set(undefined);
    this.actionError.set(undefined);
    this.actionSuccess.set(undefined);
  }

  /**
   * Execute the entity action RPC.
   * Handles response processing, success messages, navigation, and data refresh.
   */
  private executeEntityAction(action: EntityAction): void {
    this.data.executeRpc(action.rpc_function, { p_entity_id: this.entityId }).subscribe({
      next: (response) => {
        this.actionLoading.set(false);
        this.actionOverlayLoading.set(false);

        if (response.success) {
          const result = response.body as EntityActionResult | undefined;

          // Determine message, navigation, and refresh behavior
          // RPC response can override metadata defaults
          const message = result?.message || action.default_success_message || 'Action completed';
          const navigateTo = result?.navigate_to || action.default_navigate_to;
          const shouldRefresh = result?.refresh ?? action.refresh_after_action;

          this.actionSuccess.set(message);

          // Auto-close modal and handle navigation/refresh after brief delay
          setTimeout(() => {
            this.closeActionModal();

            if (navigateTo) {
              this.router.navigate([navigateTo]);
            } else if (shouldRefresh) {
              this.refreshData();
            }
          }, 1500);
        } else {
          // RPC returned an error
          this.actionError.set(response.error?.humanMessage || 'Action failed');
        }
      },
      error: () => {
        this.actionLoading.set(false);
        this.actionOverlayLoading.set(false);
        this.actionError.set('An unexpected error occurred');
      }
    });
  }
}
