/**
 * Property mapping is configuration, not a constant: PRD §19.3 leaves the
 * workspace's actual property names unconfirmed. Resolution order is
 * environment override → documented default, and the result is validated
 * against the live data-source schema before a sync run starts.
 */

export const PROPERTY_COLUMNS = [
  'title',
  'status',
  'list_name',
  'important',
  'in_my_day',
  'priority',
  'due_date',
  'reminder_at',
  'user_archived',
] as const;

export type MappedColumn = (typeof PROPERTY_COLUMNS)[number];

export interface PropertyBinding {
  readonly column: MappedColumn;
  readonly name: string;
  /** Notion property types that can legally feed this column. */
  readonly expectedTypes: readonly string[];
}

export interface PropertyMap {
  readonly bindings: Readonly<Record<MappedColumn, PropertyBinding>>;
}

/** Column defaults. Every one can be overridden with the env var below. */
export const DEFAULT_PROPERTY_NAMES: Readonly<Record<MappedColumn, string>> = Object.freeze({
  title: 'Name',
  status: 'Status',
  list_name: 'List',
  important: 'Important',
  in_my_day: 'In My Day',
  priority: 'Priority',
  due_date: 'Due Date',
  reminder_at: 'Reminder',
  user_archived: 'Archived',
});

export const PROPERTY_ENV_VARS: Readonly<Record<MappedColumn, string>> = Object.freeze({
  title: 'NOTION_PROP_TITLE',
  status: 'NOTION_PROP_STATUS',
  list_name: 'NOTION_PROP_LIST',
  important: 'NOTION_PROP_IMPORTANT',
  in_my_day: 'NOTION_PROP_IN_MY_DAY',
  priority: 'NOTION_PROP_PRIORITY',
  due_date: 'NOTION_PROP_DUE_DATE',
  reminder_at: 'NOTION_PROP_REMINDER',
  user_archived: 'NOTION_PROP_USER_ARCHIVED',
});

/**
 * `multi_select` is accepted for `list_name` at startup so an existing
 * workspace does not fail to boot; normalization writes NULL and warns
 * because flattening several labels into one text column loses data.
 */
const EXPECTED_TYPES: Readonly<Record<MappedColumn, readonly string[]>> = Object.freeze({
  title: ['title'],
  status: ['status'],
  list_name: ['select', 'multi_select'],
  important: ['checkbox'],
  in_my_day: ['checkbox'],
  priority: ['select', 'status'],
  due_date: ['date'],
  reminder_at: ['date'],
  user_archived: ['checkbox'],
});

export interface DataSourceSchema {
  readonly properties: Readonly<Record<string, { readonly type?: string } | undefined>>;
}

export interface PropertyMapIssue {
  readonly column: MappedColumn;
  readonly name: string;
  readonly expected: readonly string[];
  /** The Notion property type, or `missing`. */
  readonly actual: string;
}

export type PropertyMapValidation =
  | { readonly ok: true; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly PropertyMapIssue[] };

export interface SchemaDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly retyped: ReadonlyArray<{ readonly name: string; readonly from: string; readonly to: string }>;
}

export function resolvePropertyMap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PropertyMap {
  const bindings = {} as Record<MappedColumn, PropertyBinding>;

  for (const column of PROPERTY_COLUMNS) {
    const override = env[PROPERTY_ENV_VARS[column]];
    const name = typeof override === 'string' && override.trim() !== ''
      ? override.trim()
      : DEFAULT_PROPERTY_NAMES[column];

    bindings[column] = Object.freeze({
      column,
      name,
      expectedTypes: EXPECTED_TYPES[column],
    });
  }

  return Object.freeze({ bindings: Object.freeze(bindings) });
}

/**
 * Compare the configured map with the live schema. A renamed or retyped
 * property must fail startup rather than silently writing NULL forever.
 */
export function validatePropertyMap(map: PropertyMap, schema: DataSourceSchema): PropertyMapValidation {
  const issues: PropertyMapIssue[] = [];

  for (const column of PROPERTY_COLUMNS) {
    const binding = map.bindings[column];
    const property = schema.properties[binding.name];
    const actual = property?.type ?? 'missing';

    if (!binding.expectedTypes.includes(actual)) {
      issues.push({
        column,
        name: binding.name,
        expected: binding.expectedTypes,
        actual,
      });
    }
  }

  if (issues.length === 0) {
    return { ok: true, issues: [] };
  }
  return { ok: false, issues };
}

export function formatPropertyIssues(issues: readonly PropertyMapIssue[]): string {
  return issues
    .map(
      (issue) =>
        `${issue.column}: expected property "${issue.name}" of type ${issue.expected.join('|')}, got ${issue.actual}`,
    )
    .join('; ');
}

/** Report schema drift by name/type only. Never emits values or IDs. */
export function diffSchema(previous: DataSourceSchema, next: DataSourceSchema): SchemaDiff {
  const previousNames = Object.keys(previous.properties);
  const nextNames = Object.keys(next.properties);

  const added = nextNames
    .filter((name) => !Object.prototype.hasOwnProperty.call(previous.properties, name))
    .sort();
  const removed = previousNames
    .filter((name) => !Object.prototype.hasOwnProperty.call(next.properties, name))
    .sort();

  const retyped: Array<{ name: string; from: string; to: string }> = [];
  for (const name of nextNames) {
    const before = previous.properties[name]?.type;
    const after = next.properties[name]?.type;
    if (before !== undefined && after !== undefined && before !== after) {
      retyped.push({ name, from: before, to: after });
    }
  }
  retyped.sort((left, right) => left.name.localeCompare(right.name));

  return { added, removed, retyped };
}
