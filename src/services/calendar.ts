import type { Config } from "../config.js";
import { InfomaniakAPI } from "./infomaniak-api.js";

interface ApiResponse {
  data?: unknown;
}

interface Calendar {
  id: string;
  name: string;
  color?: string;
  [key: string]: unknown;
}

interface CalendarEvent {
  id: string;
  calendar_id?: string | number;
  uid?: string;
  type?: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  fullday?: boolean;
  timezone_start?: string;
  timezone_end?: string;
  freebusy?: string;
  attendees?: Attendee[];
  rrule?: string | null;
  reminders?: Reminder[];
  [key: string]: unknown;
}

interface Attendee {
  address: string;
  name?: string;
  state?: string;
  organizer?: boolean;
  className?: string;
}

interface Reminder {
  minutes_before: number;
}

export interface ListEventsOptions {
  calendarId?: string;
  allCalendars?: boolean;
  query?: string;
  fields?: string[];
}

export interface CompactEvent {
  id: string;
  calendar_id?: string | number;
  title: string;
  start: string;
  end: string;
  fullday?: boolean;
  location?: string;
  description?: string;
  description_truncated?: boolean;
  status: string | null;
  organizer: string | null;
  attendees: Array<Pick<Attendee, "address" | "name" | "state" | "organizer">>;
  my_response: string | null;
  rrule?: string | null;
  recurrence_id?: unknown;
  has_video_conference_link?: boolean;
  meet_room_url?: string | null;
}

const COMPACT_DESCRIPTION_MAX_CHARS = 400;

export class CalendarService {
  private api: InfomaniakAPI;
  private timezone: string | null = null;
  private userEmail: string | null = null;
  private calendarCache: { calendars: Calendar[]; expiresAt: number } | null = null;
  private readonly calendarCacheMs = 60_000;

  constructor(config: Config) {
    this.api = new InfomaniakAPI(config);
  }

  private async getUserProfile(): Promise<{ timezone: string; email: string }> {
    if (this.timezone && this.userEmail) {
      return { timezone: this.timezone, email: this.userEmail };
    }
    const res = (await this.api.get("/2/profile")) as ApiResponse;
    const profile = res.data as Record<string, unknown>;
    const preferences = profile.preferences as Record<string, unknown> | undefined;
    const timezonePreference = preferences?.timezone as Record<string, unknown> | undefined;
    this.timezone = (timezonePreference?.name as string) ?? "Europe/Zurich";
    this.userEmail = (profile.email as string) ?? "";
    return { timezone: this.timezone, email: this.userEmail };
  }

  async listCalendars(): Promise<Calendar[]> {
    if (this.calendarCache && this.calendarCache.expiresAt > Date.now()) {
      return this.calendarCache.calendars;
    }

    const res = (await this.api.get(
      "/1/calendar/pim/calendar"
    )) as ApiResponse;
    const data = (res.data ?? {}) as { calendars?: Calendar[] };
    const calendars = data.calendars ?? [];
    this.calendarCache = { calendars, expiresAt: Date.now() + this.calendarCacheMs };
    return calendars;
  }

  async listEvents(from: string, to: string, options: ListEventsOptions = {}): Promise<Array<CompactEvent | Record<string, unknown>>> {
    const calendars = options.calendarId
      ? [{ id: options.calendarId }]
      : options.allCalendars
        ? await this.listCalendars()
        : [await this.defaultCalendar()];

    const eventGroups = await Promise.all(calendars.map(async (cal) => {
      const res = (await this.api.get("/1/calendar/pim/event", {
        calendar_id: String(cal.id),
        from: formatDateForApi(from),
        to: formatDateForApi(to),
        with: "attendees",
      })) as ApiResponse;
      return (res.data ?? []) as CalendarEvent[];
    }));

    const query = options.query?.trim().toLowerCase();
    const events = eventGroups.flat().filter((event) => !query || eventMatchesQuery(event, query));
    if (options.fields?.length) {
      return events.map((event) => pickFields(event, options.fields!));
    }
    const { email } = await this.getUserProfile();
    return events.map((event) => compactEvent(event, email));
  }

