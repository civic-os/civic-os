#!/usr/bin/env npx ts-node
/**
 * Import iCal/ICS events into Civic OS reservation_requests
 *
 * This script parses Google Calendar (or any iCal source) and generates SQL
 * to import historical events as Completed reservation requests.
 *
 * Usage:
 *   npx ts-node import-ical.ts <path-to-ics-file> > import.sql
 *   npx ts-node import-ical.ts https://calendar.google.com/calendar/ical/.../basic.ics > import.sql
 *
 * Then run the generated SQL against your database:
 *   psql -h localhost -U postgres -d civicos < import.sql
 *
 * The sync trigger will automatically populate public_calendar_events.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

// Configuration - adjust these defaults for your import
const CONFIG = {
  // Only import events starting on or after this date (null = import all)
  // Set to 'now' to only import future events, or a date like '2024-01-01'
  FILTER_FROM_DATE: 'now' as string | null,

  // Status IDs (from mottpark metadata.statuses)
  STATUS_ID_APPROVED: 22,   // For future events
  STATUS_ID_COMPLETED: 25,  // For past events

  // Default requestor for imported events (update after checking your users)
  // Run: SELECT id, display_name FROM metadata.civic_os_users;
  DEFAULT_REQUESTOR_ID: '166bd65e-045e-47b5-af6b-2af204804eb7',

  // Default values for required fields
  DEFAULT_REQUESTOR_NAME: 'Historical Import',
  DEFAULT_REQUESTOR_ADDRESS: 'Imported from Google Calendar',
  DEFAULT_REQUESTOR_PHONE: '8105550000',
  DEFAULT_ATTENDEE_COUNT: 25,
};

interface ICalEvent {
  uid: string;
  summary: string;
  dtstart: Date;
  dtend: Date;
  description?: string;
  location?: string;
  categories?: string[];
  organizer?: string;
}

function parseICalDate(value: string): Date {
  // Handle formats: 20240315T140000Z or 20240315T140000 or 20240315
  const cleaned = value.replace(/[^0-9TZ]/g, '');

  if (cleaned.length === 8) {
    // Date only: 20240315 - assume full day event
    return new Date(`${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}T00:00:00Z`);
  }

  // DateTime: 20240315T140000 or 20240315T140000Z
  const year = cleaned.slice(0, 4);
  const month = cleaned.slice(4, 6);
  const day = cleaned.slice(6, 8);
  const hour = cleaned.slice(9, 11) || '00';
  const minute = cleaned.slice(11, 13) || '00';
  const second = cleaned.slice(13, 15) || '00';
  const isUtc = cleaned.endsWith('Z');

  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${isUtc ? 'Z' : ''}`);
}

function parseICalContent(content: string): ICalEvent[] {
  const events: ICalEvent[] = [];
  // Unfold continued lines (RFC 5545: lines starting with space are continuations)
  const lines = content.replace(/\r\n[ \t]/g, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

  let currentEvent: Partial<ICalEvent> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      currentEvent = {};
    } else if (line === 'END:VEVENT' && currentEvent) {
      if (currentEvent.summary && currentEvent.dtstart && currentEvent.dtend) {
        events.push(currentEvent as ICalEvent);
      } else if (currentEvent.summary && currentEvent.dtstart) {
        // Handle all-day events (no DTEND) - assume 4 hour default
        currentEvent.dtend = new Date(currentEvent.dtstart.getTime() + 4 * 60 * 60 * 1000);
        events.push(currentEvent as ICalEvent);
      }
      currentEvent = null;
    } else if (currentEvent) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      let key = line.slice(0, colonIndex);
      const value = line.slice(colonIndex + 1);

      // Handle parameters like DTSTART;TZID=America/New_York:20240315T140000
      if (key.includes(';')) {
        key = key.split(';')[0];
      }

      switch (key) {
        case 'UID':
          currentEvent.uid = value;
          break;
        case 'SUMMARY':
          currentEvent.summary = value
            .replace(/\\,/g, ',')
            .replace(/\\n/g, '\n')
            .replace(/\\;/g, ';')
            .replace(/\\\\/g, '\\');
          break;
        case 'DTSTART':
          currentEvent.dtstart = parseICalDate(value);
          break;
        case 'DTEND':
          currentEvent.dtend = parseICalDate(value);
          break;
        case 'DESCRIPTION':
          currentEvent.description = value
            .replace(/\\,/g, ',')
            .replace(/\\n/g, '\n')
            .replace(/\\;/g, ';')
            .replace(/\\\\/g, '\\');
          break;
        case 'LOCATION':
          currentEvent.location = value;
          break;
        case 'CATEGORIES':
          currentEvent.categories = value.split(',');
          break;
        case 'ORGANIZER':
          // Extract name from CN= parameter or email
          const cnMatch = line.match(/CN=([^;:]+)/i);
          currentEvent.organizer = cnMatch ? cnMatch[1] : value.replace('mailto:', '');
          break;
      }
    }
  }

  return events;
}

function inferEventType(event: ICalEvent): string {
  const summary = event.summary.toLowerCase();
  const description = (event.description || '').toLowerCase();
  const categories = event.categories?.map(c => c.toLowerCase()) || [];
  const text = `${summary} ${description} ${categories.join(' ')}`;

  // Common event type patterns for clubhouse rentals
  if (text.includes('reunion')) return 'Family Reunion';
  if (text.includes('birthday')) return 'Birthday Party';
  if (text.includes('wedding') || text.includes('reception')) return 'Wedding Reception';
  if (text.includes('meeting') || text.includes('board')) return 'Meeting';
  if (text.includes('class') || text.includes('workshop')) return 'Class/Workshop';
  if (text.includes('fundraiser') || text.includes('benefit')) return 'Fundraiser';
  if (text.includes('memorial') || text.includes('funeral')) return 'Memorial Service';
  if (text.includes('baby shower') || text.includes('shower')) return 'Baby Shower';
  if (text.includes('graduation')) return 'Graduation Party';
  if (text.includes('holiday') || text.includes('christmas') || text.includes('easter')) return 'Holiday Party';
  if (text.includes('anniversary')) return 'Anniversary Party';
  if (text.includes('retirement')) return 'Retirement Party';
  if (text.includes('church') || text.includes('religious')) return 'Religious Event';
  if (text.includes('community')) return 'Community Event';

  return 'Private Event';
}

function extractRequestorInfo(event: ICalEvent): { name: string; phone: string } {
  // Try to extract requestor name from organizer or description
  let name = CONFIG.DEFAULT_REQUESTOR_NAME;
  let phone = CONFIG.DEFAULT_REQUESTOR_PHONE;

  if (event.organizer) {
    name = event.organizer.split('@')[0].replace(/[._]/g, ' ');
    // Capitalize words
    name = name.replace(/\b\w/g, c => c.toUpperCase());
  }

  // Try to find phone number in description
  if (event.description) {
    const phoneMatch = event.description.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (phoneMatch) {
      phone = phoneMatch[0].replace(/\D/g, '');
    }
  }

  return { name, phone };
}

function escapeSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function generateSQL(events: ICalEvent[]): string {
  const lines: string[] = [
    '-- ============================================================================',
    '-- GOOGLE CALENDAR IMPORT: reservation_requests',
    '-- ============================================================================',
    `-- Source: iCal file with ${events.length} events`,
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    '-- IMPORTANT: Review and adjust the DEFAULT_REQUESTOR_ID before running!',
    `-- Current: ${CONFIG.DEFAULT_REQUESTOR_ID}`,
    '--',
    '-- The sync trigger will automatically populate public_calendar_events',
    '-- for all Completed status events.',
    '-- ============================================================================',
    '',
    'BEGIN;',
    '',
  ];

  events.forEach((event, index) => {
    const requestorInfo = extractRequestorInfo(event);
    const eventType = escapeSQL(inferEventType(event));
    const displayName = escapeSQL(event.summary.slice(0, 100)); // varchar limit
    const startTs = formatTimestamp(event.dtstart);
    const endTs = formatTimestamp(event.dtend);
    const orgName = event.organizer ? escapeSQL(event.organizer.slice(0, 100)) : null;

    lines.push(`-- Event ${index + 1}: ${event.summary} (${event.dtstart.toLocaleDateString()})`);
    lines.push(`INSERT INTO reservation_requests (`);
    lines.push(`  requestor_id,`);
    lines.push(`  requestor_name,`);
    lines.push(`  requestor_address,`);
    lines.push(`  requestor_phone,`);
    lines.push(`  organization_name,`);
    lines.push(`  event_type,`);
    lines.push(`  time_slot,`);
    lines.push(`  attendee_count,`);
    lines.push(`  is_food_served,`);
    lines.push(`  is_public_event,`);
    lines.push(`  is_fundraiser,`);
    lines.push(`  is_admission_charged,`);
    lines.push(`  policy_agreed,`);
    lines.push(`  status_id,`);
    lines.push(`  display_name`);
    lines.push(`) VALUES (`);
    lines.push(`  '${CONFIG.DEFAULT_REQUESTOR_ID}'::uuid,`);
    lines.push(`  '${escapeSQL(requestorInfo.name)}',`);
    lines.push(`  '${CONFIG.DEFAULT_REQUESTOR_ADDRESS}',`);
    lines.push(`  '${requestorInfo.phone}',`);
    lines.push(`  ${orgName ? `'${orgName}'` : 'NULL'},`);
    lines.push(`  '${eventType}',`);
    lines.push(`  tstzrange('${startTs}', '${endTs}', '[)'),`);
    lines.push(`  ${CONFIG.DEFAULT_ATTENDEE_COUNT},`);
    lines.push(`  false,  -- is_food_served`);
    lines.push(`  false,  -- is_public_event (historical imports default to private)`);
    lines.push(`  false,  -- is_fundraiser`);
    lines.push(`  false,  -- is_admission_charged`);
    lines.push(`  true,   -- policy_agreed`);
    // Use Approved status for future events, Completed for past
    const statusId = event.dtstart > new Date() ? CONFIG.STATUS_ID_APPROVED : CONFIG.STATUS_ID_COMPLETED;
    const statusLabel = statusId === CONFIG.STATUS_ID_APPROVED ? 'Approved' : 'Completed';
    lines.push(`  ${statusId},  -- ${statusLabel} status`);
    lines.push(`  '${displayName}'`);
    lines.push(`);`);
    lines.push('');
  });

  lines.push('COMMIT;');
  lines.push('');
  lines.push('-- ============================================================================');
  lines.push('-- VERIFICATION');
  lines.push('-- ============================================================================');
  lines.push('');
  lines.push('-- Check imported reservation requests:');
  lines.push(`-- SELECT COUNT(*) FROM reservation_requests WHERE status_id = ${CONFIG.STATUS_ID_COMPLETED};`);
  lines.push('');
  lines.push('-- Check synced public calendar events:');
  lines.push('-- SELECT COUNT(*) FROM public_calendar_events;');
  lines.push('');
  lines.push('-- View imported events:');
  lines.push("-- SELECT id, display_name, event_type, time_slot FROM reservation_requests");
  lines.push(`--   WHERE status_id = ${CONFIG.STATUS_ID_COMPLETED} ORDER BY time_slot;`);

  return lines.join('\n');
}

async function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error('Usage: npx ts-node import-ical.ts <path-or-url>');
    console.error('');
    console.error('Examples:');
    console.error('  npx ts-node import-ical.ts calendar.ics > import.sql');
    console.error('  npx ts-node import-ical.ts "https://calendar.google.com/.../basic.ics" > import.sql');
    console.error('');
    console.error('Then run the SQL:');
    console.error('  psql -h localhost -U postgres -d civicos < import.sql');
    process.exit(1);
  }

  let content: string;

  if (input.startsWith('http://') || input.startsWith('https://')) {
    console.error(`Fetching ${input}...`);
    try {
      content = await fetchUrl(input);
    } catch (err) {
      console.error(`Failed to fetch URL: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    if (!fs.existsSync(input)) {
      console.error(`File not found: ${input}`);
      process.exit(1);
    }
    content = fs.readFileSync(input, 'utf-8');
  }

  let events = parseICalContent(content);
  console.error(`Parsed ${events.length} events from iCal data`);

  if (events.length === 0) {
    console.error('No events found in iCal data');
    console.error('Make sure the file contains VEVENT blocks');
    process.exit(1);
  }

  // Sort by start date (oldest first)
  events.sort((a, b) => a.dtstart.getTime() - b.dtstart.getTime());

  // Apply date filter if configured
  let filteredEvents = events;
  if (CONFIG.FILTER_FROM_DATE) {
    const filterDate = CONFIG.FILTER_FROM_DATE === 'now'
      ? new Date()
      : new Date(CONFIG.FILTER_FROM_DATE);

    console.error(`Filtering to events starting on or after: ${filterDate.toLocaleDateString()}`);
    filteredEvents = events.filter(e => e.dtstart >= filterDate);
    console.error(`Filtered: ${events.length} → ${filteredEvents.length} events`);
  }

  events = filteredEvents;

  // Show summary
  console.error('');
  console.error('Events to import:');
  events.slice(0, 5).forEach(e => {
    console.error(`  - ${e.dtstart.toLocaleDateString()}: ${e.summary.slice(0, 50)}`);
  });
  if (events.length > 5) {
    console.error(`  ... and ${events.length - 5} more`);
  }
  console.error('');

  const sql = generateSQL(events);
  console.log(sql);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
