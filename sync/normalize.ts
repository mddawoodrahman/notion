/**
 * Normalization: Notion page → typed task row. Pure, synchronous and
 * side-effect free apart from the optional warning sink. Nothing here throws
 * for a single malformed property: one bad page must never fail a whole run.
 */

import type { NormalizedTask } from '../src/task-model.js';
import type { PropertyMap } from './property-map.js';

export type { NormalizedTask } from '../src/task-model.js';

export interface NotionParent {
  readonly type?: string;
  readonly data_source_id?: string;
  readonly database_id?: string;
  readonly page_id?: string;
  readonly [key: string]: unknown;
}

export interface NotionPropertyValue {
  readonly id?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface NotionPageLike {
  readonly object: 'page';
  readonly id: string;
  readonly url?: string;
  readonly created_time?: string;
  readonly last_edited_time?: string;
  readonly in_trash?: boolean;
  readonly archived?: boolean;
  readonly is_archived?: boolean;
  readonly parent?: NotionParent;
  readonly properties?: Record<string, NotionPropertyValue>;
}

export type NormalizeWarningCode =
  | 'unknown_property_type'
  | 'property_type_mismatch'
  | 'multi_select_not_flattenable'
  | 'invalid_date'
  | 'reminder_date_only'
  | 'invalid_page_time';

export interface NormalizeWarning {
  readonly code: NormalizeWarningCode;
  readonly pageId: string;
  readonly property: string;
  readonly type?: string;
}

export interface NormalizeContext {
  readonly propertyMap: PropertyMap;
  readonly dataSourceId: string;
  readonly databaseId: string;
  readonly timezone: string;
  /** Called once per (page, property, code). Never receives property values. */
  readonly onWarning?: (warning: NormalizeWarning) => void;
}

/**
 * Types that are intentionally preserved in `raw_properties` without a typed
 * column. Anything outside this set gets one warning per property; it is still
 * stored verbatim and never fails the page.
 */
const KNOWN_UNMAPPED_TYPES = new Set([
  'rich_text',
  'number',
  'multi_select',
  'relation',
  'people',
  'formula',
  'rollup',
  'url',
  'files',
  'email',
  'phone_number',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
]);

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_PATTERN = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const WALL_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

export function normalizePage(page: NotionPageLike, context: NormalizeContext): NormalizedTask {
  const properties = page.properties ?? {};
  const emitted = new Set<string>();

  const warn = (warning: Omit<NormalizeWarning, 'pageId'>): void => {
    const key = `${warning.code}:${warning.property}`;
    if (emitted.has(key)) {
      return;
    }
    emitted.add(key);
    context.onWarning?.({ ...warning, pageId: page.id });
  };

  const binding = context.propertyMap.bindings;

  const readTitle = (): string => {
    const property = properties[binding.title.name];
    if (property === undefined) {
      return '';
    }
    if (property.type !== 'title') {
      warn({ code: 'property_type_mismatch', property: binding.title.name, type: property.type });
      return '';
    }
    return joinRichText(property['title']).replace(/\s+$/u, '');
  };

  const readStatus = (): string | null => {
    const property = properties[binding.status.name];
    if (property === undefined) {
      return null;
    }
    if (property.type !== 'status') {
      warn({ code: 'property_type_mismatch', property: binding.status.name, type: property.type });
      return null;
    }
    return optionName(property['status']);
  };

  const readListName = (): string | null => {
    const property = properties[binding.list_name.name];
    if (property === undefined) {
      return null;
    }
    if (property.type === 'multi_select') {
      warn({ code: 'multi_select_not_flattenable', property: binding.list_name.name });
      return null;
    }
    if (property.type !== 'select') {
      warn({ code: 'property_type_mismatch', property: binding.list_name.name, type: property.type });
      return null;
    }
    return optionName(property['select']);
  };

  const readPriority = (): string | null => {
    const property = properties[binding.priority.name];
    if (property === undefined) {
      return null;
    }
    if (property.type !== 'select' && property.type !== 'status') {
      warn({ code: 'property_type_mismatch', property: binding.priority.name, type: property.type });
      return null;
    }
    return optionName(property[property.type]);
  };

  const readCheckbox = (name: string): boolean => {
    const property = properties[name];
    if (property === undefined) {
      return false;
    }
    if (property.type !== 'checkbox') {
      warn({ code: 'property_type_mismatch', property: name, type: property.type });
      return false;
    }
    return typeof property['checkbox'] === 'boolean' ? property['checkbox'] : false;
  };

  const due = readDateProperty(properties[binding.due_date.name], binding.due_date.name, {
    allowDateOnly: true,
    timezone: context.timezone,
    warn,
  });
  const reminder = readDateProperty(properties[binding.reminder_at.name], binding.reminder_at.name, {
    allowDateOnly: false,
    timezone: context.timezone,
    warn,
  });

  if (page.created_time !== undefined && parseInstant(page.created_time) === null) {
    warn({ code: 'invalid_page_time', property: 'created_time' });
  }
  if (page.last_edited_time !== undefined && parseInstant(page.last_edited_time) === null) {
    warn({ code: 'invalid_page_time', property: 'last_edited_time' });
  }

  for (const [name, property] of Object.entries(properties)) {
    const type = property?.type;
    if (typeof type !== 'string') {
      warn({ code: 'property_type_mismatch', property: name, type: 'missing-type' });
      continue;
    }
    if (!KNOWN_TYPES.has(type) && !KNOWN_UNMAPPED_TYPES.has(type)) {
      warn({ code: 'unknown_property_type', property: name, type });
    }
  }

  return {
    notionPageId: page.id,
    title: readTitle(),
    status: readStatus(),
    listName: readListName(),
    important: readCheckbox(binding.important.name),
    inMyDay: readCheckbox(binding.in_my_day.name),
    priority: readPriority(),
    dueDate: due.date,
    dueAt: due.at,
    reminderAt: reminder.at,
    userArchived: readCheckbox(binding.user_archived.name),
    notionIsArchived: page.is_archived === true,
    notionInTrash: page.in_trash === true || (page.in_trash === undefined && page.archived === true),
    isInSource: isPageInSource(page, context),
    pageUrl: typeof page.url === 'string' && page.url !== '' ? page.url : null,
    notionCreatedTime: parseInstant(page.created_time),
    notionLastEditedTime: parseInstant(page.last_edited_time),
    rawProperties: { ...properties },
  };
}

/** Types that are deliberately consumed by a typed column. */
const KNOWN_TYPES = new Set([
  'title',
  'status',
  'select',
  'checkbox',
  'date',
]);

function joinRichText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  let text = '';
  for (const item of value) {
    if (isRecord(item) && typeof item['plain_text'] === 'string') {
      text += item['plain_text'];
    }
  }
  return text;
}

