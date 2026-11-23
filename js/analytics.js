// From Uiverse.io by ashif_6672 - https://uiverse.io/ashif_6672/nice-warthog-84
// MIT License, Copyright (c) ashif_6672 (Ashif)
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
const accountKey = key => key + ":" + session.user.id;
supabase.auth.onAuthStateChange((_event, nextSession) => {
  if ((nextSession?.user?.id || null) !== session.user.id) location.reload();
});
// Legacy unscoped pending records have no verifiable owner; never sync them.
localStorage.removeItem("coolanas-study-pending-analytics-v1");

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
    const saved = JSON.parse(localStorage.getItem(accountKey("coolanas-study-stopwatch-v1")) || "null");
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
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-time-v1")) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function readDailySubjects() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-subjects-v1")) || "{}");
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
      pending = JSON.parse(localStorage.getItem(accountKey("coolanas-study-pending-analytics-v1")) || "[]");
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
      localStorage.setItem(accountKey("coolanas-study-pending-analytics-v1"), JSON.stringify(remaining));
    }
    const {data, error} =
        await supabase.functions.invoke("coolanas-files-b2", {body: {action: "analytics_get"}});
    if (error || data?.error) throw error || new Error(data.error);
    const daily = data.daily && typeof data.daily === "object" && !Array.isArray(data.daily) ?
        data.daily :
        {};
    const dailySubjects = data.dailySubjects && typeof data.dailySubjects === "object" && !Array.isArray(data.dailySubjects) ? data.dailySubjects : {};
    const dailyHours = data.dailyHours && typeof data.dailyHours === "object" && !Array.isArray(data.dailyHours) ? data.dailyHours : {};
    localStorage.setItem(accountKey("coolanas-study-daily-time-v1"), JSON.stringify(daily));
    localStorage.setItem(accountKey("coolanas-study-daily-subjects-v1"), JSON.stringify(dailySubjects));
    localStorage.setItem(accountKey("coolanas-study-daily-hours-v1"), JSON.stringify(dailyHours));
    const monthly = {};
    for (const [date, duration] of Object.entries(daily)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const key = date.slice(0, 7);
        monthly[key] = (Number(monthly[key]) || 0) + Math.max(0, Number(duration) || 0);
      }
    }
    localStorage.setItem(accountKey("coolanas-study-monthly-time-v1"), JSON.stringify(monthly));
    cloudAnalyticsLoaded = true;
    renderTimer();
    renderMonthlyChart();
  } catch (error) {
    console.warn("Could not load saved account analytics:", error);
  }
}
function readMonthlyTotals() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-monthly-time-v1")) || "{}");
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
  const dailyKey = accountKey("coolanas-study-daily-time-v1");
  let totals = {}, subjectsByDay = {};
  try {
    totals = JSON.parse(localStorage.getItem(dailyKey) || "{}") || {};
  } catch {
  }
  try {
    subjectsByDay =
        JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-subjects-v1")) || "{}") || {};
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
let calendarTaskSyncTimer = null;
let calendarTaskSyncInFlight = false;
const calendarTasksCacheKey = accountKey("coolanas-calendar-tasks-v1");
const calendarTasksPendingKey = accountKey("coolanas-calendar-tasks-pending-v1");
function saveCalendarTasksLocally() {
  localStorage.setItem(calendarTasksCacheKey, JSON.stringify(calendarTasks));
  localStorage.setItem(calendarTasksPendingKey, "1");
}
function queueCalendarTasksSync() {
  saveCalendarTasksLocally();
  if (calendarTaskSyncTimer) clearTimeout(calendarTaskSyncTimer);
  calendarTaskSyncTimer = setTimeout(() => {
    calendarTaskSyncTimer = null;
    void flushCalendarTasks();
  }, 5000);
}
async function flushCalendarTasks({keepalive = false} = {}) {
  if (calendarTaskSyncTimer) {
    clearTimeout(calendarTaskSyncTimer);
    calendarTaskSyncTimer = null;
  }
  if (localStorage.getItem(calendarTasksPendingKey) !== "1" || calendarTaskSyncInFlight) return;
  calendarTaskSyncInFlight = true;
  const payload = JSON.stringify({action:"tasks_save", tasks:calendarTasks});
  try {
    if (keepalive) {
      const response = await fetch(SUPABASE_URL + "/functions/v1/coolanas-files-b2", {
        method:"POST", keepalive:true,
        headers:{
          "Content-Type":"application/json",
          apikey:SUPABASE_PUBLISHABLE_KEY,
          Authorization:"Bearer " + session.access_token
        },
        body:payload
      });
      if (!response.ok) throw new Error("Task sync failed.");
      const result = await response.json();
      if (result?.error) throw new Error(result.error);
    } else {
      const {data,error} = await supabase.functions.invoke("coolanas-files-b2", {
        body:{action:"tasks_save",tasks:calendarTasks}
      });
      if (error || data?.error) throw new Error(data?.error || error.message);
    }
    localStorage.removeItem(calendarTasksPendingKey);
  } catch (error) {
    console.warn("Could not sync calendar tasks:", error);
  } finally {
    calendarTaskSyncInFlight = false;
  }
}
window.addEventListener("pagehide", () => { void flushCalendarTasks({keepalive:true}); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flushCalendarTasks({keepalive:true});
});
let calendarSubjectColours = {};
const subjectPalette = ["#e7e7e7", "#f6caca", "#f6dfaa", "#d9edbd", "#c9e7ef", "#d7d0f2", "#f0cce8"];
async function loadCalendarSubjectColours() {
  try {
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {body:{action:"subjects_get"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    calendarSubjectColours = Object.fromEntries((Array.isArray(data?.subjects) ? data.subjects : []).filter(s => s && typeof s.name === "string").map(s => [s.name, subjectPalette[Math.max(0, Math.min(6, Number(s.color) || 0))]]));
  } catch (error) { console.warn("Could not load subject colours:", error); }
}
async function loadCalendarTasks() {
  if (localStorage.getItem(calendarTasksPendingKey) === "1") {
    try {
      const cached = JSON.parse(localStorage.getItem(calendarTasksCacheKey) || "[]");
      if (Array.isArray(cached)) {
        calendarTasks = cached;
        calendarTasksLoaded = true;
        return;
      }
    } catch {}
  }
  try {
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {body:{action:"tasks_get"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    calendarTasks = Array.isArray(data?.tasks) ? data.tasks : [];
    calendarTasksLoaded = true;
    localStorage.setItem(calendarTasksCacheKey, JSON.stringify(calendarTasks));
  } catch (error) {
    console.warn("Could not load calendar tasks:", error);
    calendarTasksLoaded = false;
  }
}
function renderCalendarHourlyGraph(panel, dateKey) {
  const chart = document.createElement("section");
  chart.className = "calendar-hourly-chart";
  const title = document.createElement("h3");
  title.textContent = "Study throughout the day";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 720 270");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Study time, including minutes, in each hour from midnight to midnight");
  let allHours = {};
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-hours-v1")) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) allHours = saved;
  } catch {
  }
  const dayHours = allHours[dateKey] && typeof allHours[dateKey] === "object" ?
      allHours[dateKey] : {};
  const values = [];
  for (let hour = 0; hour < 24; hour++)
    values.push(Math.max(0, Number(dayHours[hour]) || 0));
  const halfHour = 30 * 60 * 1000,
        max = Math.max(halfHour, Math.ceil(Math.max(...values) / halfHour) * halfHour);
  const left = 48, right = 700, top = 18, bottom = 218;
  function formatHourlyDuration(ms) {
    const minutes = Math.round(ms / 60000), hours = Math.floor(minutes / 60),
          remainder = minutes % 60;
    if (!minutes) return "0m";
    if (!hours) return minutes + "m";
    return remainder ? hours + "h " + remainder + "m" : hours + "h";
  }
  function add(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(name => node.setAttribute(name, String(attrs[name])));
    svg.append(node);
    return node;
  }
  for (let tick = 0; tick <= max / halfHour; tick++) {
    const duration = tick * halfHour,
          y = bottom - duration / max * (bottom - top);
    add("line", {x1:left,y1:y,x2:right,y2:y,stroke:"#e5e7eb","stroke-width":1});
    const label = add("text", {x:left-10,y:y+4,"text-anchor":"end",fill:"#858b96","font-size":11});
    label.textContent = formatHourlyDuration(duration);
  }
  const coords = [];
  for (let hour = 0; hour < 24; hour++) {
    coords.push([left + hour / 23 * (right-left), bottom - values[hour] / max * (bottom-top)]);
  }
  add("polyline", {points:coords.map(point => point.join(",")).join(" "),fill:"none",stroke:"#397fe0","stroke-width":3,"stroke-linecap":"round","stroke-linejoin":"round"});
  coords.forEach((point, hour) => {
    const dot = add("circle", {
      cx:point[0],cy:point[1],r:values[hour] > 0 ? 5 : 2.5,
      fill:values[hour] > 0 ? "#397fe0" : "#aab4c2",stroke:"#fff","stroke-width":1.5,
      "aria-label":hour + ":00 — " + formatHourlyDuration(values[hour])
    });
    const dotTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    dotTitle.textContent = hour + ":00–" + String((hour + 1) % 24).padStart(2, "0") +
        ":00 · " + formatHourlyDuration(values[hour]);
    dot.append(dotTitle);
    if (hour % 2 === 0) {
      const label = add("text", {x:point[0],y:bottom+22,"text-anchor":"middle",fill:"#858b96","font-size":10});
      label.textContent = String(hour);
    }
  });
  const xLabel = add("text", {x:374,y:260,"text-anchor":"middle",fill:"#858b96","font-size":11});
  xLabel.textContent = "Time of day";
  chart.append(title, svg);
  panel.insertAdjacentElement("afterend", chart);
}
function renderCalendarDetails() {
  const panel = $("calendar-details");
  document.querySelector(".calendar-hourly-chart")?.remove();
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
        heading = $("calendar-details-date"),
        headingWrap = heading.closest(".calendar-details-heading"),
        isFutureDate = key > todayKey;
  panel.classList.toggle("future-date", isFutureDate);
  if (isFutureDate) {
    heading.textContent = "I can't predict the future...";
    panel.prepend(headingWrap);
  } else {
    if (headingWrap.parentElement !== panel.parentElement)
      panel.parentElement.insertBefore(headingWrap, panel);
    if (key === todayKey) heading.textContent = "Today's work: " + formatCalendarTime(total);
    else if (key === yesterdayKey) heading.textContent = "Yesterday you worked for " + formatCalendarTime(total);
    else heading.textContent = "On that day, you worked " + formatCalendarTime(total);
  }
  $("calendar-details-total").textContent = "";
  const content = $("calendar-details-content");
  content.replaceChildren();
  const subjectsSection = document.createElement("section");
  subjectsSection.className = "calendar-detail-section calendar-subjects-section";
  const subjectCards = document.createElement("div");
  subjectCards.className = "calendar-subject-cards";
  if (subjects.length) {
    for (const [subject, duration] of subjects) {
      const card = document.createElement("div");
      card.className = "calendar-subject-card";
      card.style.background = calendarSubjectColours[subject] || "#e7e7e7";
      const name = document.createElement("span"), time = document.createElement("strong");
      name.textContent = subject;
      time.textContent = formatSubjectTime(Number(duration));
      card.append(name, time);
      subjectCards.append(card);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "calendar-details-empty";
    empty.textContent = "No subjects recorded.";
    subjectCards.append(empty);
  }
  subjectsSection.append(subjectCards);
  const tasksSection = document.createElement("section");
  tasksSection.className = "calendar-detail-section calendar-tasks-section";
  const tasksTitle = document.createElement("h3");
  tasksTitle.textContent = "Tasks";
  tasksSection.append(tasksTitle);
  const dayTasks = calendarTasks.filter(task => task.dueDate === key || task.completedAt === key || (!task.dueDate && key === todayKey));
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
    form.addEventListener("submit", event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      if (calendarTasks.length >= 100) {
        input.setCustomValidity("You can have up to 100 tasks.");
        input.reportValidity();
        return;
      }
      calendarTasks.push({id:crypto.randomUUID(),text:value,completed:false,dueDate:key});
      input.value = "";
      input.setCustomValidity("");
      queueCalendarTasksSync();
      renderCalendarDetails();
    });
    tasksSection.append(form);
  }
  if (dayTasks.length) {
    for (const task of dayTasks) {
      const row = document.createElement("div");
      row.className = "calendar-task-row" + (task.completed ? " completed" : "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = task.completed === true;
      checkbox.disabled = key > todayKey;
      checkbox.setAttribute("aria-label", "Mark " + task.text + " as completed");
      checkbox.addEventListener("change", () => updateCalendarTask(task, checkbox.checked));
      const label = document.createElement("span");
      label.className = "calendar-task-label";
      label.textContent = task.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "calendar-task-remove";
      remove.textContent = "×";
      remove.title = "Remove task";
      remove.setAttribute("aria-label", "Remove task: " + task.text);
      remove.addEventListener("click", () => removeCalendarTask(task));
      row.append(checkbox, label, remove);
      tasksSection.append(row);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "calendar-details-empty";
    empty.textContent = calendarTasksLoaded ? "No tasks for this day yet." : "Tasks could not be loaded.";
    tasksSection.append(empty);
  }
  if (key <= todayKey) content.append(subjectsSection);
  content.append(tasksSection);
  if (key <= todayKey) renderCalendarHourlyGraph(panel, key);
  panel.hidden = false;
}
function removeCalendarTask(task) {
  calendarTasks = calendarTasks.filter(item => item.id !== task.id);
  queueCalendarTasksSync();
  renderCalendarDetails();
}
function updateCalendarTask(task, completed) {
  task.completed = completed;
  if (completed) task.completedAt = calendarDateKey(new Date());
  else delete task.completedAt;
  queueCalendarTasksSync();
  renderCalendarDetails();
}
let calendarSlideDirection = 0;
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
  if (calendarSlideDirection) {
    const direction = calendarSlideDirection;
    calendarSlideDirection = 0;
    const enteringFrom = direction > 0 ? "28px" : "-28px";
    const keyframes = [{transform:"translateX(" + enteringFrom + ")",opacity:0.45},{transform:"translateX(0)",opacity:1}];
    const options = {duration:260,easing:"cubic-bezier(.22,.75,.25,1)"};
    $("calendar-grid").animate(keyframes, options);
    $("calendar-month").animate(keyframes, options);
  }
  renderCalendarDetails();
}
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
  const direction = dx < 0 ? 1 : -1;
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + direction, 1);
  selectedCalendarDate = null;
  calendarSlideDirection = direction;
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

// From Uiverse.io by ashif_6672 - https://uiverse.io/ashif_6672/nice-warthog-84
// MIT License, Copyright (c) ashif_6672 (Ashif)
// Bucket summary and expandable folder tree.
let analyticsBucketItems = [];
let analyticsBucketRootId = null;
let selectedAnalyticsBucketId = null;
function createBucketTreeIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("class",kind === "file" ? "icon" : "icon " + (kind === "open" ? "folder-open-icon" : "folder-closed-icon"));
  svg.setAttribute("xmlns","http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox","0 0 24 24");
  svg.setAttribute("fill","none");
  svg.setAttribute("stroke","currentColor");
  svg.setAttribute("stroke-width","2");
  svg.setAttribute("stroke-linecap","round");
  svg.setAttribute("stroke-linejoin","round");
  const path=document.createElementNS("http://www.w3.org/2000/svg","path");
  if(kind==="file"){
    path.setAttribute("d","M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z");
    const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");
    line.setAttribute("points","14 2 14 8 20 8");
    svg.append(path,line);
  } else {
    path.setAttribute("d","M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z");
    svg.append(path);
    if(kind==="open"){
      const line=document.createElementNS("http://www.w3.org/2000/svg","path");
      line.setAttribute("d","M2 10h20");
      svg.append(line);
    }
  }
  return svg;
}
function renderBucketTreeNode(item,childrenByParent,depth=0){
  const li=document.createElement("li");
  li.className="tree-item";
  li.dataset.itemId=item.id;
  li.dataset.itemType=item.item_type;
  if(item.item_type==="folder"){
    const toggle=document.createElement("input");
    toggle.type="checkbox";
    toggle.className="tree-toggle";
    toggle.checked=depth===0;
    toggle.id="bucket-tree-toggle-"+String(item.id).replace(/[^a-zA-Z0-9_-]/g,"");
    const label=document.createElement("label");
    label.className="tree-label";
    label.htmlFor=toggle.id;
    label.dataset.itemId=item.id;
    label.style.setProperty("--item-folder-colour",item.folder_color||"transparent");
    const closedIcon=createBucketTreeIcon("closed");
    const openIcon=createBucketTreeIcon("open");
    if(item.folder_color){
      closedIcon.style.color=item.folder_color;
      openIcon.style.color=item.folder_color;
    }
    label.append(closedIcon,openIcon,document.createTextNode(item.name));
    const wrapper=document.createElement("div");
    wrapper.className="tree-children-wrapper";
    const children=document.createElement("ul");
    children.className="tree-children";
    for(const child of childrenByParent.get(item.id)||[])
      children.append(renderBucketTreeNode(child,childrenByParent,depth+1));
    wrapper.append(children);
    li.append(toggle,label,wrapper);
  } else {
    const file=document.createElement("div");
    file.className="file-item";
    file.dataset.itemId=item.id;
    file.append(createBucketTreeIcon("file"),document.createTextNode(item.name));
    li.append(file);
  }
  return li;
}function bucketDescendantIds(bucketId){
  const descendants=new Set([bucketId]);
  let changed=true;
  while(changed){
    changed=false;
    for(const item of analyticsBucketItems){
      if(item.parent_id && descendants.has(item.parent_id) && !descendants.has(item.id)){
        descendants.add(item.id);
        changed=true;
      }
    }
  }
  return descendants;
}
function renderBucketStructure(){
  const tree=$("bucket-tree");
  tree.replaceChildren();
  const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
  if(!buckets.length){
    const empty=document.createElement("p");
    empty.className="empty";
    empty.textContent="You have not created any buckets yet.";
    tree.append(empty);
    return;
  }
  const grid=document.createElement("div");
  grid.className="bucket-tree-grid";
  for(const bucket of buckets){
    const descendants=bucketDescendantIds(bucket.id);
    const childrenByParent=new Map();
    for(const item of analyticsBucketItems){
      if(!descendants.has(item.id)||item.parent_id==null) continue;
      if(!childrenByParent.has(item.parent_id)) childrenByParent.set(item.parent_id,[]);
      childrenByParent.get(item.parent_id).push(item);
    }
    for(const children of childrenByParent.values()){
      children.sort((left,right)=>(left.item_type==="folder"?0:1)-(right.item_type==="folder"?0:1)||
        Number(left.sort_order||0)-Number(right.sort_order||0)||left.name.localeCompare(right.name));
    }
    const card=document.createElement("div");
    card.className="bucket-tree-card";
    card.style.setProperty("--bucket-colour",bucket.folder_color||"#e5e7eb");
    const rootList=document.createElement("ul");
    rootList.append(renderBucketTreeNode(bucket,childrenByParent));
    card.append(rootList);
    grid.append(card);
  }
  tree.append(grid);
}
// Bucket item actions, queued metadata changes, and folder uploads.
async function bucketAction(action,payload={}){
  const retryable=new Set([408,425,429,500,502,503,504]);
  for(let attempt=1;attempt<=4;attempt++){
    const {data,error}=await supabase.functions.invoke("coolanas-files-b2",{body:{action,...payload}});
    if(!error&&!data?.error)return data;
    const status=Number(error?.context?.status)||0;
    const message=data?.error||error?.message||"Bucket request failed.";
    if(attempt===4||(!retryable.has(status)&&status!==0))throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,500*attempt));
  }
  throw new Error("Bucket request failed.");
}
const bucketSyncDb=new Promise((resolve,reject)=>{
  const request=indexedDB.open("coolanas-analytics-bucket-sync",1);
  request.onupgradeneeded=()=>{
    if(!request.result.objectStoreNames.contains("mutations"))
      request.result.createObjectStore("mutations",{keyPath:"id"});
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Could not open bucket sync queue."));
});
async function bucketQueueRead(){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readonly");
    const req=tx.objectStore("mutations").getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error||new Error("Could not read bucket changes."));
  });
}
async function bucketQueueWrite(mutation){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readwrite");
    const store=tx.objectStore("mutations");
    const req=store.getAll();
    req.onsuccess=()=>{
      const existing=(req.result||[]).filter(entry=>entry.userId===session.user.id&&entry.itemId===mutation.itemId);
      if(mutation.type==="delete"){
        existing.forEach(entry=>store.delete(entry.id));
        store.put(mutation);
      }else{
        if(existing.some(entry=>entry.type==="delete"))return;
        const prior=existing.find(entry=>entry.type==="patch");
        existing.filter(entry=>entry!==prior).forEach(entry=>store.delete(entry.id));
        if(prior)store.put({...prior,changes:{...(prior.changes||{}),...(mutation.changes||{})}});
        else store.put(mutation);
      }
    };
    req.onerror=()=>reject(req.error||new Error("Could not read pending bucket changes."));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error("Could not save bucket change."));
    tx.onabort=()=>reject(tx.error||new Error("Bucket change was not saved."));
  });
}
async function bucketQueueRemove(id){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readwrite");
    tx.objectStore("mutations").delete(id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||new Error("Could not clear synced bucket change."));
  });
}
let bucketFlushPromise=null;
async function flushBucketChanges(){
  if(bucketFlushPromise)return bucketFlushPromise;
  bucketFlushPromise=(async()=>{
    const pending=(await bucketQueueRead()).filter(entry=>entry.userId===session.user.id).sort((a,b)=>a.createdAt-b.createdAt);
    for(const entry of pending){
      if(entry.type==="delete")await bucketAction("delete",{id:entry.itemId});
      else{
        if(typeof entry.changes?.name==="string")
          await bucketAction("rename",{id:entry.itemId,name:entry.changes.name});
        const metadata={...entry.changes};
        delete metadata.name;
        if(Object.keys(metadata).length)
          await bucketAction("update_metadata",{id:entry.itemId,...metadata});
      }
      await bucketQueueRemove(entry.id);
    }
  })().catch(error=>{
    console.warn("Bucket changes remain queued until the next sync:",error.message);
  }).finally(()=>{bucketFlushPromise=null;});
  return bucketFlushPromise;
}
async function queueBucketChange(type,itemId,changes={}){
  const mutation={id:crypto.randomUUID(),userId:session.user.id,type,itemId,changes,createdAt:Date.now()};
  await bucketQueueWrite(mutation);
  if(type==="delete"){
    const removed=bucketDescendantIds(itemId);
    analyticsBucketItems=analyticsBucketItems.filter(item=>!removed.has(item.id));
  }else{
    const item=analyticsBucketItems.find(value=>value.id===itemId);
    if(item)Object.assign(item,changes);
  }
  renderBucketStructure();
  updateBucketCounts();
}
function updateBucketCounts(){
  const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
  const ids=new Set();
  for(const bucket of buckets)for(const id of bucketDescendantIds(bucket.id))ids.add(id);
  $("bucket-count").textContent=String(buckets.length);
  $("file-count").textContent=String(analyticsBucketItems.filter(item=>item.item_type==="file"&&ids.has(item.id)).length);
}
window.setInterval(()=>{void flushBucketChanges();},5000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")void flushBucketChanges();});
window.addEventListener("pagehide",()=>{void flushBucketChanges();});

const bucketMenu=document.createElement("div");
bucketMenu.className="bucket-context-menu";
bucketMenu.hidden=true;
bucketMenu.setAttribute("role","menu");
document.body.append(bucketMenu);
let bucketMenuItem=null;
function hideBucketMenu(){
  bucketMenu.classList.remove("is-open");
  bucketMenu.hidden=true;
  bucketMenuItem=null;
}
function addBucketMenuButton(label,action,danger=false){
  const button=document.createElement("button");
  button.type="button";
  button.className="bucket-menu-action"+(danger?" danger":"");
  button.textContent=label;
  button.dataset.action=action;
  button.setAttribute("role","menuitem");
  bucketMenu.append(button);
  return button;
}
function showBucketMenu(item,x,y){
  bucketMenuItem=item;
  bucketMenu.replaceChildren();
  if(item.item_type==="folder"){
    addBucketMenuButton("Add file","add-file");
    addBucketMenuButton("Add folder","add-folder");
    addBucketMenuButton("Drag & drop","drag-drop");
    const divider=document.createElement("div");
    divider.className="bucket-menu-divider";
    bucketMenu.append(divider);
  }
  addBucketMenuButton("Rename","rename");
  if(item.item_type==="folder"){
    const colorButton=addBucketMenuButton("Colour","colour");
    const palette=document.createElement("div");
    palette.className="bucket-menu-palette";
    palette.hidden=true;
    for(const color of ["#e6b325","#3b82f6","#22a06b","#a855f7","#ef4444","#6b7280"]){
      const choice=document.createElement("button");
      choice.type="button";
      choice.className="bucket-menu-color";
      choice.dataset.color=color;
      choice.style.setProperty("--swatch",color);
      choice.title=color;
      choice.setAttribute("aria-label","Set folder colour "+color);
      palette.append(choice);
    }
    bucketMenu.append(palette);
    colorButton.addEventListener("click",()=>{palette.hidden=!palette.hidden;});
  }
  const divider=document.createElement("div");
  divider.className="bucket-menu-divider";
  bucketMenu.append(divider);
  addBucketMenuButton("Delete","delete",true);
  bucketMenu.hidden=false;
  bucketMenu.style.left="0px";
  bucketMenu.style.top="0px";
  bucketMenu.classList.remove("is-open");
  requestAnimationFrame(()=>{
    const rect=bucketMenu.getBoundingClientRect();
    bucketMenu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";
    bucketMenu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px";
    requestAnimationFrame(()=>bucketMenu.classList.add("is-open"));
  });
}
const bucketTree=$("bucket-tree");
bucketTree.addEventListener("contextmenu",event=>{
  const node=event.target.closest(".tree-item[data-item-id]");
  if(!node)return;
  const item=analyticsBucketItems.find(value=>value.id===node.dataset.itemId);
  if(!item)return;
  event.preventDefault();
  showBucketMenu(item,event.clientX,event.clientY);
});
bucketTree.addEventListener("click",async event=>{
  const file=event.target.closest(".file-item[data-item-id]");
  if(!file)return;
  const item=analyticsBucketItems.find(value=>value.id===file.dataset.itemId);
  if(!item)return;
  const tab=window.open("about:blank","_blank");
  try{
    const result=await bucketAction("file_preview",{id:item.id});
    if(tab)tab.location=result.downloadUrl;
    else location.assign(result.downloadUrl);
  }catch(error){
    if(tab)tab.close();
    alert("Could not open file: "+error.message);
  }
});
document.addEventListener("click",async event=>{
  if(!bucketMenu.hidden&&!event.target.closest(".bucket-context-menu"))hideBucketMenu();
  const actionButton=event.target.closest(".bucket-menu-action,.bucket-menu-color");
  if(!actionButton||bucketMenu.hidden||!bucketMenuItem)return;
  event.preventDefault();
  event.stopPropagation();
  const item=bucketMenuItem;
  const action=actionButton.dataset.action;
  if(action==="colour"||actionButton.dataset.color)return;
  hideBucketMenu();
  if(action==="add-file"||action==="drag-drop"){
    openBucketUpload(item);
  }else if(action==="add-folder"){
    const name=prompt("New folder name");
    if(!name?.trim())return;
    try{
      const result=await bucketAction("create_folder",{parentId:item.id,name:name.trim()});
      analyticsBucketItems.push(result.item);
      renderBucketStructure();updateBucketCounts();
    }catch(error){alert("Could not create folder: "+error.message);}
  }else if(action==="rename"){
    const name=prompt("Rename item",item.name);
    if(!name?.trim()||name.trim()===item.name)return;
    try{await queueBucketChange("patch",item.id,{name:name.trim()});}
    catch(error){alert("Could not queue rename: "+error.message);}
  }else if(action==="delete"){
    if(!confirm("Delete “"+item.name+"”"+(item.item_type==="folder"?" and everything inside it":"")+"?"))return;
    try{await queueBucketChange("delete",item.id);}
    catch(error){alert("Could not queue deletion: "+error.message);}
  }
});
bucketMenu.addEventListener("click",async event=>{
  const choice=event.target.closest(".bucket-menu-color[data-color]");
  if(!choice||!bucketMenuItem)return;
  const item=bucketMenuItem;
  const color=choice.dataset.color;
  hideBucketMenu();
  try{await queueBucketChange("patch",item.id,{folder_color:color});}
  catch(error){alert("Could not queue folder colour: "+error.message);}
});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){hideBucketMenu();closeBucketUpload();}});

