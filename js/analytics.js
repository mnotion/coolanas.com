// Sign-in check and analytics page setup.
const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    experimental: {passkey: true}
  }
});

const $ = id => document.getElementById(id);
function applyTheme() {
  document.documentElement.classList.toggle(
      "dark-mode", localStorage.getItem("coolanas-theme") === "dark");
}
applyTheme();
window.addEventListener("storage", event => {
  if (event.key === "coolanas-theme") applyTheme();
});
const {data: {session}, error: sessionError} = await supabase.auth.getSession();
if (sessionError || !session?.user) {
  location.replace("/index.html");
  throw new Error("Sign in required.");
}
for (const button of document.querySelectorAll(".topic"))
  button.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".topic")) {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    }
    for (const section of document.querySelectorAll(".section"))
      section.classList.toggle("active", section.id === "section-" + button.dataset.section);
  });
// Study-time totals and the monthly chart.
function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000), h = Math.floor(total / 3600),
        m = Math.floor(total % 3600 / 60), s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}
function formatTotalDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000), hours = Math.floor(totalMinutes / 60),
        minutes = totalMinutes % 60;
  return [hours, minutes].map(value => String(value).padStart(2, "0")).join(":");
}
function readTimerState() {
  try {
    const saved = JSON.parse(localStorage.getItem("coolanas-study-stopwatch-v1") || "null");
    if (saved && typeof saved.elapsed === "number")
      return {
        elapsed: Math.max(0, saved.elapsed),
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : null
      };
  } catch {
  }
  return {elapsed: 0, startedAt: null};
}
let cloudAnalyticsLoaded = false;
function currentMonthKey(date = new Date()) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}
function readDailyTotals() {
  try {
    const value = JSON.parse(localStorage.getItem("coolanas-study-daily-time-v1") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function readDailySubjects() {
  try {
    const value = JSON.parse(localStorage.getItem("coolanas-study-daily-subjects-v1") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function getCurrentMonthTotal() {
  const month = currentMonthKey(), totals = readMonthlyTotals();
  let total = Math.max(0, Number(totals[month]) || 0);
  const state = readTimerState();
  if (state.startedAt) {
    const now = Date.now();
    let cursor = state.startedAt;
    while (cursor < now) {
      const date = new Date(cursor),
            next = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
            end = Math.min(now, next);
      if (currentMonthKey(date) === month) total += end - cursor;
      cursor = end;
    }
  }
  return total;
}
function renderTimer() {
  $("total-time").textContent = formatTotalDuration(getCurrentMonthTotal());
}
async function loadCloudAnalytics() {
  try {
    let pending = [];
    try {
      pending = JSON.parse(localStorage.getItem("coolanas-study-pending-analytics-v1") || "[]");
    } catch {
    }
    if (Array.isArray(pending) && pending.length) {
      const remaining = [];
      for (let index = 0; index < pending.length; index++) {
        const {data, error} = await supabase.functions.invoke(
            "coolanas-files-b2", {body: {action: "analytics_record", ...pending[index]}});
        if (error || data?.error) {
          remaining.push(...pending.slice(index));
          break;
        }
      }
      localStorage.setItem("coolanas-study-pending-analytics-v1", JSON.stringify(remaining));
    }
    const {data, error} =
        await supabase.functions.invoke("coolanas-files-b2", {body: {action: "analytics_get"}});
    if (error || data?.error) throw error || new Error(data.error);
    const daily = data.daily && typeof data.daily === "object" && !Array.isArray(data.daily) ?
        data.daily :
        {};
    const dailySubjects = data.dailySubjects && typeof data.dailySubjects === "object" &&
            !Array.isArray(data.dailySubjects) ?
        data.dailySubjects :
        {};

    localStorage.setItem("coolanas-study-daily-time-v1", JSON.stringify(daily));
    localStorage.setItem("coolanas-study-daily-subjects-v1", JSON.stringify(dailySubjects));
    const monthly = {};
    for (const [date, duration] of Object.entries(daily)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const key = date.slice(0, 7);
        monthly[key] = (Number(monthly[key]) || 0) + Math.max(0, Number(duration) || 0);
      }
    }
    localStorage.setItem("coolanas-study-monthly-time-v1", JSON.stringify(monthly));
    cloudAnalyticsLoaded = true;
    renderTimer();
    renderMonthlyChart();
  } catch (error) {
    console.warn("Could not load saved account analytics:", error);
  }
}
function readMonthlyTotals() {
  try {
    const value = JSON.parse(localStorage.getItem("coolanas-study-monthly-time-v1") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? {...value} : {};
  } catch {
    return {};
  }
}
function addIntervalToTotals(totals, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor),
          next = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
          segmentEnd = Math.min(end, next),
          key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");

    totals[key] = (Number(totals[key]) || 0) + (segmentEnd - cursor);
    cursor = segmentEnd;
  }
}
function renderMonthlyChart() {
  const dailyKey = "coolanas-study-daily-time-v1";
  let totals = {}, subjectsByDay = {};
  try {
    totals = JSON.parse(localStorage.getItem(dailyKey) || "{}") || {};
  } catch {
  }
  try {
    subjectsByDay =
        JSON.parse(localStorage.getItem("coolanas-study-daily-subjects-v1") || "{}") || {};
  } catch {
  }
  const tooltip = $("chart-tooltip"), state = readTimerState(), now = new Date(),
        year = now.getFullYear(), month = now.getMonth(),
        days = new Date(year, month + 1, 0).getDate(),
        monthPrefix = year + "-" + String(month + 1).padStart(2, "0") + "-";
  if (state.startedAt) {
    let cursor = state.startedAt;
    const end = Date.now();
    while (cursor < end) {
      const date = new Date(cursor),
            next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
            segmentEnd = Math.min(end, next),
            key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
          String(date.getDate()).padStart(2, "0");

      totals[key] = (Number(totals[key]) || 0) + (segmentEnd - cursor);
      cursor = segmentEnd;
    }
  }
  const values = Array.from(
      {length: days},
      (_, index) =>
          Math.max(0, Number(totals[monthPrefix + String(index + 1).padStart(2, "0")]) || 0));
  const svg = $("monthly-time-chart");
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg", width = 760, height = 280, left = 48, right = 16,
        top = 16, bottom = 38, plotHeight = height - top - bottom, plotWidth = width - left - right,
        maxHours = Math.max(0, ...values) / 3600000,
        scaleHours = Math.max(1, Math.floor(maxHours) + 1), scale = scaleHours * 3600000;
  const make = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  };
  for (let step = 0; step <= scaleHours; step++) {
    const y = top + plotHeight - (step / scaleHours) * plotHeight,
          label = make(
              "text", {x: left - 10, y: y + 4, "text-anchor": "end", "class": "chart-axis-label"});
    label.textContent = step + "h";
    svg.append(label);
  }
  svg.append(
      make("line", {x1: left, y1: top, x2: left, y2: top + plotHeight, "class": "chart-axis-line"}),
      make("line", {
        x1: left,
        y1: top + plotHeight,
        x2: width - right,
        y2: top + plotHeight,
        "class": "chart-axis-line"
      }));
  const points = values.map((value, index) => ({
                              x: left + (days === 1 ? 0 : index / (days - 1) * plotWidth),
                              y: top + plotHeight - value / scale * plotHeight,
                              value
                            }));
  const pathData =
            points.map((point, index) => (index ? "L" : "M") + point.x + " " + point.y).join(" "),
        areaData = pathData + " L " + points[points.length - 1].x + " " + (top + plotHeight) +
      " L " + points[0].x + " " + (top + plotHeight) + " Z";
  svg.append(
      make("path", {d: areaData, "class": "chart-area"}),
      make("path", {d: pathData, "class": "chart-line"}));
  const labelStep = days > 24 ? 2 : 1;
  for (let index = 0; index < days; index++) {
    const point = points[index];
    if ((index + 1) % labelStep === 0 || index === 0 || index === days - 1) {
      const label = make(
          "text",
          {x: point.x, y: height - 10, "text-anchor": "middle", "class": "chart-axis-label"});
      label.textContent = String(index + 1);
      svg.append(label);
    }
    const dateKey = monthPrefix + String(index + 1).padStart(2, "0"),
          daySubjects = subjectsByDay[dateKey] && typeof subjectsByDay[dateKey] === "object" ?
        subjectsByDay[dateKey] :
        {},
          dot = make("circle", {
            cx: point.x,
            cy: point.y,
            r: 4.5,
            "class": "chart-point",
            "data-day": String(index + 1),
            "tabindex": "0",
            "role": "img",
            "aria-label": dateKey + ", " + formatDuration(point.value)
          }),
          title = make("title", {});
    title.textContent = (index + 1) + ": " + formatDuration(point.value);
    dot.append(title);
    const showTooltip = (clientX, clientY) => {
      tooltip.replaceChildren();
      const heading = document.createElement("div");
      heading.className = "chart-tooltip-date";
      heading.textContent =
          new Date(year, month, index + 1)
              .toLocaleDateString(
                  undefined, {weekday: "short", day: "numeric", month: "long", year: "numeric"});
      tooltip.append(heading);
      const total = document.createElement("div");
      total.className = "chart-tooltip-total";
      total.textContent = "Total studied: " + formatDuration(point.value);
      tooltip.append(total);
      const entries = Object.entries(daySubjects)
                          .filter(([, duration]) => Number(duration) > 0)
                          .sort((left, right) => Number(right[1]) - Number(left[1]));
      if (entries.length) {
        for (const [subject, duration] of entries) {
          const row = document.createElement("div");
          row.className = "chart-tooltip-subject";
          const name = document.createElement("span"), time = document.createElement("span");
          name.textContent = subject;
          time.textContent = formatDuration(Number(duration));
          row.append(name, time);
          tooltip.append(row);
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "chart-tooltip-empty";
        empty.textContent = "No subject breakdown recorded";
        tooltip.append(empty);
      }
      tooltip.classList.add("visible");
      const offset = 14, box = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.min(clientX + offset, window.innerWidth - box.width - 8) + "px";
      tooltip.style.top =
          Math.max(8, Math.min(clientY + offset, window.innerHeight - box.height - 8)) + "px";
    };
    dot.addEventListener("pointerenter", event => showTooltip(event.clientX, event.clientY));
    dot.addEventListener("pointermove", event => showTooltip(event.clientX, event.clientY));
    dot.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));
    dot.addEventListener("focus", () => {
      const rect = dot.getBoundingClientRect();
      showTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    dot.addEventListener("blur", () => tooltip.classList.remove("visible"));
    svg.append(dot);
    if (index < days - 1) {
      const halfX = (point.x + points[index + 1].x) / 2;
      svg.append(
          make("circle", {cx: halfX, cy: top + plotHeight, r: 1.8, "class": "chart-axis-dot"}));
    }
  }
}
// Calendar view.
let calendarDate = new Date();
calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
let selectedCalendarDate = null;
function calendarDateKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") +
      "-" + String(date.getDate()).padStart(2, "0");
}
function formatCalendarTime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
      String(minutes % 60).padStart(2, "0");
}
function formatSubjectTime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return hours ? hours + "h " + remainder + "m" : minutes + "m";
}
let calendarTasks = [];
let calendarTasksLoaded = false;
async function loadCalendarTasks() {
  try {
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {body:{action:"tasks_get"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    calendarTasks = Array.isArray(data?.tasks) ? data.tasks : [];
    calendarTasksLoaded = true;
  } catch (error) {
    console.warn("Could not load calendar tasks:", error);
    calendarTasksLoaded = false;
  }
}
function renderCalendarDetails() {
  const panel = $("calendar-details");
  if (!selectedCalendarDate) {
    panel.hidden = true;
    return;
  }
  const key = calendarDateKey(selectedCalendarDate), dailyTotals = readDailyTotals(),
        dailySubjects = readDailySubjects(), total = Math.max(0, Number(dailyTotals[key]) || 0),
        subjects = Object.entries(dailySubjects[key] || {})
            .filter(([, duration]) => Number(duration) > 0)
            .sort((a, b) => Number(b[1]) - Number(a[1]));
  const today = new Date(), todayKey = calendarDateKey(today),
        yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
        yesterdayKey = calendarDateKey(yesterday),
        heading = $("calendar-details-date");
  if (key > todayKey) heading.textContent = "I can't predict the future...";
  else if (key === todayKey) heading.textContent = "Today's work: " + formatCalendarTime(total);
  else if (key === yesterdayKey) heading.textContent = "Yesterday you worked for " + formatCalendarTime(total);
  else heading.textContent = "On that day, you worked " + formatCalendarTime(total);
  $("calendar-details-total").textContent = "";
  const close = $("calendar-details-close");
  const content = $("calendar-details-content");
  content.replaceChildren();
  const subjectsSection = document.createElement("section");
  subjectsSection.className = "calendar-detail-section";
  const subjectsTitle = document.createElement("h3");
  subjectsTitle.textContent = "Subjects studied";
  subjectsSection.append(subjectsTitle);
  if (subjects.length) {
    for (const [subject, duration] of subjects) {
      const row = document.createElement("div");
      row.className = "calendar-detail-row";
      const name = document.createElement("span"), time = document.createElement("strong");
      name.textContent = subject;
      time.textContent = formatSubjectTime(Number(duration));
      row.append(name, time);
      subjectsSection.append(row);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "calendar-details-empty";
    empty.textContent = "No subjects recorded.";
    subjectsSection.append(empty);
  }
  const tasksSection = document.createElement("section");
  tasksSection.className = "calendar-detail-section";
  const tasksTitle = document.createElement("h3");
  tasksTitle.textContent = "Tasks";
  tasksSection.append(tasksTitle);
  const dayTasks = calendarTasks.filter(task =>
    task.dueDate === key || task.completedAt === key);
  if (dayTasks.length) {
    for (const task of dayTasks) {
      const row = document.createElement("label");
      row.className = "calendar-task-row" + (task.completed ? " completed" : "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = task.completed === true;
      checkbox.disabled = key > todayKey;
      checkbox.addEventListener("change", () => updateCalendarTask(task, checkbox.checked));
      const label = document.createElement("span");
      label.textContent = task.text;
      row.append(checkbox, label);
      tasksSection.append(row);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "calendar-details-empty";
    empty.textContent = calendarTasksLoaded ? "No tasks for this day yet." : "Tasks could not be loaded.";
    tasksSection.append(empty);
  }
  if (key >= todayKey) {
    const form = document.createElement("form");
    form.className = "calendar-task-add";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 180;
    input.placeholder = "Add a task for this day…";
    input.setAttribute("aria-label", "New task for this day");
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "Add";
    form.append(input, add);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      if (calendarTasks.length >= 100) {
        input.setCustomValidity("You can have up to 100 tasks.");
        input.reportValidity();
        return;
      }
      const task = {id:crypto.randomUUID(),text:value,completed:false,dueDate:key};
      calendarTasks.push(task);
      await saveCalendarTasks();
      renderCalendarDetails();
    });
    tasksSection.append(form);
  }
  content.append(subjectsSection, tasksSection);
  panel.hidden = false;
}
async function saveCalendarTasks() {
  const {error,data} = await supabase.functions.invoke("coolanas-files-b2", {
    body:{action:"tasks_save",tasks:calendarTasks}
  });
  if (error || data?.error) throw new Error(data?.error || error.message);
}
async function updateCalendarTask(task, completed) {
  const previous = {...task};
  task.completed = completed;
  if (completed) task.completedAt = calendarDateKey(new Date());
  else delete task.completedAt;
  try {
    await saveCalendarTasks();
    renderCalendarDetails();
  } catch (error) {
    Object.assign(task, previous);
    renderCalendarDetails();
    console.error("Could not update task:", error);
  }
}
function renderCalendar() {
  const year = calendarDate.getFullYear(), month = calendarDate.getMonth(),
        firstDay = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate(),
        dailyTotals = readDailyTotals();
  $("calendar-month").textContent =
      calendarDate.toLocaleDateString(undefined, {month: "long", year: "numeric"});
  const grid = $("calendar-grid");
  grid.replaceChildren();
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = day;
    grid.append(el);
  }
  for (let blank = 0; blank < firstDay; blank++) {
    const spacer = document.createElement("div");
    spacer.className = "calendar-day-spacer";
    spacer.setAttribute("aria-hidden", "true");
    grid.append(spacer);
  }
  const today = new Date();
  for (let day = 1; day <= days; day++) {
    const date = new Date(year, month, day), key = calendarDateKey(date),
          studied = Math.max(0, Number(dailyTotals[key]) || 0),
          cell = document.createElement("button"), number = document.createElement("span"),
          time = document.createElement("span");
    cell.type = "button";
    cell.className = "calendar-day";
    if (studied > 0) {
      cell.classList.add("has-study");
      cell.style.setProperty("--study-level", String(Math.min(4, Math.max(1, Math.ceil(studied / 1800000)))));
    }
    if (selectedCalendarDate && key === calendarDateKey(selectedCalendarDate))
      cell.classList.add("selected");
    if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()) cell.classList.add("today");
    number.className = "calendar-day-number";
    number.textContent = String(day);
    time.className = "calendar-day-time";
    time.textContent = studied > 0 ? formatCalendarTime(studied) : "";
    cell.append(number, time);
    cell.dataset.date = key;
    cell.setAttribute("aria-label", date.toLocaleDateString(undefined, {dateStyle:"full"}) +
      ", studied " + formatCalendarTime(studied));
    cell.setAttribute("aria-pressed", String(Boolean(selectedCalendarDate && key === calendarDateKey(selectedCalendarDate))));
    grid.append(cell);
  }
  renderCalendarDetails();
}
$("calendar-details-close").addEventListener("click", () => {
  selectedCalendarDate = null;
  renderCalendar();
});
let calendarPointerStart = null;
let calendarSwipeHandled = false;
$("calendar-grid").addEventListener("click", event => {
  if (calendarSwipeHandled) {
    calendarSwipeHandled = false;
    event.preventDefault();
    return;
  }
  const cell = event.target.closest("button.calendar-day[data-date]");
  if (!cell) return;
  const [year, month, day] = cell.dataset.date.split("-").map(Number);
  selectedCalendarDate = new Date(year, month - 1, day);
  calendarDate = new Date(year, month - 1, 1);
  renderCalendar();
});
$("calendar-grid").addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  calendarPointerStart = {x:event.clientX, y:event.clientY};
});
$("calendar-grid").addEventListener("pointerup", event => {
  if (!calendarPointerStart) return;
  const dx = event.clientX - calendarPointerStart.x, dy = event.clientY - calendarPointerStart.y;
  calendarPointerStart = null;
  if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
  calendarSwipeHandled = true;
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + (dx < 0 ? 1 : -1), 1);
  selectedCalendarDate = null;
  renderCalendar();
});
$("calendar-grid").addEventListener("pointercancel", () => calendarPointerStart = null);
$("calendar-grid").addEventListener("wheel", event => {
  if (Math.abs(event.deltaX) < 25 || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
  event.preventDefault();
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + (event.deltaX > 0 ? 1 : -1), 1);
  selectedCalendarDate = null;
  renderCalendar();
}, {passive:false});

