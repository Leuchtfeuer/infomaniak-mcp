import test from "node:test";
import assert from "node:assert/strict";

import { CalendarService } from "../dist/services/calendar.js";

function jsonResponse(body, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    headers: { get: () => "application/json" },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function makeConfig() {
  return {
    infomaniakToken: "calendar-token",
    mailToken: "",
    kdriveId: "",
    aiProductId: "",
    mailUser: "",
    mailPassword: "",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 587,
    davUser: "",
    davPassword: "",
    cardDavUrl: "",
    calDavUrl: "",
    enableExperimentalSwissTransfer: false,
    kchatToken: "",
    kchatTeamName: "",
  };
}

const profileResponse = {
  result: "success",
  data: {
    email: "user@example.com",
    preferences: { timezone: { name: "Europe/Oslo" } },
  },
};

const calendarsResponse = {
  result: "success",
  data: {
    calendars: [
      { id: "cal-2", name: "Shared" },
      { id: "cal-1", name: "Work", default: true },
    ],
  },
};

const longDescription = "Teams dial-in ".repeat(60);

const rawEvents = [
  {
    id: "event-1",
    calendar_id: "cal-1",
    title: "Kundentermin Big Dutchman",
    start: "2026-06-10 09:00:00",
    end: "2026-06-10 10:00:00",
    description: longDescription,
    location: "Teams",
    fullday: false,
    status: "CONFIRMED",
    organizer: "boss@example.com",
    origin_attendee_email: "user@example.com",
    attendees: [
      { address: "user@example.com", name: "User", state: "ACCEPTED", organizer: false, user_id: 1 },
      { address: "boss@example.com", name: "Boss", state: "ACCEPTED", organizer: true, user_id: 2 },
      { address: "guest@example.com", name: "Guest", state: "NEEDS-ACTION", organizer: false, user_id: null },
    ],
    raw: null,
    alarms: [],
    attachments: [],
    recurrence_exceptions: [],
    specific_oc: null,
  },
  {
    id: "event-2",
    calendar_id: "cal-1",
    title: "Lunch",
    start: "2026-06-10 12:00:00",
    end: "2026-06-10 13:00:00",
    description: "",
    status: null,
    organizer: null,
    attendees: [],
    raw: null,
  },
];

function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("CalendarService lists the default calendar with attendees unless all calendars are requested", async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/2/profile")) return jsonResponse(profileResponse);
    if (String(url).endsWith("/1/calendar/pim/calendar")) return jsonResponse(calendarsResponse);
    if (String(url).includes("/1/calendar/pim/event?")) return jsonResponse({ result: "success", data: [] });
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    await calendar.listEvents("2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z");
    await calendar.listEvents("2026-06-03T00:00:00Z", "2026-06-04T00:00:00Z");

    const eventCalls = calls.filter((url) => url.includes("/1/calendar/pim/event?"));
    assert.equal(calls.filter((url) => url.endsWith("/1/calendar/pim/calendar")).length, 1);
    assert.equal(eventCalls.length, 2);
    for (const url of eventCalls) {
      assert.ok(url.includes("calendar_id=cal-1"), `default calendar used: ${url}`);
      assert.ok(url.includes("with=attendees"), `attendees requested: ${url}`);
    }

    await calendar.listEvents("2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z", { allCalendars: true });
    assert.equal(calls.filter((url) => url.includes("/1/calendar/pim/event?")).length, 4);
  });
});

test("CalendarService returns compact events with organizer, attendees and the user's own response", async () => {
  await withFetch(async (url) => {
    if (String(url).endsWith("/2/profile")) return jsonResponse(profileResponse);
    if (String(url).endsWith("/1/calendar/pim/calendar")) return jsonResponse(calendarsResponse);
    if (String(url).includes("/1/calendar/pim/event?")) return jsonResponse({ result: "success", data: rawEvents });
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    const events = await calendar.listEvents("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z");

    assert.equal(events.length, 2);
    const [meeting, lunch] = events;
    assert.equal(meeting.organizer, "boss@example.com");
    assert.equal(meeting.my_response, "ACCEPTED");
    assert.deepEqual(meeting.attendees, [
      { address: "user@example.com", name: "User", state: "ACCEPTED", organizer: false },
      { address: "boss@example.com", name: "Boss", state: "ACCEPTED", organizer: true },
      { address: "guest@example.com", name: "Guest", state: "NEEDS-ACTION", organizer: false },
    ]);
    assert.equal("raw" in meeting, false);
    assert.equal("alarms" in meeting, false);
    assert.ok(meeting.description.length < longDescription.length);
    assert.equal(meeting.description_truncated, true);
    assert.equal(meeting.location, "Teams");

    assert.equal(lunch.organizer, null);
    assert.equal(lunch.my_response, null);
    assert.deepEqual(lunch.attendees, []);
    assert.equal(lunch.description_truncated, undefined);
  });
});

