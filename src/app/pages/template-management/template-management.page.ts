import { Component, ChangeDetectionStrategy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NotificationService, NotificationTemplate } from '../../services/notification.service';
import { TemplateEditorComponent } from '../../components/template-editor/template-editor.component';

@Component({
  selector: 'app-template-management',
  standalone: true,
  imports: [CommonModule, TemplateEditorComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './template-management.page.html',
  styleUrl: './template-management.page.css'
})
export class TemplateManagementPage {
  // State signals
  templates = signal<NotificationTemplate[]>([]);
  loading = signal(true);
  error = signal<string | undefined>(undefined);
  isAdmin = signal(false);

  // Modal state
  showCreateModal = signal(false);
  editingTemplate = signal<NotificationTemplate | null>(null);
  deletingTemplate = signal<NotificationTemplate | null>(null);

  // Computed
  hasTemplates = computed(() => this.templates().length > 0);

  constructor(private notificationService: NotificationService) {
    this.loadData();
  }

  /**
   * Load templates and check admin status
   */
  private loadData(): void {
    this.loading.set(true);
    this.error.set(undefined);

    // Check admin status
    this.notificationService.isAdmin().subscribe({
      next: (isAdmin) => {
        this.isAdmin.set(isAdmin);

        if (!isAdmin) {
          this.loading.set(false);
          this.error.set('You must be an admin to manage notification templates.');
          return;
        }

        // Load templates
        this.notificationService.getTemplates().subscribe({
          next: (templates) => {
            this.templates.set(templates);
            this.loading.set(false);
          },
          error: (err) => {
            console.error('Error loading templates:', err);
            this.error.set('Failed to load templates. Please try again.');
            this.loading.set(false);
          }
        });
      },
      error: (err) => {
        console.error('Error checking admin status:', err);
        this.error.set('Failed to verify permissions. Please try again.');
        this.loading.set(false);
      }
    });
  }

  /**
   * Open create modal
   */
  openCreateModal(): void {
    this.showCreateModal.set(true);
  }

  /**
   * Open edit modal
   */
  openEditModal(template: NotificationTemplate): void {
    this.editingTemplate.set(template);
  }

  /**
   * Close all modals
   */
  closeModals(): void {
    this.showCreateModal.set(false);
    this.editingTemplate.set(null);
    this.deletingTemplate.set(null);
  }

  /**
   * Handle template saved (create or update)
   */
  handleTemplateSaved(template: NotificationTemplate): void {
    this.closeModals();
    this.loadData(); // Reload templates
  }

  /**
   * Open delete confirmation modal
   */
  confirmDelete(template: NotificationTemplate): void {
    this.deletingTemplate.set(template);
  }

  /**
   * Delete template
   */
  deleteTemplate(): void {
    const template = this.deletingTemplate();
    if (!template) return;

    this.notificationService.deleteTemplate(template.id).subscribe({
      next: (response) => {
        if (response.success) {
          this.closeModals();
          this.loadData(); // Reload templates
        } else {
          this.error.set(response.error?.humanMessage || 'Failed to delete template.');
        }
      },
      error: (err) => {
        console.error('Error deleting template:', err);
        this.error.set('Failed to delete template. Please try again.');
      }
    });
  }

  /**
   * Format date for display
   */
  formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
}
