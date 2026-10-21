/**
 * The normalized task shape shared by `sync/` (producer) and `db/` (consumer).
 * It lives in `src/` so the dependency direction in SPEC §2.3 stays one-way:
 * `db/` may import `src/`, never `sync/`.
 */
export interface NormalizedTask {
  readonly notionPageId: string;
  readonly title: string;
  readonly status: string | null;
  readonly listName: string | null;
  readonly important: boolean;
  readonly inMyDay: boolean;
  readonly priority: string | null;
  /** `YYYY-MM-DD` for date-only values; never a Date (no timezone can shift it). */
  readonly dueDate: string | null;
  readonly dueAt: Date | null;
  readonly reminderAt: Date | null;
  readonly userArchived: boolean;
  readonly notionIsArchived: boolean;
  readonly notionInTrash: boolean;
  readonly isInSource: boolean;
  readonly pageUrl: string | null;
  readonly notionCreatedTime: Date | null;
  readonly notionLastEditedTime: Date | null;
  readonly rawProperties: Record<string, unknown>;
}
