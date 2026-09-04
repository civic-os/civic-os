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
import { MarkdownWidgetComponent } from './markdown-widget.component';
import { DashboardWidget, MarkdownWidgetConfig } from '../../../interfaces/dashboard';
import { createMockWidget, MOCK_WIDGETS } from '../../../testing';

describe('MarkdownWidgetComponent', () => {
    let component: MarkdownWidgetComponent;
    let fixture: ComponentFixture<MarkdownWidgetComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [MarkdownWidgetComponent, MarkdownModule],
            providers: [
                provideZonelessChangeDetection(),
                provideMarkdown()
            ]
        }).compileComponents();

        fixture = TestBed.createComponent(MarkdownWidgetComponent);
        component = fixture.componentInstance;
    });

    describe('Basic Component Setup', () => {
        it('should create', () => {
            // Set required input
            fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
            fixture.detectChanges();

            expect(component).toBeTruthy();
        });

        it('should have widget input', () => {
            const mockWidget = MOCK_WIDGETS.markdown;
            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.widget()).toEqual(mockWidget);
        });
    });

    describe('config computed signal', () => {
        it('should extract config as MarkdownWidgetConfig', () => {
            const mockWidget = createMockWidget({
                widget_type: 'markdown',
                config: {
                    content: '# Test Heading',
                    enableHtml: true
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            const config = component.config();
            expect(config).toBeDefined();
            expect(config.content).toBe('# Test Heading');
            expect(config.enableHtml).toBe(true);
        });

        it('should handle config with enableHtml: false', () => {
            const mockWidget = createMockWidget({
                widget_type: 'markdown',
                config: {
                    content: '# Secure Content',
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            const config = component.config();
            expect(config.enableHtml).toBe(false);
        });

        it('should update when widget input changes', () => {
            const mockWidget1 = createMockWidget({
                config: { content: 'First', enableHtml: false }
            });
            const mockWidget2 = createMockWidget({
                config: { content: 'Second', enableHtml: true }
            });

            fixture.componentRef.setInput('widget', mockWidget1);
            fixture.detectChanges();
            expect(component.config().content).toBe('First');

            fixture.componentRef.setInput('widget', mockWidget2);
            fixture.detectChanges();
            expect(component.config().content).toBe('Second');
        });
    });

    describe('content computed signal', () => {
        it('should return markdown content from config', () => {
            const markdownContent = '# Welcome\n\nThis is **bold** text.';
            const mockWidget = createMockWidget({
                config: {
                    content: markdownContent,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe(markdownContent);
        });

        it('should return empty string when config.content is null', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: null as any,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe('');
        });

        it('should return empty string when config.content is undefined', () => {
            const mockWidget = createMockWidget({
                config: {
                    enableHtml: false
                } as MarkdownWidgetConfig
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe('');
        });

        it('should return empty string when config.content is empty string', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '',
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe('');
        });

        it('should handle multiline markdown content', () => {
            const multilineContent = `# Title

Paragraph 1

## Subtitle

- Item 1
- Item 2
- Item 3`;

            const mockWidget = createMockWidget({
                config: {
                    content: multilineContent,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe(multilineContent);
        });

        it('should handle content with special characters', () => {
            const specialContent = '# Test\n\n`code` & **bold** & *italic*';
            const mockWidget = createMockWidget({
                config: {
                    content: specialContent,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe(specialContent);
        });
    });

    describe('enableHtml computed signal', () => {
        it('should return true when config.enableHtml is true', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '# Test',
                    enableHtml: true
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.enableHtml()).toBe(true);
        });

        it('should return false when config.enableHtml is false', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '# Test',
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.enableHtml()).toBe(false);
        });

        it('should default to false when config.enableHtml is undefined', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '# Test'
                } as MarkdownWidgetConfig
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.enableHtml()).toBe(false);
        });

        it('should default to false when config.enableHtml is null', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '# Test',
                    enableHtml: null as any
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.enableHtml()).toBe(false);
        });
    });

    describe('Template Rendering', () => {
        it('should render markdown content in the DOM', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '# Test Heading',
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const markdownDiv = compiled.querySelector('.markdown-widget');

            expect(markdownDiv).toBeTruthy();
            expect(markdownDiv?.classList.contains('prose')).toBe(true);
            expect(markdownDiv?.classList.contains('max-w-none')).toBe(true);
        });

        it('should contain markdown directive', () => {
            const mockWidget = createMockWidget({
                config: {
                    content: '**Bold text**',
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            const compiled = fixture.nativeElement as HTMLElement;
            const markdownElement = compiled.querySelector('markdown');

            expect(markdownElement).toBeTruthy();
        });
    });

    describe('Pre-configured Mock Widgets', () => {
        it('should work with MOCK_WIDGETS.markdown', () => {
            fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdown);
            fixture.detectChanges();

            expect(component.content()).toContain('Test Markdown');
            expect(component.content()).toContain('**bold**');
            expect(component.enableHtml()).toBe(false);
        });

        it('should work with MOCK_WIDGETS.markdownNoTitle', () => {
            fixture.componentRef.setInput('widget', MOCK_WIDGETS.markdownNoTitle);
            fixture.detectChanges();

            expect(component.widget().title).toBeNull();
            expect(component.content()).toBe('Simple content without title');
        });
    });

    describe('Change Detection with OnPush', () => {
        it('should update computed signals when widget input changes', () => {
            const widget1 = createMockWidget({
                config: {
                    content: 'Content 1',
                    enableHtml: false
                }
            });
            const widget2 = createMockWidget({
                config: {
                    content: 'Content 2',
                    enableHtml: true
                }
            });

            fixture.componentRef.setInput('widget', widget1);
            fixture.detectChanges();
            expect(component.content()).toBe('Content 1');
            expect(component.enableHtml()).toBe(false);

            fixture.componentRef.setInput('widget', widget2);
            fixture.detectChanges();
            expect(component.content()).toBe('Content 2');
            expect(component.enableHtml()).toBe(true);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty config object', () => {
            const mockWidget = createMockWidget({
                config: {} as MarkdownWidgetConfig
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe('');
            expect(component.enableHtml()).toBe(false);
        });

        it('should handle very long markdown content', () => {
            const longContent = '# Heading\n\n' + 'Lorem ipsum '.repeat(1000);
            const mockWidget = createMockWidget({
                config: {
                    content: longContent,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content().length).toBeGreaterThan(10000);
            expect(component.content()).toBe(longContent);
        });

        it('should handle markdown with HTML when enableHtml is true', () => {
            const htmlContent = '# Test\n\n<div class="custom">HTML Content</div>';
            const mockWidget = createMockWidget({
                config: {
                    content: htmlContent,
                    enableHtml: true
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe(htmlContent);
            expect(component.enableHtml()).toBe(true);
        });

        it('should handle markdown with code blocks', () => {
            const codeContent = '# Code Example\n\n```typescript\nconst x = 10;\n```';
            const mockWidget = createMockWidget({
                config: {
                    content: codeContent,
                    enableHtml: false
                }
            });

            fixture.componentRef.setInput('widget', mockWidget);
            fixture.detectChanges();

            expect(component.content()).toBe(codeContent);
        });
    });
});
