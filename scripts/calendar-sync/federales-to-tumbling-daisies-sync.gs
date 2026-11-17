/**
 * One-directional calendar sync: Federales -> Tumbling Daisies.
 *
 * Setup:
 *   1. Go to script.google.com, create a new project (name it whatever, e.g.
 *      "Federales -> TD Calendar Sync").
 *   2. Paste this whole file in as Code.gs.
 *   3. Fill in SOURCE_CALENDAR_ID and TARGET_CALENDAR_ID below.
 *   4. Run `syncFederalesToTumblingDaisies` once manually from the editor
 *      (select it in the function dropdown, click Run) to authorize the
 *      script and do an initial sync. Because of Google's rate limits on
 *      calendar event creation, a large initial backfill will only make
 *      partial progress per run (see MUTATION_BUDGET_PER_RUN below) --
 *      just re-run it a few times, or install the trigger and let it
 *      finish over subsequent 12-hour runs.
 *   5. Run `setupTrigger` once to install the recurring 12-hour trigger.
 *      (Re-running it is safe -- it clears old triggers for this function
 *      first so you won't get duplicates.)
 *
 * This file lives in the tumbling-daisies repo under scripts/calendar-sync/
 * purely for version control -- it is NOT run as part of this repo (no
 * build step, no npm script, no CI). It's deployed by hand into a separate
 * standalone Apps Script project as described above. If you edit it there,
 * copy the changes back into this file too.
 *
 * How it decides what to copy:
 *   - Federales' internal nag reminder ("[REMINDER] - update your Feds
 *     calendar!") is never copied.
 *   - Any event whose title looks like an "out"/availability post (starts
 *     with "no ", case-insensitive -- e.g. "No Jay", "no jay (sick)") is
 *     only copied if it mentions one of WATCHED_MEMBERS by name. "No Ben"
 *     is skipped if Ben isn't in the list; "No Jay" is copied.
 *   - Every other event (gigs, rehearsals, anything not matching the "out"
 *     pattern) is copied unconditionally.
 *   - Known false-positive risk: a non-availability event that happens to
 *     start with "No" (e.g. "No cover charge show") would be misread as an
 *     out-event and dropped unless a watched member's name also appears in
 *     it. If that turns out to matter, tighten OUT_EVENT_REGEX below.
 *
 * Title prefix:
 *   - Copied events are titled "[Federales] <original title>", except when
 *     the title already contains "TD at" or "Tumbling Daisies at" (case
 *     insensitive) -- those are copied with their original title unchanged,
 *     since the Federales origin is already implied.
 *
 * Idempotency:
 *   - Each copied event gets a tag (setTag/getTag) recording the source
 *     event's ID. On every run, existing tagged copies in the sync window
 *     are matched back to their source event: if the source changed
 *     (title/time/description), the copy is updated in place; if the
 *     source is gone (deleted, or moved outside the sync window), the copy
 *     is deleted. No duplicates get created on repeat runs.
 */

// ---- Config ----------------------------------------------------------

var SOURCE_CALENDAR_ID = 'd5s5fcphhafm0nvgcek25o9k18@group.calendar.google.com';
var TARGET_CALENDAR_ID = 'tumblingdaisiesband@gmail.com';

// Tumbling Daisies members to watch for in Federales "out" posts.
var WATCHED_MEMBERS = ['James', 'Chris', 'Jay', 'Mark'];

// Fixed starting point -- events before this date are never synced, even
// if edited later. Events outside the window (before this date, or beyond
// SYNC_WINDOW_DAYS_FUTURE from today) are treated as if they don't exist,
// so a copy previously made for an event that has since moved outside the
// window will be deleted.
var SYNC_START_DATE = new Date('2026-08-01T00:00:00');
var SYNC_WINDOW_DAYS_FUTURE = 365 * 3;

var TITLE_PREFIX = '[Federales] ';
var OUT_EVENT_REGEX = /^\s*no\b/i;

// Federales' internal nag reminder ("[REMINDER] - update your Feds
// calendar!") -- never copy these regardless of watched members.
var REMINDER_EVENT_REGEX = /^\s*\[REMINDER\]/i;

// If the title already references Tumbling Daisies (e.g. "TD at Whatever",
// "Tumbling Daisies at Whatever"), skip the "[Federales] " prefix -- it's
// already clear from the title alone.
var NO_PREFIX_PATTERNS = [/\bTD at\b/i, /\bTumbling Daisies at\b/i];

var TAG_KEY_SOURCE_EVENT_ID = 'syncSourceEventId';