  async getEvent(eventId: string): Promise<CalendarEvent> {
    const res = (await this.api.get(`/1/calendar/pim/event/${eventId}`)) as ApiResponse;
    return res.data as CalendarEvent;
  }

  private async defaultCalendar(): Promise<Calendar> {
    const calendars = await this.listCalendars();
    const calendar = calendars.find((entry) => entry.default === true) ?? calendars[0];
    if (!calendar) {
      throw new Error("No calendars found.");
    }
    return calendar;
  }

  async createEvent(params: {
    title: string;
    start: string;
    end: string;
    description?: string;
    calendarId?: string;
    attendees?: string[];
    fullDay?: boolean;
    recurrenceRule?: string;
    reminderMinutes?: number[];
  }): Promise<CalendarEvent> {
    const { timezone, email } = await this.getUserProfile();
    const calendars = await this.listCalendars();
    const calendarId = params.calendarId ?? String(calendars[0]?.id);

    const attendeeList: Attendee[] = [
      { address: email, className: "Organizer", name: email, organizer: true, state: "ACCEPTED" },
    ];
    if (params.attendees) {
      for (const addr of params.attendees) {
        attendeeList.push({
          address: addr,
          className: "Attendee",
          name: addr,
          organizer: false,
          state: "NEEDS-ACTION",
        });
      }
    }

    const body = {
      title: params.title,
      start: formatDateForApi(params.start),
      end: formatDateForApi(params.end),
      description: params.description ?? "",
      freebusy: "busy",
      type: "event",
      calendar_id: calendarId,
      fullday: params.fullDay ?? false,
      timezone_start: timezone,
      timezone_end: timezone,
      attendees: attendeeList,
    };
    addRecurrenceAndReminders(body, {
      recurrenceRule: params.recurrenceRule,
      reminderMinutes: params.reminderMinutes,
    });

    const res = (await this.api.post("/1/calendar/pim/event", body)) as ApiResponse;
    return res.data as CalendarEvent;
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.api.delete(`/1/calendar/pim/event/${eventId}`);
  }

  async updateEvent(eventId: string, params: {
    title?: string;
    start?: string;
    end?: string;
    description?: string;
    recurrenceRule?: string;
    clearRecurrence?: boolean;
    reminderMinutes?: number[];
    clearReminders?: boolean;
  }): Promise<CalendarEvent> {
    const { timezone } = await this.getUserProfile();
    const current = await this.getEvent(eventId);

    const body: Record<string, unknown> = {
      title: normalizeString(params.title ?? current.title, current.title, "Untitled"),
      start: formatDateForApi(params.start ?? current.start),
      end: formatDateForApi(params.end ?? current.end),
      description: normalizeString(params.description ?? current.description, "", ""),
      type: normalizeString(current.type, "event", "event"),
      fullday: current.fullday ?? false,
      timezone_start: normalizeString(current.timezone_start, timezone, timezone),
      timezone_end: normalizeString(current.timezone_end, timezone, timezone),
    };

    const freebusy = normalizeOptionalString(current.freebusy);
    if (freebusy !== undefined) body.freebusy = freebusy;
    addRecurrenceAndReminders(body, {
      recurrenceRule: params.recurrenceRule,
      clearRecurrence: params.clearRecurrence,
      fallbackRecurrenceRule: current.rrule,
      reminderMinutes: params.reminderMinutes,
      clearReminders: params.clearReminders,
      fallbackReminders: current.reminders,
    });

    const res = (await this.api.put(`/1/calendar/pim/event/${eventId}`, body)) as ApiResponse;
    return res.data as CalendarEvent;
  }

}

function eventMatchesQuery(event: CalendarEvent, query: string): boolean {
  return [event.title, event.description, event.location]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(query));
}

function pickFields(event: CalendarEvent, fields: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = { id: event.id };
  for (const field of fields) {
    if (field in event) picked[field] = event[field];
  }
  return picked;
}

