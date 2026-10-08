import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const projectKey = process.env.MEEGLE_PROJECT_KEY;
const workItemType = process.env.MEEGLE_WORK_ITEM_TYPE;
if (!process.env.MEEGLE_USER_ACCESS_TOKEN || !projectKey || !workItemType) {
  throw new Error("Missing MEEGLE_USER_ACCESS_TOKEN, MEEGLE_PROJECT_KEY, or MEEGLE_WORK_ITEM_TYPE.");
}

function runMeegle(args) {
  const output = execFileSync("meegle", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Meegle returned invalid JSON: ${error.message}`);
  }
}

function readField(record, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const pending = [record];
  const visited = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, fieldValue] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase())) {
        if (fieldValue && typeof fieldValue === "object") {
          const nested = fieldValue.value ?? fieldValue.label ?? fieldValue.name ?? fieldValue.text;
          if (nested !== undefined && nested !== null) return String(nested);
        }
        if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== "object") return String(fieldValue);
      }
      if (fieldValue && typeof fieldValue === "object") pending.push(fieldValue);
    }
  }
  return "";
}

function collectRecords(value, output = [], visited = new Set()) {
  if (!value || typeof value !== "object" || visited.has(value)) return output;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, output, visited);
    return output;
  }
  const id = readField(value, ["work_item_id", "workItemId", "id"]);
  const title = readField(value, ["name", "title"]);
  if (id && title) output.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") collectRecords(child, output, visited);
  }
  return output;
}

const mql = `SELECT \`work_item_id\`, \`name\`, \`work_item_status\`, \`priority\`, \`created_at\` FROM \`${projectKey}\`.\`${workItemType}\` WHERE \`archiving_date\` IS NULL`;
const firstPage = runMeegle(["workitem", "query", "--project-key", projectKey, "--mql", mql, "--format", "json"]);
const list = firstPage.list;
if (!Array.isArray(list) || !list.length) {
  throw new Error("Meegle query returned no page metadata; refusing to publish an empty or incomplete snapshot.");
}
const count = Number(list[0].count);
const sessionId = String(firstPage.session_id || "");
if (!Number.isFinite(count) || count < 1 || !sessionId) {
  throw new Error("Meegle query did not return a valid count and session_id.");
}

const pageCount = Math.ceil(count / 50);
const records = collectRecords(firstPage);
for (let pageNum = 2; pageNum <= pageCount; pageNum++) {
  const next = runMeegle([
    "workitem", "query", "--project-key", projectKey, "--session-id", sessionId,
    "--group-pagination-list", JSON.stringify([{ group_id: "1", page_num: pageNum }]), "--format", "json"
  ]);
  records.push(...collectRecords(next));
}

const byId = new Map();
for (const record of records) {
  const id = readField(record, ["work_item_id", "workItemId", "id"]);
  const title = readField(record, ["name", "title"]).trim();
  const status = readField(record, ["work_item_status", "status", "state"]).trim();
  const priority = readField(record, ["priority"]).trim();
  const project = readField(record, ["project", "project_name", "module"]).trim() || "其它";
  const dateValue = readField(record, ["created_at", "created_time", "create_time", "createdAt"]);
  const dateMatch = dateValue.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  if (!id || !title || !status || !priority) {
    throw new Error(`Bug ${id || "(unknown)"} is missing ID, title, status, or priority; the existing snapshot was not changed.`);
  }
  byId.set(id, {
    id,
    title,
    status,
    priority,
    project,
    date: dateMatch ? dateMatch[0].replaceAll("/", "-") : "未设置"
  });
}

const bugs = [...byId.values()];
if (bugs.length !== count) {
  throw new Error(`Expected ${count} unique work items from Meegle, but parsed ${bugs.length}; refusing to publish incomplete data.`);
}

const htmlPath = new URL("../index.html", import.meta.url);
let html = readFileSync(htmlPath, "utf8");
const start = html.indexOf("    const bugs = [");
const end = html.indexOf("\n    ];", start);
if (start < 0 || end < 0) throw new Error("Could not locate the dashboard's embedded bug snapshot.");
const generated = `    const bugs = ${JSON.stringify(bugs, null, 6).replace(/\n/g, "\n    ")};`;
html = `${html.slice(0, start)}${generated}${html.slice(end + 7)}`;
html = html.replace(/数据快照 \d{4}\/\d{2}\/\d{2}/, `数据快照 ${new Date().toISOString().slice(0, 10).replaceAll("-", "/")}`);
writeFileSync(htmlPath, html);
console.log(`Updated dashboard snapshot with ${bugs.length} work items.`);
