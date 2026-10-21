import { describe, expect, it } from 'vitest';

import {
  normalizePage,
  type NormalizeContext,
  type NormalizeWarning,
  type NotionPageLike,
  type NotionPropertyValue,
} from '../../sync/normalize.js';
import { resolvePropertyMap } from '../../sync/property-map.js';

const DATA_SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const DATABASE_ID = '22222222-2222-4222-8222-222222222222';

function context(overrides: Partial<NormalizeContext> = {}): NormalizeContext & {
  warnings: NormalizeWarning[];
} {
  const warnings: NormalizeWarning[] = [];
  return {
    propertyMap: resolvePropertyMap({}),
    dataSourceId: DATA_SOURCE_ID,
    databaseId: DATABASE_ID,
    timezone: 'UTC',
    onWarning: (warning) => warnings.push(warning),
    warnings,
    ...overrides,
  };
}

function page(
  properties: Record<string, NotionPropertyValue>,
  overrides: Partial<NotionPageLike> = {},
): NotionPageLike {
  return {
    object: 'page',
    id: '33333333-3333-4333-8333-333333333333',
    url: 'https://www.notion.so/33333333333343338333333333333333',
    created_time: '2026-10-01T08:00:00.000Z',
    last_edited_time: '2026-10-20T12:34:56.000Z',
    in_trash: false,
    archived: false,
    is_archived: false,
    parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
    properties,
    ...overrides,
  };
}

const title = (text: string): NotionPropertyValue => ({
  id: 'title',
  type: 'title',
  title: text === '' ? [] : [{ plain_text: text }],
});

