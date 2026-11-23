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
let cloudTotalMs = 0, cloudAnalyticsLoaded = false;
function renderTimer() {
  const state = readTimerState(),
        base = cloudAnalyticsLoaded ? Math.max(state.elapsed, cloudTotalMs) : state.elapsed,
        total = base + (state.startedAt ? Math.max(0, Date.now() - state.startedAt) : 0);
  $("total-time").textContent = formatTotalDuration(total);
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
    cloudTotalMs = Math.max(0, Number(data.totalMs) || 0);
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
function renderCalendar() {
  const year = calendarDate.getFullYear(), month = calendarDate.getMonth(),
        firstDay = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate(),
        previousDays = new Date(year, month, 0).getDate();
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
  const total = Math.ceil((firstDay + days) / 7) * 7;
  const today = new Date();
  for (let index = 0; index < total; index++) {
    let day, muted = false, date;
    if (index < firstDay) {
      day = previousDays - firstDay + index + 1;
      muted = true;
      date = new Date(year, month - 1, day);
    } else if (index >= firstDay + days) {
      day = index - (firstDay + days) + 1;
      muted = true;
      date = new Date(year, month + 1, day);
    } else {
      day = index - firstDay + 1;
      date = new Date(year, month, day);
    }
    const cell = document.createElement("div");
    cell.className = "calendar-day" + (muted ? " muted" : "");
    if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate())
      cell.classList.add("today");
    cell.textContent = String(day);
    cell.setAttribute("aria-label", date.toLocaleDateString(undefined, {dateStyle: "full"}));
    grid.append(cell);
  }
}
$("calendar-prev").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  renderCalendar();
});

$("calendar-next").addEventListener("click", () => {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  renderCalendar();
});

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
loadBuckets();
setInterval(() => {
  renderTimer();
  renderMonthlyChart();
}, 15000);
setInterval(() => {
  void loadCloudAnalytics();
}, 60000);
setInterval(loadBuckets, 60000);
