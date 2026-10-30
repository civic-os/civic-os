/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Record facades: the page orchestration of design §11, without layout. A
 * facade joins the package barrel in the commit that gives it an app call
 * site (the dogfood check).
 */

export type { FacadeDeps, FacadeSchema } from './deps.js';
export { recordList } from './record-list.js';
export type {
  ListCalendar,
  ListCalendarEvent,
  ListFilterChip,
  ListMapFeature,
  ListSort,
  ListState,
  ListStateInput,
  ListViews,
  RecordList,
  RecordListOptions,
  RecordListSnapshot,
} from './record-list.js';
export { recordViewer } from './record-viewer.js';
export type {
  ActionParamSession,
  ActionParamsSnapshot,
  RecordViewer,
  RecordViewerOptions,
  RecordViewerSnapshot,
  ViewerAction,
  ViewerActionHandle,
  ViewerActionResult,
  ViewerDeleteResult,
  ViewerDeps,
  ViewerFailure,
  ViewerGuidedForm,
  ViewerGuidedFormResult,
  ViewerParamOption,
  ViewerPayment,
  ViewerPaymentResult,
  ViewerSchema,
} from './record-viewer.js';
export { recordEditor } from './record-editor.js';
export type {
  EditorContinueResult,
  EditorCreateResult,
  EditorDeps,
  EditorNavigation,
  EditorSchema,
  EditorStep,
  EditorStepReason,
  EditorStepResult,
  ManyToManyDiff,
  RecordEditor,
  RecordEditorCreateOptions,
  RecordEditorOptions,
  RecordEditorSnapshot,
  RichManyToManyDiff,
} from './record-editor.js';