// Google throttles rapid-fire calendar event creates/deletes ("You have
// been creating or deleting too many calendars or calendar events in a
// short time"). To stay under that, each run only performs a limited
// number of create/update/delete calls, pausing between each one. A large
// initial backfill (e.g. a 3-year future window on first run) will spread
// across several trigger firings instead of completing in one shot -- this
// is expected and safe; idempotency means each run just picks up where
// the last one left off. If you want the initial backfill to finish
// faster, temporarily change setupTrigger() to fire every 5-10 minutes,
// then switch it back to 12-hour once Logger output shows nothing left to
// create.
var MUTATION_BUDGET_PER_RUN = 15;
var MUTATION_SLEEP_MS = 500;

// Skip-if-unchanged: before doing any real work, the source calendar's
// current event IDs + last-modified timestamps are compared against what
// was seen on the last *fully completed* run (stored in Script
// Properties). If nothing on the source side has changed, the run exits
// immediately without touching the target calendar at all. This only
// tracks the source (Federales) side, since that's what drives this
// one-directional sync -- edits made directly on the target calendar
// aren't inputs to it.
var PROPERTY_KEY_LAST_SYNC_STATE = 'lastSyncState';

// ---- Entry points ------------------------------------------------------

function syncFederalesToTumblingDaisies() {
  var source = CalendarApp.getCalendarById(SOURCE_CALENDAR_ID);
  var target = CalendarApp.getCalendarById(TARGET_CALENDAR_ID);

  if (!source) throw new Error('Could not open source calendar: ' + SOURCE_CALENDAR_ID);
  if (!target) throw new Error('Could not open target calendar: ' + TARGET_CALENDAR_ID);

  var windowStart = SYNC_START_DATE;
  var windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + SYNC_WINDOW_DAYS_FUTURE);

  var sourceEvents = source.getEvents(windowStart, windowEnd);
  var currentState = summarizeSourceState_(sourceEvents);

  var props = PropertiesService.getScriptProperties();
  var storedState = parseStoredState_(props.getProperty(PROPERTY_KEY_LAST_SYNC_STATE));

  if (storedState && sourceStateUnchanged_(storedState, currentState)) {
    Logger.log('No changes on Federales calendar since last check -- skipping.');
    return;
  }

  var existingCopies = getExistingCopiesBySourceId_(target, windowStart, windowEnd);
  var handledSourceIds = {};

  var created = 0, updated = 0, deleted = 0, skipped = 0;
  var mutations = 0;
  var budgetReached = false;

  // Calendars get edited by hand constantly (deleted events, retitled
  // events, etc.), so any single mutation here can find its target already
  // gone or changed out from under it. That should never abort the whole
  // run -- log it and move on; the next run will reconcile whatever state
  // is actually there.
  function mutate(fn, label) {
    var succeeded = true;
    try {
      fn();
    } catch (e) {
      succeeded = false;
      Logger.log('Skipped mutation (%s): %s', label, e.message);
    }
    mutations++;
    if (mutations >= MUTATION_BUDGET_PER_RUN) {
      budgetReached = true;
    } else {
      Utilities.sleep(MUTATION_SLEEP_MS);
    }
    return succeeded;
  }

  for (var i = 0; i < sourceEvents.length && !budgetReached; i++) {
    var sourceEvent = sourceEvents[i];
    var sourceId = sourceEvent.getId();
    handledSourceIds[sourceId] = true;

    var shouldCopy = shouldCopyEvent_(sourceEvent.getTitle());
    var existingCopy = existingCopies[sourceId];

    if (!shouldCopy) {
      if (existingCopy) {
        if (mutate(function () { existingCopy.deleteEvent(); }, 'delete ' + sourceId)) deleted++;
      } else {
        skipped++;
      }
      continue;
    }

    if (existingCopy) {
      try {
        var didChange = applyEventFields_(existingCopy, sourceEvent);
        if (didChange) {
          updated++;
          mutations++;
          if (mutations >= MUTATION_BUDGET_PER_RUN) budgetReached = true;
          else Utilities.sleep(MUTATION_SLEEP_MS);
        }
      } catch (e) {
        // Most likely the copy was deleted or edited manually on the
        // Tumbling Daisies calendar out from under us. Not fatal -- next
        // run will see there's no valid tagged copy for this source event
        // and create a fresh one.
        Logger.log('Skipped update for source event %s: %s', sourceId, e.message);
      }
    } else {
      if (mutate((function (sourceEvent, sourceId) {
        return function () { createCopy_(target, sourceEvent, sourceId); };
      })(sourceEvent, sourceId), 'create ' + sourceId)) created++;
    }
  }

  // Only safe to prune orphans once every source event has actually been
  // checked this run -- if we stopped early on budget, we haven't looked
  // at the rest yet, so treating leftovers as "deleted on source" would be
  // wrong.
  if (!budgetReached) {
    var existingCopyIds = Object.keys(existingCopies);
    for (var j = 0; j < existingCopyIds.length && !budgetReached; j++) {
      var id = existingCopyIds[j];
      if (!handledSourceIds[id]) {
        if (mutate((function (event) {
          return function () { event.deleteEvent(); };
        })(existingCopies[id]), 'orphan delete ' + id)) deleted++;
      }
    }
  }

  if (!budgetReached) {
    // Only remember this snapshot once fully applied -- if a future run's
    // source state matches this one, it's safe to conclude there's truly
    // nothing left to do.
    props.setProperty(PROPERTY_KEY_LAST_SYNC_STATE, JSON.stringify(currentState));
  }

  Logger.log(
    'Sync %s. created=%s updated=%s deleted=%s skipped=%s',
    budgetReached ? 'paused (mutation budget reached, will resume next run)' : 'complete',
    created, updated, deleted, skipped
  );
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncFederalesToTumblingDaisies') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('syncFederalesToTumblingDaisies')
    .timeBased()
    .everyHours(12)
    .create();

  Logger.log('12-hour trigger installed.');
}