test("CalendarService filters events by query on title, description and location", async () => {
  await withFetch(async (url) => {
    if (String(url).endsWith("/2/profile")) return jsonResponse(profileResponse);
    if (String(url).endsWith("/1/calendar/pim/calendar")) return jsonResponse(calendarsResponse);
    if (String(url).includes("/1/calendar/pim/event?")) return jsonResponse({ result: "success", data: rawEvents });
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    const byTitle = await calendar.listEvents("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z", { query: "big dutchman" });
    assert.deepEqual(byTitle.map((event) => event.id), ["event-1"]);
    const byLocation = await calendar.listEvents("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z", { query: "teams" });
    assert.deepEqual(byLocation.map((event) => event.id), ["event-1"]);
    const none = await calendar.listEvents("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z", { query: "dinner" });
    assert.deepEqual(none, []);
  });
});

test("CalendarService returns only the requested raw fields when fields are given", async () => {
  await withFetch(async (url) => {
    if (String(url).endsWith("/2/profile")) return jsonResponse(profileResponse);
    if (String(url).endsWith("/1/calendar/pim/calendar")) return jsonResponse(calendarsResponse);
    if (String(url).includes("/1/calendar/pim/event?")) return jsonResponse({ result: "success", data: rawEvents });
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    const events = await calendar.listEvents("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z", { fields: ["title", "description"] });
    assert.deepEqual(Object.keys(events[0]).sort(), ["description", "id", "title"]);
    assert.equal(events[0].description, longDescription);
  });
});

test("CalendarService fetches a single event by id with all fields", async () => {
  const calls = [];
  await withFetch(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/1/calendar/pim/event/event-1")) {
      return jsonResponse({ result: "success", data: rawEvents[0] });
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    const event = await calendar.getEvent("event-1");
    assert.equal(event.id, "event-1");
    assert.equal(event.attendees.length, 3);
    assert.equal(event.organizer, "boss@example.com");
    assert.equal("raw" in event, true);
    assert.equal(calls.length, 1);
  });
});

test("CalendarService sends recurrence rules and reminder offsets when creating and updating events", async () => {
  const calls = [];
  await withFetch(async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/2/profile")) return jsonResponse(profileResponse);
    if (String(url).endsWith("/1/calendar/pim/calendar")) return jsonResponse(calendarsResponse);
    if (String(url).endsWith("/1/calendar/pim/event") && options.method === "POST") {
      return jsonResponse({ result: "success", data: { id: "event-1", title: "Standup" } });
    }
    if (String(url).endsWith("/1/calendar/pim/event/event-1") && options.method === "PUT") {
      return jsonResponse({ result: "success", data: { id: "event-1", title: "Updated standup" } });
    }
    if (String(url).endsWith("/1/calendar/pim/event/event-1")) {
      return jsonResponse({
        result: "success",
        data: {
          id: "event-1",
          title: "Standup",
          start: "2026-06-10 09:00:00",
          end: "2026-06-10 09:15:00",
          description: "",
          type: "event",
          fullday: false,
          timezone_start: "Europe/Oslo",
          timezone_end: "Europe/Oslo",
        },
      });
    }
    throw new Error(`Unexpected request ${options.method ?? "GET"} ${url}`);
  }, async () => {
    const calendar = new CalendarService(makeConfig());
    await calendar.createEvent({
      title: "Standup",
      start: "2026-06-10T09:00:00",
      end: "2026-06-10T09:15:00",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      reminderMinutes: [10, 60],
    });
    await calendar.updateEvent("event-1", {
      title: "Updated standup",
      recurrenceRule: "FREQ=DAILY;COUNT=5",
      reminderMinutes: [15],
    });

    const createBody = JSON.parse(calls.find((call) => call.options.method === "POST" && call.url.endsWith("/1/calendar/pim/event")).options.body);
    assert.equal(createBody.rrule, "FREQ=WEEKLY;BYDAY=MO,WE,FR");
    assert.deepEqual(createBody.reminders, [{ minutes_before: 10 }, { minutes_before: 60 }]);

    const updateBody = JSON.parse(calls.find((call) => call.options.method === "PUT").options.body);
    assert.equal(updateBody.rrule, "FREQ=DAILY;COUNT=5");
    assert.deepEqual(updateBody.reminders, [{ minutes_before: 15 }]);
    assert.equal(calls.some((call) => call.url.includes("/1/calendar/pim/event?")), false, "update must not scan event lists");
  });
});