function optionName(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = value['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface ReadDateOptions {
  readonly allowDateOnly: boolean;
  readonly timezone: string;
  readonly warn: (warning: Omit<NormalizeWarning, 'pageId'>) => void;
}

function readDateProperty(
  property: NotionPropertyValue | undefined,
  name: string,
  options: ReadDateOptions,
): { date: string | null; at: Date | null } {
  const empty = { date: null, at: null };
  if (property === undefined) {
    return empty;
  }
  if (property.type !== 'date') {
    options.warn({ code: 'property_type_mismatch', property: name, type: property.type });
    return empty;
  }

  const value = property['date'];
  if (value === null || value === undefined) {
    return empty;
  }
  if (!isRecord(value)) {
    options.warn({ code: 'invalid_date', property: name });
    return empty;
  }

  const start = value['start'];
  if (typeof start !== 'string' || start.trim() === '') {
    return empty;
  }

  const dateOnly = DATE_ONLY_PATTERN.exec(start);
  if (dateOnly !== null) {
    const [, year, month, day] = dateOnly;
    if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
      options.warn({ code: 'invalid_date', property: name });
      return empty;
    }
    if (!options.allowDateOnly) {
      options.warn({ code: 'reminder_date_only', property: name });
      return empty;
    }
    return { date: start, at: null };
  }

  const instant = parseDateTime(start, resolveTimeZone(value['time_zone'], options.timezone));
  if (instant === null) {
    options.warn({ code: 'invalid_date', property: name });
    return empty;
  }
  return { date: null, at: instant };
}

function resolveTimeZone(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Parse a Notion date `start` string into an instant.
 * - explicit `Z`/offset → the offset wins
 * - no offset → the wall-clock time is interpreted in the given IANA zone
 */
export function parseDateTime(value: string, timezone: string): Date | null {
  if (OFFSET_PATTERN.test(value)) {
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }

  const match = WALL_TIME_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] === undefined ? '0' : match[7];
  const millisecond = Number(`${fraction}000`.slice(0, 3));

  if (
    !isValidCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  try {
    return zonedWallTimeToUtc({ year, month, day, hour, minute, second, millisecond }, timezone);
  } catch {
    // An invalid IANA zone in a Notion property must not crash the run.
    return null;
  }
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * Convert a wall-clock time in `timezone` to UTC by measuring the zone's
 * offset at the candidate instant and iterating once across DST boundaries.
 */
function zonedWallTimeToUtc(wall: WallTime, timezone: string): Date {
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );

  let guess = asUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const offset = timezoneOffsetMs(guess, timezone);
    const next = asUtc - offset;
    if (next === guess) {
      break;
    }
    guess = next;
  }

  return new Date(guess);
}

function timezoneOffsetMs(utcMilliseconds: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(new Date(utcMilliseconds));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  const renderedAsUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  const wholeSeconds = Math.floor(utcMilliseconds / 1000) * 1000;
  return renderedAsUtc - wholeSeconds;
}

function normalizeId(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const compact = value.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact : null;
}

/**
 * Membership is derived from the fetched page's parent, never from a webhook
 * payload. Legacy `database_id` parents are accepted for the configured
 * container so an API-version change cannot mislabel every row as out of scope.
 */
function isPageInSource(page: NotionPageLike, context: NormalizeContext): boolean {
  const parent = page.parent;
  if (parent === undefined) {
    return false;
  }
  if (parent.type === 'data_source_id') {
    const parentId = normalizeId(parent.data_source_id);
    return parentId !== null && parentId === normalizeId(context.dataSourceId);
  }
  if (parent.type === 'database_id') {
    const parentId = normalizeId(parent.database_id);
    return parentId !== null && parentId === normalizeId(context.databaseId);
  }
  return false;
}