// Bucket summary.
async function loadBuckets() {
  const list = $("bucket-list");
  try {
    const {data, error} =
        await supabase.functions.invoke("coolanas-files-b2", {body: {action: "list"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    const items = Array.isArray(data?.items) ? data.items : [];
    const folders = items.filter(item => item.item_type === "folder" && item.parent_id === null);
    const files = items.filter(item => item.item_type === "file");
    $("bucket-count").textContent = String(folders.length);
    $("file-count").textContent = String(files.length);
    list.replaceChildren();
    if (!folders.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "You have not created any buckets yet.";
      list.append(empty);
      return;
    }
    for (const folder of folders) {
      const row = document.createElement("div");
      row.className = "bucket-row";
      const name = document.createElement("div");
      name.className = "bucket-row-name";
      name.innerHTML =
          "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 7.5h7l2 2H21v10H3z\"/><path d=\"M3 7.5V5h7l2 2.5\"/></svg>";
      const label = document.createElement("span");
      label.textContent = folder.name;
      name.append(label);
      const type = document.createElement("span");
      type.className = "bucket-row-type";
      type.textContent = "Bucket";
      row.append(name, type);
      list.append(row);
    }
  } catch (error) {
    $("bucket-count").textContent = "—";
    $("file-count").textContent = "—";
    list.replaceChildren();
    const message = document.createElement("p");
    message.className = "empty";
    message.textContent = error.message || "Could not load your buckets.";
    list.append(message);
  }
}
renderTimer();
renderMonthlyChart();
void loadCloudAnalytics();
renderCalendar();
void loadCalendarTasks().then(renderCalendarDetails);
loadBuckets();
setInterval(() => {
  renderTimer();
  renderMonthlyChart();
  renderCalendar();
}, 15000);
setInterval(() => {
  void loadCloudAnalytics();
}, 60000);
setInterval(loadBuckets, 60000);
