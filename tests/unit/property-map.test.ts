import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROPERTY_NAMES,
  diffSchema,
  resolvePropertyMap,
  validatePropertyMap,
  type DataSourceSchema,
} from '../../sync/property-map.js';

function schema(properties: Record<string, string | { type: string }>): DataSourceSchema {
  return {
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [
        name,
        typeof value === 'string' ? { type: value } : value,
      ]),
    ),
  };
}

const DEFAULT_SCHEMA = schema({
  Name: 'title',
  Status: 'status',
  List: 'select',
  Important: 'checkbox',
  'In My Day': 'checkbox',
  Priority: 'select',
  'Due Date': 'date',
  Reminder: 'date',
  Archived: 'checkbox',
});

describe('resolvePropertyMap', () => {
  it('uses documented file defaults when no overrides are set', () => {
    const map = resolvePropertyMap({});

    expect(map.bindings.title.name).toBe(DEFAULT_PROPERTY_NAMES.title);
    expect(map.bindings.status.name).toBe('Status');
    expect(map.bindings.due_date.name).toBe('Due Date');
    expect(map.bindings.user_archived.expectedTypes).toEqual(['checkbox']);
  });

  it('lets environment variables override every default', () => {
    const map = resolvePropertyMap({
      NOTION_PROP_TITLE: 'Task',
      NOTION_PROP_STATUS: 'State',
      NOTION_PROP_LIST: 'Project',
      NOTION_PROP_IMPORTANT: 'Starred',
      NOTION_PROP_IN_MY_DAY: 'Today',
      NOTION_PROP_PRIORITY: 'Urgency',
      NOTION_PROP_DUE_DATE: 'Deadline',
      NOTION_PROP_REMINDER: 'Alert',
      NOTION_PROP_USER_ARCHIVED: 'Hidden',
    });

    expect(map.bindings.title.name).toBe('Task');
    expect(map.bindings.status.name).toBe('State');
    expect(map.bindings.list_name.name).toBe('Project');
    expect(map.bindings.important.name).toBe('Starred');
    expect(map.bindings.in_my_day.name).toBe('Today');
    expect(map.bindings.priority.name).toBe('Urgency');
    expect(map.bindings.due_date.name).toBe('Deadline');
    expect(map.bindings.reminder_at.name).toBe('Alert');
    expect(map.bindings.user_archived.name).toBe('Hidden');
  });

  it('ignores blank overrides instead of mapping an empty property name', () => {
    const map = resolvePropertyMap({ NOTION_PROP_TITLE: '   ' });

    expect(map.bindings.title.name).toBe(DEFAULT_PROPERTY_NAMES.title);
  });

  it('validates the resolved map against the live schema', () => {
    const result = validatePropertyMap(resolvePropertyMap({}), DEFAULT_SCHEMA);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports missing and renamed properties with expected and actual names', () => {
    const result = validatePropertyMap(
      resolvePropertyMap({}),
      schema({
        Name: 'title',
        State: 'status',
        List: 'select',
        Important: 'checkbox',
        'In My Day': 'checkbox',
        Priority: 'select',
        'Due Date': 'date',
        Reminder: 'date',
        Archived: 'checkbox',
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        column: 'status',
        name: 'Status',
        expected: ['status'],
        actual: 'missing',
      },
    ]);
  });

  it('reports a property whose type changed', () => {
    const result = validatePropertyMap(
      resolvePropertyMap({}),
      schema({ ...DEFAULT_SCHEMA.properties, Status: { type: 'select' } }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      column: 'status',
      name: 'Status',
      actual: 'select',
    });
  });

  it('accepts multi-select for list_name but flags it at normalization time, not startup', () => {
    const result = validatePropertyMap(
      resolvePropertyMap({}),
      schema({ ...DEFAULT_SCHEMA.properties, List: 'multi_select' }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('diffSchema', () => {
  it('reports added, removed and retyped properties by name only (U-29)', () => {
    const previous = schema({
      Name: 'title',
      Status: 'status',
      List: 'select',
      'Old Field': 'rich_text',
    });
    const next = schema({
      Name: 'title',
      Status: 'select',
      List: 'select',
      'New Field': 'number',
    });

    const diff = diffSchema(previous, next);

    expect(diff.added).toEqual(['New Field']);
    expect(diff.removed).toEqual(['Old Field']);
    expect(diff.retyped).toEqual([{ name: 'Status', from: 'status', to: 'select' }]);
  });

  it('returns an empty diff for identical schemas', () => {
    const diff = diffSchema(DEFAULT_SCHEMA, DEFAULT_SCHEMA);

    expect(diff).toEqual({ added: [], removed: [], retyped: [] });
  });
});