// ---- Helpers -------------------------------------------------------------

function summarizeSourceState_(sourceEvents) {
  var ids = sourceEvents.map(function (event) { return event.getId(); }).sort();
  var maxUpdated = sourceEvents.reduce(function (max, event) {
    var updated = +event.getLastUpdated();
    return updated > max ? updated : max;
  }, 0);
  return { ids: ids, maxUpdated: maxUpdated };
}

function parseStoredState_(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function sourceStateUnchanged_(storedState, currentState) {
  if (storedState.maxUpdated !== currentState.maxUpdated) return false;
  if (storedState.ids.length !== currentState.ids.length) return false;
  for (var i = 0; i < storedState.ids.length; i++) {
    if (storedState.ids[i] !== currentState.ids[i]) return false;
  }
  return true;
}

function shouldCopyEvent_(title) {
  if (REMINDER_EVENT_REGEX.test(title)) return false;
  if (!OUT_EVENT_REGEX.test(title)) return true;

  return WATCHED_MEMBERS.some(function (name) {
    var pattern = new RegExp('\\b' + name + '\\b', 'i');
    return pattern.test(title);
  });
}

function desiredTitleFor_(sourceEvent) {
  var title = sourceEvent.getTitle();
  var skipPrefix = NO_PREFIX_PATTERNS.some(function (pattern) { return pattern.test(title); });
  return skipPrefix ? title : TITLE_PREFIX + title;
}

function getExistingCopiesBySourceId_(calendar, windowStart, windowEnd) {
  var map = {};
  calendar.getEvents(windowStart, windowEnd).forEach(function (event) {
    var sourceId = event.getTag(TAG_KEY_SOURCE_EVENT_ID);
    if (sourceId) map[sourceId] = event;
  });
  return map;
}

function createCopy_(target, sourceEvent, sourceId) {
  var title = desiredTitleFor_(sourceEvent);
  var newEvent;

  if (sourceEvent.isAllDayEvent()) {
    newEvent = target.createAllDayEvent(
      title,
      sourceEvent.getAllDayStartDate(),
      sourceEvent.getAllDayEndDate(),
      { description: sourceEvent.getDescription(), location: sourceEvent.getLocation() }
    );
  } else {
    newEvent = target.createEvent(
      title,
      sourceEvent.getStartTime(),
      sourceEvent.getEndTime(),
      { description: sourceEvent.getDescription(), location: sourceEvent.getLocation() }
    );
  }

  newEvent.setTag(TAG_KEY_SOURCE_EVENT_ID, sourceId);
}

// Returns true if anything actually changed.
function applyEventFields_(copyEvent, sourceEvent) {
  var changed = false;
  var desiredTitle = desiredTitleFor_(sourceEvent);

  if (copyEvent.getTitle() !== desiredTitle) {
    copyEvent.setTitle(desiredTitle);
    changed = true;
  }

  if (copyEvent.getDescription() !== sourceEvent.getDescription()) {
    copyEvent.setDescription(sourceEvent.getDescription());
    changed = true;
  }

  if (copyEvent.getLocation() !== sourceEvent.getLocation()) {
    copyEvent.setLocation(sourceEvent.getLocation());
    changed = true;
  }

  if (sourceEvent.isAllDayEvent()) {
    if (!copyEvent.isAllDayEvent() ||
        +copyEvent.getAllDayStartDate() !== +sourceEvent.getAllDayStartDate() ||
        +copyEvent.getAllDayEndDate() !== +sourceEvent.getAllDayEndDate()) {
      copyEvent.setAllDayDates(sourceEvent.getAllDayStartDate(), sourceEvent.getAllDayEndDate());
      changed = true;
    }
  } else {
    if (copyEvent.isAllDayEvent() ||
        +copyEvent.getStartTime() !== +sourceEvent.getStartTime() ||
        +copyEvent.getEndTime() !== +sourceEvent.getEndTime()) {
      copyEvent.setTime(sourceEvent.getStartTime(), sourceEvent.getEndTime());
      changed = true;
    }
  }

  return changed;
}
