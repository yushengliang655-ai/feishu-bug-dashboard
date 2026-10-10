import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const projectKey = process.env.MEEGLE_PROJECT_KEY;
const workItemType = process.env.MEEGLE_WORK_ITEM_TYPE;
if (!projectKey || !workItemType) {
  throw new Error("Missing MEEGLE_PROJECT_KEY or MEEGLE_WORK_ITEM_TYPE.");
}

function runMeegle(args) {
  let executable = "meegle";
  let commandArgs = args;
  if (process.platform === "win32") {
    const shimPath = process.env.PATH.split(delimiter)
      .map(directory => join(directory, "meegle.cmd"))
      .find(path => path && existsSync(path));
    if (!shimPath) throw new Error("Could not find the Meegle CLI on PATH.");

    const shim = readFileSync(shimPath, "utf8");
    const entryPoint = shim.match(/"%dp0%\\([^"]+\.js)"\s+%\*/i)?.[1];
    if (!entryPoint) throw new Error("Could not resolve the Meegle CLI entry point from its Windows shim.");
    executable = process.execPath;
    commandArgs = [resolve(dirname(shimPath), entryPoint), ...args];
  }

  const output = execFileSync(executable, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  try {
    const result = JSON.parse(output);
    if (result.error) {
      throw new Error(result.error.message || "Meegle returned an API error.");
    }
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Meegle returned invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

function extractRows(result) {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error("Meegle query returned no grouped data; refusing to publish an incomplete snapshot.");
  }

  const rows = [];
  for (const groupRows of Object.values(result.data)) {
    if (!Array.isArray(groupRows)) {
      throw new Error("Meegle query returned an invalid group; refusing to publish an incomplete snapshot.");
    }
    rows.push(...groupRows);
  }
  return rows;
}

function readValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);

  for (const key of ["string_value", "long_value", "number_value", "bool_value"]) {
    if (value[key] !== null && value[key] !== undefined) return String(value[key]);
  }

  if (value.key_label_value) {
    return String(value.key_label_value.label ?? value.key_label_value.key ?? "");
  }
  if (Array.isArray(value.key_label_value_list)) {
    return value.key_label_value_list.map(item => {
      if (item && typeof item === "object") {
        return item.label ?? item.key ?? "";
      }
      const match = String(item).match(/label=(.*?)(?:}|$)/);
      return match ? match[1].trim() : String(item);
    }).filter(Boolean).join(", ");
  }

  return "";
}

function parseRecord(record) {
  if (!Array.isArray(record.moql_field_list)) {
    throw new Error("Meegle returned a work item without its field list; refusing to publish an incomplete snapshot.");
  }

  const fields = new Map(record.moql_field_list.map(field => [field.key, field.value]));
  const get = key => readValue(fields.get(key));
  const id = get("work_item_id").trim();
  const title = get("name").trim();
  const status = get("work_item_status").trim();
  const priority = get("priority").trim();
  const project = get("field_36f47a").trim() || "其它";
  const dateValue = get("start_time");
  const dateMatch = dateValue.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);

  if (!id || !title || !status || !priority) {
    throw new Error(`Bug ${id || "(unknown)"} is missing ID, title, status, or priority; the existing snapshot was not changed.`);
  }

  return {
    id,
    title,
    status,
    priority,
    project,
    date: dateMatch ? dateMatch[0].replaceAll("/", "-") : "未设置"
  };
}

const mql = `SELECT \`work_item_id\`, \`name\`, \`work_item_status\`, \`priority\`, \`start_time\`, \`archiving_date\`, \`field_36f47a\` FROM \`${projectKey}\`.\`${workItemType}\``;
const firstPage = runMeegle(["workitem", "query", "--project-key", projectKey, "--mql", mql, "--format", "json"]);
const list = firstPage.list;
if (!Array.isArray(list) || !list.length || !Array.isArray(list[0].group_infos)) {
  throw new Error("Meegle query returned no page metadata; refusing to publish an empty or incomplete snapshot.");
}

const count = Number(list[0].count);
const sessionId = String(firstPage.session_id || "");
if (!Number.isSafeInteger(count) || count < 0) {
  throw new Error("Meegle query did not return a valid work-item count.");
}

const pageCount = Math.ceil(count / 50);
const groupId = String(list[0].group_infos[0]?.group_id || "");
if (pageCount > 1 && (!sessionId || !groupId)) {
  throw new Error("Meegle query did not return the session and group metadata required for pagination.");
}

const records = extractRows(firstPage);
for (let pageNum = 2; pageNum <= pageCount; pageNum++) {
  const next = runMeegle([
    "workitem", "query", "--project-key", projectKey, "--session-id", sessionId,
    "--group-pagination-list", JSON.stringify([{ group_id: groupId, page_num: pageNum }]),
    "--format", "json"
  ]);
  records.push(...extractRows(next));
}

const byId = new Map();
for (const record of records) {
  const bug = parseRecord(record);
  if (byId.has(bug.id)) {
    throw new Error(`Meegle returned duplicate Bug ${bug.id}; refusing to publish an incomplete snapshot.`);
  }
  byId.set(bug.id, bug);
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
html = html.replace(/共 \d+ 条/, `共 ${bugs.length} 条`);
writeFileSync(htmlPath, html);
console.log(`Updated dashboard snapshot with ${bugs.length} work items.`);
