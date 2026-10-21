export interface PropertyNameMapping {
  title?: string;
  status?: string;
  list?: string;
  important?: string;
  inMyDay?: string;
  priority?: string;
  dueDate?: string;
  reminder?: string;
  userArchived?: string;
}

export const DEFAULT_PROPERTY_MAP: Required<PropertyNameMapping> = {
  title: "Task",
  status: "Status",
  list: "List",
  important: "Important",
  inMyDay: "In My Day",
  priority: "Priority",
  dueDate: "Due Date",
  reminder: "Reminder",
  userArchived: "Archived",
};

/**
 * Finds a property in the properties object using candidate names (case-insensitive).
 */
export function findProperty(
  properties: Record<string, any>,
  preferredName: string,
  alternatives: string[] = []
): { name: string; value: any } | null {
  const candidates = [preferredName, ...alternatives].map((c) => c.toLowerCase().trim());

  for (const [key, value] of Object.entries(properties)) {
    if (candidates.includes(key.toLowerCase().trim())) {
      return { name: key, value };
    }
  }

  return null;
}
