/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { InverseRelationshipData } from '../../interfaces/entity';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Displays a grid of related record cards for inverse relationships.
 * Used by both the Detail page and the Profile page.
 *
 * @input relationships - Array of inverse relationship data with preview records
 * @input targetId - The ID to filter by in "View all" links (e.g., entity ID or user ID)
 */
@Component({
  selector: 'app-related-records',
  standalone: true,
  imports: [RouterLink, TranslatePipe],
  templateUrl: './related-records.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RelatedRecordsComponent {
  relationships = input.required<InverseRelationshipData[]>();
  targetId = input.required<string | number>();

  readonly LARGE_RELATIONSHIP_THRESHOLD = 20;
}
