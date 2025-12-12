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

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { MarkdownModule, provideMarkdown } from 'ngx-markdown';
import { StaticTextComponent } from './static-text.component';
import { StaticText } from '../../interfaces/entity';

describe('StaticTextComponent', () => {
  let component: StaticTextComponent;
  let fixture: ComponentFixture<StaticTextComponent>;

  /**
   * Create a mock StaticText object for testing.
   */
  function createMockStaticText(overrides: Partial<StaticText> = {}): StaticText {
    return {
      itemType: 'static_text',
      id: 1,
      table_name: 'test_entity',
      content: '# Test Content\n\nThis is **bold** text.',
      sort_order: 100,
      column_width: 2,
      show_on_detail: true,
      show_on_create: false,
      show_on_edit: false,
      ...overrides
    };
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StaticTextComponent, MarkdownModule],
      providers: [
        provideZonelessChangeDetection(),
        provideMarkdown()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(StaticTextComponent);
    component = fixture.componentInstance;
  });

  describe('Basic Component Setup', () => {
    it('should create', () => {
      fixture.componentRef.setInput('staticText', createMockStaticText());
      fixture.detectChanges();

      expect(component).toBeTruthy();
    });

    it('should have staticText input', () => {
      const mockStaticText = createMockStaticText({ content: '# Custom Content' });
      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText()).toEqual(mockStaticText);
    });
  });

  describe('Content Rendering', () => {
    it('should render markdown content', () => {
      const mockStaticText = createMockStaticText({
        content: '# Hello World\n\nThis is a paragraph.'
      });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toContain('Hello World');
    });

    it('should handle multiline markdown content', () => {
      const multilineContent = `# Title

Paragraph 1

## Subtitle

- Item 1
- Item 2
- Item 3`;

      const mockStaticText = createMockStaticText({ content: multilineContent });
      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toBe(multilineContent);
    });

    it('should handle content with special characters', () => {
      const specialContent = '# Test\n\n`code` & **bold** & *italic*';
      const mockStaticText = createMockStaticText({ content: specialContent });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toBe(specialContent);
    });

    it('should handle markdown with code blocks', () => {
      const codeContent = '# Code Example\n\n```typescript\nconst x = 10;\n```';
      const mockStaticText = createMockStaticText({ content: codeContent });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toBe(codeContent);
    });
  });

  describe('Template Rendering', () => {
    it('should render with prose class for typography', () => {
      const mockStaticText = createMockStaticText({ content: '# Test' });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const container = compiled.querySelector('.prose');

      expect(container).toBeTruthy();
      expect(container?.classList.contains('max-w-none')).toBe(true);
    });

    it('should contain markdown directive', () => {
      const mockStaticText = createMockStaticText({ content: '**Bold text**' });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      const compiled = fixture.nativeElement as HTMLElement;
      const markdownElement = compiled.querySelector('markdown');

      expect(markdownElement).toBeTruthy();
    });
  });

  describe('Change Detection with OnPush', () => {
    it('should update when staticText input changes', () => {
      const staticText1 = createMockStaticText({ content: 'Content 1' });
      const staticText2 = createMockStaticText({ content: 'Content 2' });

      fixture.componentRef.setInput('staticText', staticText1);
      fixture.detectChanges();
      expect(component.staticText().content).toBe('Content 1');

      fixture.componentRef.setInput('staticText', staticText2);
      fixture.detectChanges();
      expect(component.staticText().content).toBe('Content 2');
    });
  });

  describe('StaticText Properties', () => {
    it('should preserve all StaticText properties', () => {
      const mockStaticText = createMockStaticText({
        id: 42,
        table_name: 'my_entity',
        content: '# My Content',
        sort_order: 50,
        column_width: 1,
        show_on_detail: false,
        show_on_create: true,
        show_on_edit: true
      });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      const st = component.staticText();
      expect(st.itemType).toBe('static_text');
      expect(st.id).toBe(42);
      expect(st.table_name).toBe('my_entity');
      expect(st.sort_order).toBe(50);
      expect(st.column_width).toBe(1);
      expect(st.show_on_detail).toBe(false);
      expect(st.show_on_create).toBe(true);
      expect(st.show_on_edit).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long markdown content', () => {
      const longContent = '# Heading\n\n' + 'Lorem ipsum '.repeat(1000);
      const mockStaticText = createMockStaticText({ content: longContent });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content.length).toBeGreaterThan(10000);
    });

    it('should handle markdown with horizontal rules', () => {
      const hrContent = '# Section 1\n\n---\n\n# Section 2';
      const mockStaticText = createMockStaticText({ content: hrContent });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toBe(hrContent);
    });

    it('should handle markdown with links', () => {
      const linkContent = 'Contact us at [email](mailto:test@example.com) or [website](https://example.com).';
      const mockStaticText = createMockStaticText({ content: linkContent });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toBe(linkContent);
    });

    it('should handle rental agreement style content', () => {
      const rentalAgreement = `---

## Rental Agreement

By submitting this reservation request, you agree to the following terms:

1. **Cancellation Policy**: Cancellations must be made at least 48 hours in advance for a full refund.

2. **Facility Care**: The renter is responsible for leaving the facility in the same condition as found.

*For questions, contact Community Services at (555) 123-4567.*`;

      const mockStaticText = createMockStaticText({ content: rentalAgreement });

      fixture.componentRef.setInput('staticText', mockStaticText);
      fixture.detectChanges();

      expect(component.staticText().content).toContain('Rental Agreement');
      expect(component.staticText().content).toContain('Cancellation Policy');
    });
  });
});