function compactEvent(event: CalendarEvent, userEmail: string): CompactEvent {
  const attendees = (event.attendees ?? []).map(({ address, name, state, organizer }) => ({ address, name, state, organizer }));
  const own = attendees.find((attendee) => attendee.address.toLowerCase() === userEmail.toLowerCase());
  const description = typeof event.description === "string" ? event.description : "";
  const compact: CompactEvent = {
    id: event.id,
    calendar_id: event.calendar_id,
    title: event.title,
    start: event.start,
    end: event.end,
    fullday: event.fullday,
    location: typeof event.location === "string" ? event.location : undefined,
    description: description.slice(0, COMPACT_DESCRIPTION_MAX_CHARS),
    status: typeof event.status === "string" ? event.status : null,
    organizer: typeof event.organizer === "string" ? event.organizer : null,
    attendees,
    my_response: own?.state ?? null,
    rrule: event.rrule,
    recurrence_id: event.recurrence_id,
    has_video_conference_link: event.has_video_conference_link as boolean | undefined,
    meet_room_url: event.meet_room_url as string | null | undefined,
  };
  if (description.length > COMPACT_DESCRIPTION_MAX_CHARS) {
    compact.description_truncated = true;
  }
  return compact;
}

/**
 * Format a date string for the Infomaniak Calendar API.
 * Accepts ISO 8601 or "YYYY-MM-DD HH:mm" format.
 * Returns "YYYY-MM-DD HH:mm" format.
 *
 * Uses regex parsing to avoid timezone conversion issues
 * (Date constructor would convert to local timezone).
 */
function formatDateForApi(dateStr: string): string {
  // If already in "YYYY-MM-DD HH:mm:ss" format, pass through
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Accept "YYYY-MM-DD HH:mm" and add seconds
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dateStr)) {
    return `${dateStr}:00`;
  }

  // Try ISO 8601 regex: "2025-01-15T09:00:00", "2025-01-15T09:00:00Z", "2025-01-15T09:00:00+02:00"
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]} ${isoMatch[4]}:${isoMatch[5]}:${isoMatch[6] ?? "00"}`;
  }

  // Date-only: "2025-01-15" → midnight
  const dateOnlyMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    return `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]} 00:00:00`;
  }

  // Last resort: pass through and let the API handle it
  return dateStr;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return undefined;
  }
  return String(value);
}

function normalizeString(value: unknown, fallback: string, defaultValue: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized !== undefined) {
    return normalized;
  }
  if (fallback.length > 0) {
    return fallback;
  }
  return defaultValue;
}

function addRecurrenceAndReminders(
  body: Record<string, unknown>,
  options: {
    recurrenceRule?: string;
    clearRecurrence?: boolean;
    fallbackRecurrenceRule?: string | null;
    reminderMinutes?: number[];
    clearReminders?: boolean;
    fallbackReminders?: Reminder[];
  }
): void {
  if (options.clearRecurrence) {
    body.rrule = null;
  } else if (options.recurrenceRule !== undefined) {
    body.rrule = normalizeRecurrenceRule(options.recurrenceRule);
  } else if (typeof options.fallbackRecurrenceRule === "string" && options.fallbackRecurrenceRule.length > 0) {
    body.rrule = options.fallbackRecurrenceRule;
  }

  if (options.clearReminders) {
    body.reminders = [];
  } else if (options.reminderMinutes !== undefined) {
    body.reminders = normalizeReminderMinutes(options.reminderMinutes);
  } else if (options.fallbackReminders !== undefined) {
    body.reminders = options.fallbackReminders;
  }
}

function normalizeRecurrenceRule(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Recurrence rule must not be empty.");
  }
  return trimmed.toUpperCase().startsWith("RRULE:")
    ? trimmed.slice("RRULE:".length)
    : trimmed;
}

function normalizeReminderMinutes(values: number[]): Reminder[] {
  return [...new Set(values.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Reminder minutes must be zero or a positive number.");
    }
    return Math.floor(value);
  }))].sort((left, right) => left - right).map((minutes) => ({ minutes_before: minutes }));
}
