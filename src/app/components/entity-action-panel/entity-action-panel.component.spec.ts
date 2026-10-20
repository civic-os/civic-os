/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { NavigationStart, provideRouter, Router } from '@angular/router';
import { Subject, of } from 'rxjs';
import { advanceTime, useFakeTimeInEachTest } from '../../testing/fake-time';
import { EntityActionPanelComponent } from './entity-action-panel.component';
import { SchemaService } from '../../services/schema.service';
import { DataService } from '../../services/data.service';
import { FileUploadService } from '../../services/file-upload.service';
import { GalleryService } from '../../services/gallery.service';
import { EntityAction, EntityActionParam } from '../../interfaces/entity';

describe('EntityActionPanelComponent', () => {
    let component: EntityActionPanelComponent;
    let fixture: ComponentFixture<EntityActionPanelComponent>;
    let mockSchemaService: any;
    let mockDataService: any;
    let mockFileUploadService: any;
    let mockGalleryService: any;

    const mockAction: EntityAction = {
        id: 1,
        table_name: 'civic_os_users',
        action_name: 'test_action',
        display_name: 'Test Action',
        rpc_function: 'test_user_action',
        icon: 'science',
        button_style: 'primary',
        sort_order: 1,
        requires_confirmation: true,
        confirmation_message: 'Run the test action?',
        refresh_after_action: true,
        show_on_detail: true,
        can_execute: true,
        parameters: []
    };

    const mockActionNoConfirm: EntityAction = {
        ...mockAction,
        id: 2,
        action_name: 'quick_action',
        display_name: 'Quick Action',
        rpc_function: 'quick_action_rpc',
        requires_confirmation: false
    };

    const mockActionWithVisibility: EntityAction = {
        ...mockAction,
        id: 3,
        action_name: 'conditional_action',
        display_name: 'Conditional Action',
        visibility_condition: { field: 'status', operator: 'eq', value: 'active' }
    };

    const mockActionWithEnabled: EntityAction = {
        ...mockAction,
        id: 4,
        action_name: 'enabled_action',
        display_name: 'Enabled Action',
        enabled_condition: { field: 'amount', operator: 'gt', value: 0 },
        disabled_tooltip: 'Amount must be greater than 0'
    };

    const mockEntityData: Record<string, any> = {
        id: 'user-123',
        display_name: 'Test User',
        status: 'active',
        amount: 100
    };

    beforeEach(async () => {
        mockSchemaService = {
            getEntityActions: vi.fn().mockName("SchemaService.getEntityActions")
        };
        mockDataService = {
            executeRpc: vi.fn().mockName("DataService.executeRpc"),
            callRpc: vi.fn().mockName("DataService.callRpc"),
            getData: vi.fn().mockName("DataService.getData")
        };
        mockFileUploadService = {
            uploadFile: vi.fn().mockName("FileUploadService.uploadFile"),
            validateFile: vi.fn().mockName("FileUploadService.validateFile")
        };
        mockGalleryService = {
            getConfig: vi.fn().mockName("GalleryService.getConfig")
        };

        mockSchemaService.getEntityActions.mockReturnValue(of([]));

        await TestBed.configureTestingModule({
            imports: [EntityActionPanelComponent],
            providers: [
                provideZonelessChangeDetection(),
                provideHttpClient(withXhr()),
                provideHttpClientTesting(),
                provideRouter([]),
                { provide: SchemaService, useValue: mockSchemaService },
                { provide: DataService, useValue: mockDataService },
                { provide: FileUploadService, useValue: mockFileUploadService },
                { provide: GalleryService, useValue: mockGalleryService }
            ]
        }).compileComponents();
    });

    function createComponent(actions: EntityAction[] = [], data: Record<string, any> = mockEntityData): void {
        mockSchemaService.getEntityActions.mockReturnValue(of(actions));
        fixture = TestBed.createComponent(EntityActionPanelComponent);
        component = fixture.componentInstance;
        fixture.componentRef.setInput('tableName', 'civic_os_users');
        fixture.componentRef.setInput('entityId', 'user-123');
        fixture.componentRef.setInput('entityData', data);
    }

    describe('Component Creation', () => {
        it('should create', async () => {
            createComponent();
            await fixture.whenStable();
            expect(component).toBeTruthy();
        });

        it('should fetch actions for the given tableName', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();
            expect(mockSchemaService.getEntityActions).toHaveBeenCalledWith('civic_os_users');
        });
    });

    describe('Action Button Assembly', () => {
        it('should show no buttons when no actions exist', async () => {
            createComponent([]);
            await fixture.whenStable();
            expect(component.actionButtons().length).toBe(0);
        });

        it('should create buttons for visible actions', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();
            expect(component.actionButtons().length).toBe(1);
            expect(component.actionButtons()[0].id).toBe('action:test_action');
            expect(component.actionButtons()[0].label).toBe('Test Action');
            expect(component.actionButtons()[0].style).toBe('btn-primary');
        });

        it('should filter out actions where can_execute is false', async () => {
            const noExecAction = { ...mockAction, can_execute: false };
            createComponent([noExecAction]);
            await fixture.whenStable();
            expect(component.actionButtons().length).toBe(0);
        });

        it('should filter out actions failing visibility_condition', async () => {
            createComponent([mockActionWithVisibility], { ...mockEntityData, status: 'inactive' });
            await fixture.whenStable();
            expect(component.actionButtons().length).toBe(0);
        });

        it('should show action when visibility_condition passes', async () => {
            createComponent([mockActionWithVisibility], { ...mockEntityData, status: 'active' });
            await fixture.whenStable();
            expect(component.actionButtons().length).toBe(1);
        });

        it('should disable button when enabled_condition fails', async () => {
            createComponent([mockActionWithEnabled], { ...mockEntityData, amount: 0 });
            await fixture.whenStable();
            expect(component.actionButtons()[0].disabled).toBe(true);
            expect(component.actionButtons()[0].tooltip).toBe('Amount must be greater than 0');
        });

        it('should enable button when enabled_condition passes', async () => {
            createComponent([mockActionWithEnabled], { ...mockEntityData, amount: 100 });
            await fixture.whenStable();
            expect(component.actionButtons()[0].disabled).toBe(false);
        });
    });

    describe('Confirmation Action Flow', () => {
        it('should open modal for confirmation actions', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');
            expect(component.showActionModal()).toBe(true);
            expect(component.currentAction()?.action_name).toBe('test_action');
        });

        it('should close modal and reset state', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');
            expect(component.showActionModal()).toBe(true);

            component.closeActionModal();
            expect(component.showActionModal()).toBe(false);
            expect(component.currentAction()).toBeUndefined();
            expect(component.actionError()).toBeUndefined();
            expect(component.actionSuccess()).toBeUndefined();
        });

        it('should execute RPC on confirm and emit actionExecuted', async () => {
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Done!' }
            }));

            createComponent([mockAction]);
            await fixture.whenStable();

            vi.spyOn(component.actionExecuted, 'emit').mockReturnValue(undefined);

            component.onActionButtonClick('action:test_action');
            await component.confirmEntityAction();

            expect(mockDataService.executeRpc).toHaveBeenCalledWith('test_user_action', {
                p_entity_id: 'user-123'
            });
            expect(component.actionSuccess()).toBe('Done!');
        });

        it('should show error on RPC failure', async () => {
            mockDataService.executeRpc.mockReturnValue(of({
                success: false,
                error: { httpCode: 400, message: 'Failed', humanMessage: 'Something went wrong' }
            }));

            createComponent([mockAction]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');
            await component.confirmEntityAction();

            expect(component.actionError()).toBe('Something went wrong');
        });
    });

    describe('Non-Confirmation Action Flow', () => {
        it('should show overlay and execute immediately for non-confirmation actions', async () => {
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Quick done!' }
            }));

            createComponent([mockActionNoConfirm]);
            await fixture.whenStable();

            component.onActionButtonClick('action:quick_action');
            expect(component.showActionModal()).toBe(false);
            // After RPC completes, overlay should clear
            expect(component.actionOverlayLoading()).toBe(false);
        });
    });

    describe('Parameter Form', () => {
        const actionWithParams: EntityAction = {
            ...mockAction,
            parameters: [
                {
                    id: 1,
                    param_name: 'p_reason',
                    display_name: 'Reason',
                    param_type: 'text',
                    required: true,
                    sort_order: 1
                },
                {
                    id: 2,
                    param_name: 'p_amount',
                    display_name: 'Amount',
                    param_type: 'number',
                    required: false,
                    sort_order: 2
                }
            ]
        };

        it('should build param form with validators', async () => {
            createComponent([actionWithParams]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');

            const form = component.actionParamForm();
            expect(form).toBeTruthy();
            expect(form!.get('p_reason')).toBeTruthy();
            expect(form!.get('p_amount')).toBeTruthy();

            // Required validator on p_reason
            form!.get('p_reason')!.setValue(null);
            expect(form!.get('p_reason')!.hasError('required')).toBe(true);
        });

        it('should not confirm when form is invalid', async () => {
            createComponent([actionWithParams]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');
            // Leave required field empty
            await component.confirmEntityAction();

            expect(mockDataService.executeRpc).not.toHaveBeenCalled();
        });

        it('should pass param values to RPC', async () => {
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Done' }
            }));

            createComponent([actionWithParams]);
            await fixture.whenStable();

            component.onActionButtonClick('action:test_action');
            const form = component.actionParamForm()!;
            form.get('p_reason')!.setValue('Test reason');
            form.get('p_amount')!.setValue('42');

            await component.confirmEntityAction();

            expect(mockDataService.executeRpc).toHaveBeenCalledWith('test_user_action', {
                p_entity_id: 'user-123',
                p_reason: 'Test reason',
                p_amount: 42 // converted to number
            });
        });
    });

    describe('Button ID Filtering', () => {
        it('should ignore non-action button IDs', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();

            component.onActionButtonClick('edit');
            expect(component.showActionModal()).toBe(false);

            component.onActionButtonClick('delete');
            expect(component.showActionModal()).toBe(false);
        });
    });

    describe('Utility Methods', () => {
        it('should return correct file accept for param types', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();
            expect(component.getFileAcceptForParam({ file_type: 'image' } as any)).toBe('image/*');
            expect(component.getFileAcceptForParam({ file_type: 'pdf' } as any)).toBe('application/pdf');
            expect(component.getFileAcceptForParam({ file_type: 'any' } as any)).toBe('*/*');
            expect(component.getFileAcceptForParam(undefined)).toBe('*/*');
        });

        it('should always return display_name for param display column', async () => {
            createComponent([mockAction]);
            await fixture.whenStable();
            expect(component.getParamDisplayColumn({} as any)).toBe('display_name');
        });
    });
    /**
     * The 1.5 s auto-close after a successful action must not outlive the panel
     * or the page the user was on (see the matching DetailPage specs).
     */
    describe('Action auto-close timer', () => {
        useFakeTimeInEachTest();

        let router: Router;
        let navigateSpy: any;
        let emitted: number;

        async function runAction(navigateTo?: string) {
            mockDataService.executeRpc.mockReturnValue(of({
                success: true,
                body: { success: true, message: 'Done!', navigate_to: navigateTo }
            }));
            createComponent([mockAction]);
            fixture.detectChanges();
            router = TestBed.inject(Router);
            navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
            emitted = 0;
            component.actionExecuted.subscribe(() => emitted++);

            component.onActionButtonClick('action:test_action');
            await component.confirmEntityAction();
            expect(component.actionSuccess()).toBe('Done!');
        }

        it('closes the modal and navigates after 1.5 s', async () => {
            await runAction('/view/civic_os_users');
            await advanceTime(1500);

            expect(component.showActionModal()).toBe(false);
            expect(navigateSpy).toHaveBeenCalledWith(['/view/civic_os_users']);
        });

        it('does not navigate after the panel is destroyed', async () => {
            await runAction('/view/civic_os_users');
            fixture.destroy();
            await advanceTime(2000);

            expect(navigateSpy).not.toHaveBeenCalled();
        });

        it('does not navigate or emit after the user navigates elsewhere', async () => {
            await runAction('/view/civic_os_users');
            (router.events as Subject<any>).next(new NavigationStart(99, '/somewhere-else'));
            expect(component.showActionModal()).toBe(false);
            await advanceTime(2000);

            expect(navigateSpy).not.toHaveBeenCalled();

            // Refresh path: no actionExecuted emit for the page the user left
            await runAction();
            (router.events as Subject<any>).next(new NavigationStart(100, '/somewhere-else'));
            await advanceTime(2000);
            expect(emitted).toBe(0);
        });
    });
    describe('Parameter labels (a11y)', () => {
        const params: EntityActionParam[] = [
            { id: 1, param_name: 'p_text', display_name: 'Field text', param_type: 'text' as any, required: true, sort_order: 1 },
            { id: 2, param_name: 'p_text_short', display_name: 'Field text_short', param_type: 'text_short' as any, required: false, sort_order: 2 },
            { id: 3, param_name: 'p_number', display_name: 'Field number', param_type: 'number' as any, required: true, sort_order: 3 },
            { id: 4, param_name: 'p_boolean', display_name: 'Field boolean', param_type: 'boolean' as any, required: false, sort_order: 4 },
            { id: 5, param_name: 'p_money', display_name: 'Field money', param_type: 'money' as any, required: true, sort_order: 5 },
            { id: 6, param_name: 'p_date', display_name: 'Field date', param_type: 'date' as any, required: false, sort_order: 6 },
            { id: 7, param_name: 'p_datetime', display_name: 'Field datetime', param_type: 'datetime' as any, required: true, sort_order: 7 },
            { id: 8, param_name: 'p_datetime_local', display_name: 'Field datetime_local', param_type: 'datetime_local' as any, required: false, sort_order: 8 },
            { id: 9, param_name: 'p_color', display_name: 'Field color', param_type: 'color' as any, required: true, sort_order: 9 },
            { id: 10, param_name: 'p_email', display_name: 'Field email', param_type: 'email' as any, required: false, sort_order: 10 },
            { id: 11, param_name: 'p_telephone', display_name: 'Field telephone', param_type: 'telephone' as any, required: true, sort_order: 11 },
            { id: 12, param_name: 'p_status', display_name: 'Field status', param_type: 'status' as any, required: false, sort_order: 12 },
            { id: 13, param_name: 'p_category', display_name: 'Field category', param_type: 'category' as any, required: true, sort_order: 13 },
            { id: 14, param_name: 'p_foreign_key', display_name: 'Field foreign_key', param_type: 'foreign_key' as any, required: false, sort_order: 14 },
            { id: 15, param_name: 'p_user', display_name: 'Field user', param_type: 'user' as any, required: true, sort_order: 15 },
            { id: 16, param_name: 'p_file', display_name: 'Field file', param_type: 'file' as any, required: false, sort_order: 16 },
            { id: 17, param_name: 'p_geo_point', display_name: 'Field geo_point', param_type: 'geo_point' as any, required: true, sort_order: 17 }
        ];

        function expectEveryParamLabelled(root: HTMLElement, params: EntityActionParam[]) {
            for (const param of params) {
                const label = Array.from(root.querySelectorAll('label'))
                    .find(l => l.textContent!.includes(param.display_name));
                expect(label, `label for ${param.param_name}`).toBeTruthy();
                const forId = label!.getAttribute('for');
                expect(forId, `for= on ${param.param_name} label`).toBeTruthy();
                const control = root.querySelector(`[id="${forId}"]`) as HTMLElement | null;
                expect(control, `control #${forId}`).toBeTruthy();
                expect(['INPUT', 'SELECT', 'TEXTAREA']).toContain(control!.tagName);
                expect(control!.getAttribute('aria-required')).toBe(param.required ? 'true' : null);
            }
        }

        it('associates a <label for> with every parameter control and marks required ones', async () => {
            createComponent([{ ...mockAction, parameters: params }]);
            fixture.detectChanges();
            component.onActionButtonClick('action:test_action');
            fixture.detectChanges();

            expectEveryParamLabelled(fixture.nativeElement, params);
        });
    });
});
