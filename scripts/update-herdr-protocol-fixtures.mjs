#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST_METHODS = [
  "ping", "session.snapshot", "workspace.get", "workspace.list",
  "tab.create", "tab.get", "tab.list", "tab.close",
  "pane.current", "pane.get", "pane.list", "pane.layout", "pane.process_info",
  "pane.send_input", "pane.send_keys", "pane.close",
  "agent.start", "agent.get", "agent.list", "agent.read", "agent.focus",
  "events.subscribe", "events.wait",
  "worktree.list", "worktree.create", "worktree.open", "worktree.remove",
];
const RESULT_TYPES = [
  "pong", "session_snapshot", "workspace_info", "workspace_list",
  "tab_created", "tab_info", "tab_list", "pane_current", "pane_info", "pane_list",
  "pane_layout", "pane_process_info", "agent_started", "agent_info", "agent_list",
  "pane_read", "subscription_started", "wait_matched", "ok",
  "worktree_list", "worktree_created", "worktree_opened", "worktree_removed",
];
const EVENT_TYPES = [
  "workspace_created", "workspace_updated", "workspace_closed", "workspace_focused",
  "tab_created", "tab_closed", "tab_focused", "pane_created", "pane_closed",
  "pane_focused", "pane_moved", "pane_exited", "pane_agent_status_changed", "layout_updated",
  "worktree_created", "worktree_opened", "worktree_removed",
];

function collectDefinitions(root, fragments, section) {
  const names = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      const prefix = `#/schemas/${section}/$defs/`;
      if (value.$ref.startsWith(prefix)) {
        const name = value.$ref.slice(prefix.length);
        if (!names.has(name)) {
          names.add(name);
          visit(root.$defs[name]);
        }
      }
    }
    Object.values(value).forEach(visit);
  };
  fragments.forEach(visit);
  return Object.fromEntries([...names].sort().map((name) => [name, root.$defs[name]]));
}

const raw = execFileSync("herdr", ["api", "schema", "--json"], { encoding: "utf8", maxBuffer: 2_000_000 });
const schema = JSON.parse(raw);
if (schema.protocol !== 16) throw new Error(`Expected protocol 16, received ${schema.protocol}`);
const requestVariants = Object.fromEntries(REQUEST_METHODS.map((method) => {
  const variant = schema.schemas.request.oneOf.find((item) => item.properties?.method?.const === method);
  if (!variant) throw new Error(`Missing request method ${method}`);
  return [method, variant];
}));
const resultVariants = Object.fromEntries(RESULT_TYPES.map((type) => {
  const variant = schema.schemas.success_response.$defs.ResponseResult.oneOf.find((item) => item.properties?.type?.const === type);
  if (!variant) throw new Error(`Missing result type ${type}`);
  return [type, variant];
}));
const eventVariants = Object.fromEntries(EVENT_TYPES.map((type) => {
  const variant = schema.schemas.event.$defs.EventData.oneOf.find((item) => item.properties?.type?.const === type);
  if (!variant) throw new Error(`Missing event type ${type}`);
  return [type, variant];
}));
const requestFragments = Object.values(requestVariants);
const responseFragments = Object.values(resultVariants);
const eventFragments = Object.values(eventVariants);
const fixture = {
  source: {
    command: "herdr api schema --json",
    herdr_version: execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim().replace(/^herdr\s+/, ""),
    protocol: schema.protocol,
    schema_version: schema.schema_version,
    raw_bytes: Buffer.byteLength(raw),
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
  },
  request: {
    envelope: Object.fromEntries(Object.entries(schema.schemas.request).filter(([key]) => !["oneOf", "$defs"].includes(key))),
    methods: requestVariants,
    definitions: collectDefinitions(schema.schemas.request, requestFragments, "request"),
  },
  success_response: {
    envelope: Object.fromEntries(Object.entries(schema.schemas.success_response).filter(([key]) => key !== "$defs")),
    result_types: resultVariants,
    definitions: collectDefinitions(schema.schemas.success_response, responseFragments, "success_response"),
  },
  error_response: schema.schemas.error_response,
  event: {
    envelope: Object.fromEntries(Object.entries(schema.schemas.event).filter(([key]) => key !== "$defs")),
    event_types: eventVariants,
    definitions: collectDefinitions(schema.schemas.event, eventFragments, "event"),
  },
  subscription_event: schema.schemas.subscription_event,
};
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../tests/fixtures/herdr-protocol-16.schema.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${output}\nsource ${fixture.source.raw_bytes} bytes sha256 ${fixture.source.raw_sha256}`);