const bucketUploadOverlay=document.createElement("div");
bucketUploadOverlay.className="bucket-upload-overlay";
bucketUploadOverlay.hidden=true;
bucketUploadOverlay.innerHTML='<section class="bucket-upload-panel" role="dialog" aria-modal="true" aria-labelledby="bucket-upload-title"><header><div><h2 id="bucket-upload-title">Upload to folder</h2><p id="bucket-upload-target"></p></div><button type="button" class="bucket-upload-close" aria-label="Close">×</button></header><div class="bucket-drop-zone" tabindex="0"><div class="bucket-drop-icon">↑</div><strong>Drag files or folders here</strong><span>or choose something from your device</span><div class="bucket-upload-buttons"><button type="button" data-pick="files">Choose files</button><button type="button" data-pick="folder">Choose folder</button></div><p class="bucket-upload-status" aria-live="polite">Files will be uploaded into this folder.</p></div></section>';
document.body.append(bucketUploadOverlay);
const bucketFilePicker=document.createElement("input");
bucketFilePicker.type="file";bucketFilePicker.multiple=true;bucketFilePicker.hidden=true;
const bucketFolderPicker=document.createElement("input");
bucketFolderPicker.type="file";bucketFolderPicker.multiple=true;bucketFolderPicker.setAttribute("webkitdirectory","");
bucketFolderPicker.hidden=true;
document.body.append(bucketFilePicker,bucketFolderPicker);
let bucketUploadTarget=null,bucketUploadBusy=false;
function closeBucketUpload(){
  if(bucketUploadBusy)return;
  bucketUploadOverlay.hidden=true;
  bucketUploadTarget=null;
  bucketFilePicker.value="";
  bucketFolderPicker.value="";
}
function openBucketUpload(folder){
  bucketUploadTarget=folder;
  $("bucket-upload-target").textContent="Destination: "+folder.name;
  bucketUploadOverlay.hidden=false;
  bucketUploadOverlay.querySelector(".bucket-upload-status").textContent="Drop files or folders here, or choose from your device.";
}
bucketUploadOverlay.querySelector(".bucket-upload-close").addEventListener("click",closeBucketUpload);
bucketUploadOverlay.addEventListener("click",event=>{if(event.target===bucketUploadOverlay)closeBucketUpload();});
bucketUploadOverlay.querySelectorAll("[data-pick]").forEach(button=>button.addEventListener("click",()=>{
  (button.dataset.pick==="folder"?bucketFolderPicker:bucketFilePicker).click();
}));
const bucketDropZone=bucketUploadOverlay.querySelector(".bucket-drop-zone");
bucketDropZone.addEventListener("dragover",event=>{event.preventDefault();bucketDropZone.classList.add("drag-active");});
bucketDropZone.addEventListener("dragleave",event=>{if(!bucketDropZone.contains(event.relatedTarget))bucketDropZone.classList.remove("drag-active");});
bucketDropZone.addEventListener("drop",async event=>{
  event.preventDefault();bucketDropZone.classList.remove("drag-active");
  if(event.dataTransfer?.files?.length)await uploadBucketEntries(await extractBucketEntries(event.dataTransfer),bucketUploadTarget?.id);
});
bucketDropZone.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();bucketFilePicker.click();}});
bucketFilePicker.addEventListener("change",async()=>{
  const entries=[...bucketFilePicker.files].map(file=>({file,path:file.name}));
  await uploadBucketEntries(entries,bucketUploadTarget?.id);bucketFilePicker.value="";
});
bucketFolderPicker.addEventListener("change",async()=>{
  const entries=[...bucketFolderPicker.files].map(file=>({file,path:file.webkitRelativePath||file.name}));
  await uploadBucketEntries(entries,bucketUploadTarget?.id);bucketFolderPicker.value="";
});
async function readBucketDirectory(entry,path,output){
  if(entry.isFile){
    const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));
    output.push({file,path:path+entry.name});return;
  }
  if(entry.isDirectory){
    const reader=entry.createReader();
    while(true){
      const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      if(!batch.length)break;
      for(const child of batch)await readBucketDirectory(child,path+entry.name+"/",output);
    }
  }
}
async function extractBucketEntries(dataTransfer){
  const output=[];
  const entries=[...(dataTransfer.items||[])].filter(item=>item.kind==="file").map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
  if(entries.length){for(const entry of entries)await readBucketDirectory(entry,"",output);}
  else for(const file of [...(dataTransfer.files||[])])output.push({file,path:file.name});
  return output;
}
async function uploadBucketEntries(entries,parentId){
  if(!parentId||!entries.length||bucketUploadBusy)return;
  bucketUploadBusy=true;
  const status=bucketUploadOverlay.querySelector(".bucket-upload-status");
  const folderCache=new Map();
  let uploaded=0;
  try{
    for(const entry of entries){
      const parts=(entry.path||entry.file.name).split("/").filter(Boolean);
      if(!parts.length)continue;
      let parent=parentId;
      for(let index=0;index<parts.length-1;index++){
        const cacheKey=parent+":"+parts[index];
        if(!folderCache.has(cacheKey)){
          let folder=analyticsBucketItems.find(value=>value.item_type==="folder"&&value.parent_id===parent&&value.name===parts[index]);
          if(!folder){
            const result=await bucketAction("create_folder",{parentId:parent,name:parts[index]});
            folder=result.item;analyticsBucketItems.push(folder);
          }
          folderCache.set(cacheKey,folder.id);
        }
        parent=folderCache.get(cacheKey);
      }
      const name=parts[parts.length-1];
      status.textContent="Uploading "+(uploaded+1)+" of "+entries.length+": "+name;
      const created=await bucketAction("create_upload",{parentId:parent,name,contentType:entry.file.type||"application/octet-stream"});
      try{
        const response=await fetch(created.uploadUrl,{method:"PUT",headers:{"Content-Type":created.contentType},body:entry.file});
        if(!response.ok)throw new Error("Upload failed for "+name+" (HTTP "+response.status+").");
        await bucketAction("finish_upload",{id:created.item.id});
        analyticsBucketItems.push(created.item);
      }catch(error){
        await bucketAction("delete",{id:created.item.id}).catch(()=>{});
        throw error;
      }
      uploaded++;
    }
    status.textContent="Uploaded "+uploaded+" item(s) successfully.";
    renderBucketStructure();updateBucketCounts();
    setTimeout(()=>{if(!bucketUploadBusy)closeBucketUpload();},900);
  }catch(error){
    status.textContent="Upload stopped: "+error.message;
    renderBucketStructure();updateBucketCounts();
  }finally{bucketUploadBusy=false;}
}
async function loadBuckets(){
  const list=$("bucket-list");
  try{
    if(!analyticsBucketRootId){
      const {data:structure,error:structureError}=await supabase.functions.invoke(
        "coolanas-files-b2",{body:{action:"ensure_structure"}});
      if(structureError||structure?.error)throw new Error(structure?.error||structureError.message);
      analyticsBucketRootId=structure?.exhibitionsId||null;
    }
    const {data,error}=await supabase.functions.invoke(
      "coolanas-files-b2",{body:{action:"list"}});
    if(error||data?.error)throw new Error(data?.error||error.message);
    analyticsBucketItems=Array.isArray(data?.items)?data.items:[];
    const pendingBucketChanges=await bucketQueueRead().catch(()=>[]);
    for(const pending of pendingBucketChanges.filter(entry=>entry.userId===session.user.id).sort((a,b)=>a.createdAt-b.createdAt)){
      if(pending.type==="delete"){
        const removed=bucketDescendantIds(pending.itemId);
        analyticsBucketItems=analyticsBucketItems.filter(item=>!removed.has(item.id));
      }else{
        const item=analyticsBucketItems.find(value=>value.id===pending.itemId);
        if(item)Object.assign(item,pending.changes||{});
      }
    }
    const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
    const allBucketDescendants=new Set();
    for(const bucket of buckets)
      for(const id of bucketDescendantIds(bucket.id)) allBucketDescendants.add(id);
    const files=analyticsBucketItems.filter(item=>item.item_type==="file"&&allBucketDescendants.has(item.id));
    $("bucket-count").textContent=String(buckets.length);
    $("file-count").textContent=String(files.length);
    list.replaceChildren();
    renderBucketStructure();
  }catch(error){
    $("bucket-count").textContent="—";
    $("file-count").textContent="—";
    list.replaceChildren();
    $("bucket-tree").textContent=error.message||"Could not load your buckets.";
  }
}
renderTimer();
renderMonthlyChart();
void loadCloudAnalytics();
renderCalendar();
void loadCalendarSubjectColours().then(renderCalendarDetails);
void loadCalendarTasks().then(renderCalendarDetails);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadCalendarTasks().then(renderCalendarDetails); });
window.addEventListener("focus", () => { void loadCalendarTasks().then(renderCalendarDetails); });
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
