import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GeometricPortCalculatorService } from './geometric-port-calculator.service';
import { PortData, Point, Size, Side } from '../../interfaces/schema-diagram.interface';

/**
 * Tests for GeometricPortCalculatorService
 *
 * This service contains pure geometric calculation functions for port positioning.
 * Key concepts:
 * - Angles are in degrees from -180 to 180 (Math.atan2 output)
 * - Screen coordinates: Y increases downward (positive Y = down)
 * - Dimension-aware thresholds based on entity aspect ratio
 */
describe('GeometricPortCalculatorService', () => {
    let service: GeometricPortCalculatorService;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [provideZonelessChangeDetection()]
        });
        service = TestBed.inject(GeometricPortCalculatorService);
    });

    it('should be created', () => {
        expect(service).toBeTruthy();
    });

    /**
     * Tests for determineSideFromAngle()
     *
     * This function maps angles (-180° to 180°) to entity sides (top, right, bottom, left).
     * Now dimension-aware: thresholds are calculated based on entity aspect ratio.
     * For 250×100 entities: corner angle = atan2(50, 125) ≈ 21.8°
     * Critical to get right because screen coordinates have Y increasing downward.
     */
    describe('determineSideFromAngle()', () => {
        const ENTITY_WIDTH = 250;
        const ENTITY_HEIGHT = 100;
        const CORNER_ANGLE = Math.atan2(ENTITY_HEIGHT / 2, ENTITY_WIDTH / 2) * (180 / Math.PI); // ≈ 21.8°

        describe(`RIGHT side (angles -${CORNER_ANGLE.toFixed(1)}° to ${CORNER_ANGLE.toFixed(1)}°)`, () => {
            it('should return "right" for -21° (within right zone)', () => {
                expect(service.determineSideFromAngle(-21, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should return "right" for -10° (upper right)', () => {
                expect(service.determineSideFromAngle(-10, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should return "right" for 0° (directly right)', () => {
                expect(service.determineSideFromAngle(0, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should return "right" for 10° (lower right)', () => {
                expect(service.determineSideFromAngle(10, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should return "right" for 21° (near boundary)', () => {
                expect(service.determineSideFromAngle(21, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });
        });

        describe(`BOTTOM side (angles ${CORNER_ANGLE.toFixed(1)}° to ${(180 - CORNER_ANGLE).toFixed(1)}°) - positive Y in screen coords`, () => {
            it('should return "bottom" for 22° (just past boundary)', () => {
                expect(service.determineSideFromAngle(22, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });

            it('should return "bottom" for 45° (lower-right diagonal)', () => {
                expect(service.determineSideFromAngle(45, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });

            it('should return "bottom" for 90° (directly down)', () => {
                expect(service.determineSideFromAngle(90, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });

            it('should return "bottom" for 135° (lower-left diagonal)', () => {
                expect(service.determineSideFromAngle(135, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });

            it('should return "bottom" for 157° (near boundary)', () => {
                expect(service.determineSideFromAngle(157, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });
        });

        describe(`LEFT side (angles ${(180 - CORNER_ANGLE).toFixed(1)}° to -${(180 - CORNER_ANGLE).toFixed(1)}°, wrapping through ±180°)`, () => {
            it('should return "left" for 159° (just past boundary from bottom)', () => {
                expect(service.determineSideFromAngle(159, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });

            it('should return "left" for 170° (upper-left diagonal)', () => {
                expect(service.determineSideFromAngle(170, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });

            it('should return "left" for 180° (directly left)', () => {
                expect(service.determineSideFromAngle(180, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });

            it('should return "left" for -180° (directly left, negative notation)', () => {
                expect(service.determineSideFromAngle(-180, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });

            it('should return "left" for -170° (lower-left diagonal)', () => {
                expect(service.determineSideFromAngle(-170, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });

            it('should return "left" for -159° (near boundary)', () => {
                expect(service.determineSideFromAngle(-159, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('left');
            });
        });

        describe(`TOP side (angles -${(180 - CORNER_ANGLE).toFixed(1)}° to -${CORNER_ANGLE.toFixed(1)}°) - negative Y in screen coords`, () => {
            it('should return "top" for -157° (just past boundary from left)', () => {
                expect(service.determineSideFromAngle(-157, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });

            it('should return "top" for -135° (upper-left diagonal)', () => {
                expect(service.determineSideFromAngle(-135, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });

            it('should return "top" for -90° (directly up)', () => {
                expect(service.determineSideFromAngle(-90, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });

            it('should return "top" for -45° (upper-right diagonal)', () => {
                expect(service.determineSideFromAngle(-45, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });

            it('should return "top" for -22° (near boundary)', () => {
                expect(service.determineSideFromAngle(-22, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });
        });

        describe('Edge cases and precision', () => {
            it('should handle very small positive angle', () => {
                expect(service.determineSideFromAngle(0.1, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should handle very small negative angle', () => {
                expect(service.determineSideFromAngle(-0.1, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('right');
            });

            it('should handle exact boundary at corner angle', () => {
                // At exactly cornerAngle, should be bottom (normalized >= cornerAngle condition)
                expect(service.determineSideFromAngle(CORNER_ANGLE, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('bottom');
            });

            it('should handle exact boundary at negative corner angle', () => {
                // At exactly -cornerAngle, boundary behavior depends on implementation
                // Testing actual behavior: angles <= -cornerAngle go to top side
                expect(service.determineSideFromAngle(-CORNER_ANGLE, ENTITY_WIDTH, ENTITY_HEIGHT)).toBe('top');
            });

            it('should work with square entities (45° thresholds)', () => {
                // Test with square dimensions to verify backward compatibility
                const squareCornerAngle = Math.atan2(250 / 2, 250 / 2) * (180 / Math.PI); // = 45°
                expect(service.determineSideFromAngle(0, 250, 250)).toBe('right');
                expect(service.determineSideFromAngle(45, 250, 250)).toBe('bottom');
                expect(service.determineSideFromAngle(135, 250, 250)).toBe('left');
                expect(service.determineSideFromAngle(-135, 250, 250)).toBe('top');
            });
        });
    });

    /**
     * Tests for getCenter()
     *
     * This function calculates the center point from position and size.
     * Must correctly handle position (top-left corner) + size to find center.
     */
    describe('getCenter()', () => {
        it('should calculate center from position and size', () => {
            const position: Point = { x: 100, y: 200 };
            const size: Size = { width: 250, height: 100 };

            const center = service.getCenter(position, size);

            expect(center.x).toBe(225); // 100 + 250/2
            expect(center.y).toBe(250); // 200 + 100/2
        });

        it('should handle zero position', () => {
            const position: Point = { x: 0, y: 0 };
            const size: Size = { width: 100, height: 50 };

            const center = service.getCenter(position, size);

            expect(center.x).toBe(50); // 0 + 100/2
            expect(center.y).toBe(25); // 0 + 50/2
        });

        it('should handle large coordinates', () => {
            const position: Point = { x: 5000, y: 3000 };
            const size: Size = { width: 400, height: 200 };

            const center = service.getCenter(position, size);

            expect(center.x).toBe(5200); // 5000 + 400/2
            expect(center.y).toBe(3100); // 3000 + 200/2
        });

        it('should handle decimal positions and sizes', () => {
            const position: Point = { x: 100.5, y: 200.7 };
            const size: Size = { width: 250.3, height: 100.9 };

            const center = service.getCenter(position, size);

            expect(center.x).toBeCloseTo(225.65, 2); // 100.5 + 250.3/2
            expect(center.y).toBeCloseTo(251.15, 2); // 200.7 + 100.9/2
        });

        it('should handle square elements', () => {
            const position: Point = { x: 300, y: 400 };
            const size: Size = { width: 100, height: 100 };

            const center = service.getCenter(position, size);

            expect(center.x).toBe(350); // 300 + 100/2
            expect(center.y).toBe(450); // 400 + 100/2
        });

        it('should handle very small elements', () => {
            const position: Point = { x: 50, y: 75 };
            const size: Size = { width: 10, height: 5 };

            const center = service.getCenter(position, size);

            expect(center.x).toBe(55); // 50 + 10/2
            expect(center.y).toBe(77.5); // 75 + 5/2
        });
    });

    /**
     * Tests for calculateAngleBetweenPoints()
     *
     * This function calculates the angle from one point to another.
     * Screen coordinates: Y increases downward.
     */
    describe('calculateAngleBetweenPoints()', () => {
        it('should return 0° for points directly to the right', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: 100, y: 0 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBe(0);
        });

        it('should return 90° for points directly downward (screen coords)', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: 0, y: 100 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBe(90);
        });

        it('should return 180° for points directly to the left', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: -100, y: 0 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBeCloseTo(180, 5); // Use toBeCloseTo for floating point
        });

        it('should return -90° for points directly upward (screen coords)', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: 0, y: -100 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBe(-90);
        });

        it('should return 45° for points at lower-right diagonal', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: 100, y: 100 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBe(45);
        });

        it('should return -45° for points at upper-right diagonal', () => {
            const from: Point = { x: 0, y: 0 };
            const to: Point = { x: 100, y: -100 };

            const angle = service.calculateAngleBetweenPoints(from, to);

            expect(angle).toBe(-45);
        });
    });

    /**
     * Tests for sortPortsBySide()
     *
     * This function sorts ports for a specific side based on their angles.
     */
    describe('sortPortsBySide()', () => {
        it('should sort top ports ascending (left to right)', () => {
            const ports: PortData[] = [
                { id: 'p1', group: 'top', angle: -90, relatedTable: 't1' },
                { id: 'p2', group: 'top', angle: -135, relatedTable: 't2' },
                { id: 'p3', group: 'top', angle: -45, relatedTable: 't3' }
            ];

            const sorted = service.sortPortsBySide(ports, 'top');

            expect(sorted[0].id).toBe('p2'); // -135° (leftmost)
            expect(sorted[1].id).toBe('p1'); // -90°
            expect(sorted[2].id).toBe('p3'); // -45° (rightmost)
        });

        it('should sort right ports ascending (top to bottom)', () => {
            const ports: PortData[] = [
                { id: 'p1', group: 'right', angle: 20, relatedTable: 't1' },
                { id: 'p2', group: 'right', angle: -10, relatedTable: 't2' },
                { id: 'p3', group: 'right', angle: 0, relatedTable: 't3' }
            ];

            const sorted = service.sortPortsBySide(ports, 'right');

            expect(sorted[0].id).toBe('p2'); // -10° (topmost)
            expect(sorted[1].id).toBe('p3'); // 0°
            expect(sorted[2].id).toBe('p1'); // 20° (bottommost)
        });

        it('should sort bottom ports descending (left to right on screen)', () => {
            const ports: PortData[] = [
                { id: 'p1', group: 'bottom', angle: 90, relatedTable: 't1' },
                { id: 'p2', group: 'bottom', angle: 45, relatedTable: 't2' },
                { id: 'p3', group: 'bottom', angle: 135, relatedTable: 't3' }
            ];

            const sorted = service.sortPortsBySide(ports, 'bottom');

            // Descending sort: largest angle first (leftmost on screen)
            expect(sorted[0].id).toBe('p3'); // 135° (leftmost on screen)
            expect(sorted[1].id).toBe('p1'); // 90°
            expect(sorted[2].id).toBe('p2'); // 45° (rightmost on screen)
        });

        it('should sort left ports with wraparound handling (top to bottom)', () => {
            const ports: PortData[] = [
                { id: 'p1', group: 'left', angle: -170, relatedTable: 't1' },
                { id: 'p2', group: 'left', angle: 170, relatedTable: 't2' },
                { id: 'p3', group: 'left', angle: -150, relatedTable: 't3' }
            ];

            const sorted = service.sortPortsBySide(ports, 'left');

            // After normalization: -170° → 190°, -150° → 210°, 170° stays 170°
            // Sort descending: 210° (p3, upmost), 190° (p1), 170° (p2, downmost)
            expect(sorted[0].id).toBe('p3'); // -150° normalized to 210° (upmost)
            expect(sorted[1].id).toBe('p1'); // -170° normalized to 190°
            expect(sorted[2].id).toBe('p2'); // 170° (downmost)
        });
    });

    /**
     * Tests for groupPortsBySide()
     *
     * This function groups ports by their side.
     */
    describe('groupPortsBySide()', () => {
        it('should group ports by side correctly', () => {
            const ports: PortData[] = [
                { id: 'p1', group: 'top', angle: -90, relatedTable: 't1' },
                { id: 'p2', group: 'right', angle: 0, relatedTable: 't2' },
                { id: 'p3', group: 'bottom', angle: 90, relatedTable: 't3' },
                { id: 'p4', group: 'left', angle: 180, relatedTable: 't4' },
                { id: 'p5', group: 'top', angle: -45, relatedTable: 't5' }
            ];

            const grouped = service.groupPortsBySide(ports);

            expect(grouped.top.length).toBe(2);
            expect(grouped.right.length).toBe(1);
            expect(grouped.bottom.length).toBe(1);
            expect(grouped.left.length).toBe(1);
        });

        it('should handle empty input', () => {
            const grouped = service.groupPortsBySide([]);

            expect(grouped.top.length).toBe(0);
            expect(grouped.right.length).toBe(0);
            expect(grouped.bottom.length).toBe(0);
            expect(grouped.left.length).toBe(0);
        });
    });

    /**
     * Tests for sortAllPorts()
     *
     * This is the main entry point that groups and sorts all ports.
     */
    describe('sortAllPorts()', () => {
        it('should group and sort all ports correctly', () => {
            const ports: PortData[] = [
                { id: 'top1', group: 'top', angle: -45, relatedTable: 't1' },
                { id: 'top2', group: 'top', angle: -90, relatedTable: 't2' },
                { id: 'right1', group: 'right', angle: 10, relatedTable: 't3' },
                { id: 'right2', group: 'right', angle: -10, relatedTable: 't4' },
                { id: 'bottom1', group: 'bottom', angle: 90, relatedTable: 't5' },
                { id: 'left1', group: 'left', angle: 170, relatedTable: 't6' }
            ];

            const sorted = service.sortAllPorts(ports);

            expect(sorted.top.length).toBe(2);
            expect(sorted.top[0].id).toBe('top2'); // -90° before -45°
            expect(sorted.right.length).toBe(2);
            expect(sorted.right[0].id).toBe('right2'); // -10° before 10°
            expect(sorted.bottom.length).toBe(1);
            expect(sorted.left.length).toBe(1);
        });
    });
});