describe('normalizePage', () => {
  it('concatenates rich text in order and trims trailing whitespace only (U-01)', () => {
    const task = normalizePage(
      page({
        Name: {
          id: 'title',
          type: 'title',
          title: [
            { plain_text: '  Buy ' },
            { plain_text: 'oat ' },
            { plain_text: 'milk   ' },
          ],
        } as NotionPropertyValue,
      }),
      context(),
    );

    expect(task.title).toBe('  Buy oat milk');
  });

  it('uses the displayed status label without validating it against a list (U-02)', () => {
    const task = normalizePage(
      page({
        Name: title('Task'),
        Status: { id: 's', type: 'status', status: { id: 'x', name: 'Waiting on review' } },
      }),
      context(),
    );

    expect(task.status).toBe('Waiting on review');
  });

  it('reads select option names and nulls empty selects (U-03)', () => {
    const withValue = normalizePage(
      page({
        Name: title('Task'),
        List: { id: 'l', type: 'select', select: { id: 'x', name: 'Work' } },
      }),
      context(),
    );
    const empty = normalizePage(
      page({
        Name: title('Task'),
        List: { id: 'l', type: 'select', select: null },
      }),
      context(),
    );

    expect(withValue.listName).toBe('Work');
    expect(empty.listName).toBeNull();
  });

  it('maps checkbox true, false and absent to booleans (U-04)', () => {
    const on = normalizePage(
      page({ Name: title('A'), Important: { type: 'checkbox', checkbox: true } }),
      context(),
    );
    const off = normalizePage(
      page({ Name: title('B'), Important: { type: 'checkbox', checkbox: false } }),
      context(),
    );
    const absent = normalizePage(page({ Name: title('C') }), context());

    expect(on.important).toBe(true);
    expect(off.important).toBe(false);
    expect(absent.important).toBe(false);
  });

  it('never flattens multi-select into text and warns when mapped to a text column (U-05)', () => {
    const ctx = context();
    const task = normalizePage(
      page({
        Name: title('Task'),
        List: {
          type: 'multi_select',
          multi_select: [{ id: 'a', name: 'Work' }, { id: 'b', name: 'Home' }],
        },
      }),
      ctx,
    );

    expect(task.listName).toBeNull();
    expect(task.rawProperties.List).toEqual({
      type: 'multi_select',
      multi_select: [{ id: 'a', name: 'Work' }, { id: 'b', name: 'Home' }],
    });
    expect(ctx.warnings).toEqual([
      expect.objectContaining({ code: 'multi_select_not_flattenable', property: 'List' }),
    ]);
  });

  it('stores date-only values as DATE strings and time-bearing values as instants (U-06, U-07)', () => {
    const dateOnly = normalizePage(
      page({ Name: title('Task'), 'Due Date': { type: 'date', date: { start: '2026-10-21', end: null, time_zone: null } } }),
      context(),
    );
    const timed = normalizePage(
      page({
        Name: title('Task'),
        'Due Date': {
          type: 'date',
          date: { start: '2026-10-21T10:30:00.000+02:00', end: null, time_zone: 'Europe/Berlin' },
        },
      }),
      context(),
    );

    expect(dateOnly.dueDate).toBe('2026-10-21');
    expect(dateOnly.dueAt).toBeNull();
    expect(timed.dueDate).toBeNull();
    expect(timed.dueAt?.toISOString()).toBe('2026-10-21T08:30:00.000Z');
  });

  it('interprets offset-less datetimes in SYNC_TIMEZONE (U-08)', () => {
    const task = normalizePage(
      page({
        Name: title('Task'),
        'Due Date': {
          type: 'date',
          date: { start: '2026-10-21T10:30:00.000', end: null, time_zone: null },
        },
      }),
      context({ timezone: 'America/New_York' }),
    );

    expect(task.dueAt?.toISOString()).toBe('2026-10-21T14:30:00.000Z');
  });

  it('prefers the property time zone over SYNC_TIMEZONE', () => {
    const task = normalizePage(
      page({
        Name: title('Task'),
        'Due Date': {
          type: 'date',
          date: { start: '2026-10-21T10:30:00', end: null, time_zone: 'Asia/Tokyo' },
        },
      }),
      context({ timezone: 'America/New_York' }),
    );

    expect(task.dueAt?.toISOString()).toBe('2026-10-21T01:30:00.000Z');
  });

  it('preserves unknown property types without throwing (U-09)', () => {
    const ctx = context();
    const task = normalizePage(
      page({
        Name: title('Task'),
        'Some New Type': { type: 'future_widget', future_widget: { pressed: true } } as NotionPropertyValue,
      }),
      ctx,
    );

    expect(task.title).toBe('Task');
    expect(task.rawProperties['Some New Type']).toEqual({
      type: 'future_widget',
      future_widget: { pressed: true },
    });
    expect(ctx.warnings).toEqual([
      expect.objectContaining({
        code: 'unknown_property_type',
        property: 'Some New Type',
        type: 'future_widget',
      }),
    ]);
  });

  it('keeps missing, null and empty properties distinct (U-14)', () => {
    const ctx = context();
    const missing = normalizePage(page({ Name: title('Missing') }), ctx);
    const nulled = normalizePage(
      page({
        Name: title('Nulled'),
        Status: { type: 'status', status: null },
        List: { type: 'select', select: null },
      }),
      ctx,
    );

    expect(missing.status).toBeNull();
    expect(missing.rawProperties.Status).toBeUndefined();

    expect(nulled.status).toBeNull();
    expect(nulled.listName).toBeNull();
    expect(nulled.rawProperties.Status).toEqual({ type: 'status', status: null });
    expect(nulled.rawProperties.List).toEqual({ type: 'select', select: null });
  });

  it('treats an empty title as empty string and absent optional rich text as NULL', () => {
    const task = normalizePage(page({ Name: title('') }), context());

    expect(task.title).toBe('');
  });

  it('does not shift date-only values for positive or negative UTC offsets (U-10, U-11, U-12)', () => {
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York']) {
      const task = normalizePage(
        page({
          Name: title('Task'),
          'Due Date': { type: 'date', date: { start: '2026-03-08', end: null, time_zone: null } },
        }),
        context({ timezone }),
      );
      expect(task.dueDate).toBe('2026-03-08');
      expect(task.dueAt).toBeNull();
    }
  });

  it('turns a date-only reminder into NULL plus a warning (U-13)', () => {
    const ctx = context();
    const task = normalizePage(
      page({
        Name: title('Task'),
        Reminder: { type: 'date', date: { start: '2026-10-21', end: null, time_zone: null } },
      }),
      ctx,
    );

    expect(task.reminderAt).toBeNull();
    expect(ctx.warnings).toEqual([
      expect.objectContaining({ code: 'reminder_date_only', property: 'Reminder' }),
    ]);
  });

  it('derives is_in_source from the fetched parent, including legacy database parents (U-28)', () => {
    const inSource = normalizePage(page({ Name: title('A') }), context());
    const otherSource = normalizePage(
      page(
        { Name: title('B') },
        { parent: { type: 'data_source_id', data_source_id: '99999999-9999-4999-8999-999999999999' } },
      ),
      context(),
    );
    const legacyDatabase = normalizePage(
      page({ Name: title('C') }, { parent: { type: 'database_id', database_id: DATABASE_ID } }),
      context(),
    );
    const otherPage = normalizePage(
      page({ Name: title('D') }, { parent: { type: 'page_id', page_id: '88888888-8888-4888-8888-888888888888' } }),
      context(),
    );

    expect(inSource.isInSource).toBe(true);
    expect(otherSource.isInSource).toBe(false);
    expect(legacyDatabase.isInSource).toBe(true);
    expect(otherPage.isInSource).toBe(false);
  });

  it('maps page-level archive/trash independently from the custom Archived checkbox', () => {
    const task = normalizePage(
      page(
        { Name: title('Task'), Archived: { type: 'checkbox', checkbox: true } },
        { in_trash: true, is_archived: true, archived: true },
      ),
      context(),
    );

    expect(task.userArchived).toBe(true);
    expect(task.notionIsArchived).toBe(true);
    expect(task.notionInTrash).toBe(true);
  });

  it('copies page metadata and timestamps without inventing a completion time', () => {
    const task = normalizePage(page({ Name: title('Task') }), context());

    expect(task.notionPageId).toBe('33333333-3333-4333-8333-333333333333');
    expect(task.pageUrl).toContain('notion.so');
    expect(task.notionCreatedTime?.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(task.notionLastEditedTime?.toISOString()).toBe('2026-10-20T12:34:56.000Z');
    expect(Object.keys(task)).not.toContain('completedAt');
  });

  it('preserves the entire raw properties object verbatim', () => {
    const properties = {
      Name: title('Task'),
      Status: { type: 'status', status: { id: 'x', name: 'Todo' } },
      Tags: { type: 'multi_select', multi_select: [{ id: 'a', name: 'one' }] },
    };
    const task = normalizePage(page(properties), context());

    expect(task.rawProperties).toEqual(properties);
  });

  it('emits at most one warning per property regardless of nested shape', () => {
    const ctx = context();
    normalizePage(
      page({
        Name: title('Task'),
        Weird: { type: 'weird_type', weird_type: { a: 1 } } as NotionPropertyValue,
        Weird2: { type: 'weird_type', weird_type: { a: 2 } } as NotionPropertyValue,
      }),
      ctx,
    );

    expect(ctx.warnings.filter((warning) => warning.code === 'unknown_property_type')).toHaveLength(2);
  });

  it('never throws for malformed property values', () => {
    const ctx = context();
    const task = normalizePage(
      page({
        Name: { type: 'title', title: null } as unknown as NotionPropertyValue,
        Status: { type: 'status' } as unknown as NotionPropertyValue,
        'Due Date': { type: 'date', date: { start: 'not-a-date' } } as unknown as NotionPropertyValue,
      }),
      ctx,
    );

    expect(task.title).toBe('');
    expect(task.status).toBeNull();
    expect(task.dueDate).toBeNull();
    expect(task.dueAt).toBeNull();
    expect(ctx.warnings.map((warning) => warning.code)).toContain('invalid_date');
  });
});
