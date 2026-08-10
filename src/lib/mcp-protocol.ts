import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import { queryEvents, parseEventQueryFromToolArgs, buildEventSummaryText } from "./queries.ts";
import { withRetry } from "./db.ts";
import { formatWithOffset } from "./timezone.ts";


const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

const MCP_SERVER_INFO = {
  name: "device-event-logger",
  title: "User Device Event Logger",
  version: "1.0.0",
  description: "Query user device event records from a database. Read-only.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 6 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description: "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description: "End time in ISO 8601 format. Defaults to now.",
      },
      type: {
        type: "string",
        description:
          "Event type filter (dot-separated lowercase alphanumeric, e.g. 'app.open'). Prefix match when no dot is present; exact match otherwise. Use the list_event_types tool to discover available types.",
      },
      value: {
        type: "string",
        description: "Exact value filter.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of events to return. Default 100, max 1000.",
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "integer",
        description: "Pagination offset. Default 0.",
        minimum: 0,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            type: { type: "string" },
            value: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
            ts: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["id", "type", "value", "ts"],
        },
      },
    },
    required: ["total", "events"],
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description:
    "List all distinct event types currently stored in the database. Use this to discover available types before querying events.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      types: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["types"],
  },
};
const GET_APP_USAGE_TOOL = {
  name: "get_app_usage",
  title: "Get App Usage",
  description:
    "Estimate app usage duration and open counts from app.open and app.close events.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description:
          "Look back N hours. Defaults to 6 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description:
          "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description:
          "End time in ISO 8601 format. Defaults to now.",
      },
      value: {
        type: "string",
        description:
          "Optional exact app name filter, for example 抖音 or kelivo.",
      },
      maxSessionMinutes: {
        type: "number",
        description:
          "Maximum duration counted for one session. Defaults to 30 minutes.",
        minimum: 0.001,
        maximum: 1440,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      since: { type: "string" },
      until: { type: "string" },
      totalSeconds: { type: "integer" },
      apps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            app: { type: "string" },
            durationSeconds: { type: "integer" },
            opens: { type: "integer" },
          },
          required: ["app", "durationSeconds", "opens"],
        },
      },
    },
    required: ["since", "until", "totalSeconds", "apps"],
  },
};


function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !Object.prototype.hasOwnProperty.call(message, "id");
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "result") ||
    Object.prototype.hasOwnProperty.call(message, "error");
}

function getProtocolVersionFromHeaders(c: Context): string {
  const header = c.req.header("mcp-protocol-version")?.trim();
  return header || DEFAULT_MCP_PROTOCOL_VERSION;
}

async function callQueryEventsTool(args: Record<string, unknown>, sql: postgres.Sql, offsetMinutes: number) {
  const parsed = parseEventQueryFromToolArgs(args);
  if (typeof parsed === "string") {
    return { content: [{ type: "text", text: parsed }], isError: true };
  }
  try {
    const result = await queryEvents(parsed, sql, offsetMinutes);
    return {
      content: [{ type: "text", text: buildEventSummaryText(result.events, result.total) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP query_events failed:", error);
    return { content: [{ type: "text", text: "Database error while querying events." }], isError: true };
  }
}

async function callListEventTypesTool(sql: postgres.Sql) {
  try {
    const rows = await withRetry(() =>
      sql.unsafe("SELECT DISTINCT type FROM events ORDER BY type")
    );
    const types = rows.map((r: Record<string, unknown>) => String(r.type));
    return {
      content: [{ type: "text", text: types.length ? types.join("\n") : "No event types found." }],
      structuredContent: { types },
      isError: false,
    };
  } catch (error) {
    console.error("MCP list_event_types failed:", error);
    return { content: [{ type: "text", text: "Database error while listing event types." }], isError: true };
  }
}

async function callGetAppUsageTool(
  args: Record,
  sql: postgres.Sql,
  offsetMinutes: number,
) {
  const parsed = parseAppUsageToolArgs(args);

  if (typeof parsed === "string") {
    return {
      content: [{ type: "text", text: parsed }],
      isError: true,
    };
  }

  try {
    const result = await queryAppUsage(
      parsed,
      sql,
      offsetMinutes,
    );

    return {
      content: [
        {
          type: "text",
          text: buildAppUsageSummaryText(result),
        },
      ],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP get_app_usage failed:", error);

    return {
      content: [
        {
          type: "text",
          text: "Database error while calculating app usage.",
        },
      ],
      isError: true,
    };
  }
}

async function handleMcpRequest(message: JsonRpcMessage, sql: postgres.Sql, offsetMinutes: number) {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params = (message.params && typeof message.params === "object")
    ? message.params as Record<string, unknown>
    : {};

  switch (method) {
    case "initialize": {
      const requestedVersion = typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : "";
      if (!requestedVersion || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)) {
        return jsonRpcError(id, -32602, "Unsupported protocolVersion", {
          supported: Array.from(SUPPORTED_MCP_PROTOCOL_VERSIONS),
        });
      }
      return jsonRpcResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "This server provides read-only access to user device event records. Use list_event_types to discover available event types, then use query_events to query records by time range, type, and value.",
      });
    }
    case "notifications/initialized":
      return null;
    case "ping":
      return jsonRpcResult(id, {});
    case "tools/list":
      return jsonRpcResult(id, {
        tools: [QUERY_EVENTS_TOOL, LIST_EVENT_TYPES_TOOL,
  GET_APP_USAGE_TOOL,],
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === LIST_EVENT_TYPES_TOOL.name) {
        return jsonRpcResult(id, await callListEventTypesTool(sql));
      }
      if (name === GET_APP_USAGE_TOOL.name) {
  const args =
    params.arguments && typeof params.arguments === "object"
      ? params.arguments as Record
      : {};

  return jsonRpcResult(
    id,
    await callGetAppUsageTool(args, sql, offsetMinutes),
  );
}

      if (name !== QUERY_EVENTS_TOOL.name) {
        return jsonRpcError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
      }
      const args = (params.arguments && typeof params.arguments === "object")
        ? params.arguments as Record<string, unknown>
        : {};
      return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
    }
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method || "(empty)"}`);
  }
}

export async function handleMcpPost(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;

  // Validate protocol version header
  const version = c.req.header("mcp-protocol-version")?.trim();
  if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    return c.json({ error: `Unsupported MCP protocol version: ${version}` }, 400);
  }

  const protocolVersion = getProtocolVersionFromHeaders(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  // Batch handling — array of JSON-RPC messages
  if (Array.isArray(body)) {
    if (!body.length) {
      c.header("MCP-Protocol-Version", protocolVersion);
      return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
    }
    const responses: unknown[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      const message = item as JsonRpcMessage;
      if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) continue;
      if (!isJsonRpcRequest(message)) {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }
      responses.push(await handleMcpRequest(message, sql, offsetMinutes));
    }
    if (!responses.length) {
      return c.body(null, 202);
    }
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }

  // Single message handling
  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const message = body as JsonRpcMessage;
  if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) {
    return c.body(null, 202);
  }
  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }
  const response = await handleMcpRequest(message, sql, offsetMinutes);
  if (response == null) {
    return c.body(null, 202);
  }
  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
export type AppUsageQuery = {
  since: Date;
  until: Date;
  value?: string;
  maxSessionMinutes: number;
};

export type AppUsageItem = {
  app: string;
  durationSeconds: number;
  opens: number;
};

export type AppUsageResult = {
  since: string;
  until: string;
  totalSeconds: number;
  apps: AppUsageItem[];
};

export function parseAppUsageToolArgs(
  args: Record,
): AppUsageQuery | string {
  const rawHours = args.hours;
  const rawSince = args.since;
  const rawUntil = args.until;
  const rawValue = args.value;
  const rawMaxSessionMinutes = args.maxSessionMinutes;

  let since: Date;

  if (rawHours != null && rawHours !== "") {
    const hours = Number(rawHours);

    if (!Number.isFinite(hours) || hours <= 0) {
      return "Invalid 'hours'";
    }

    since = new Date(Date.now() - hours * 3_600_000);
  } else if (rawSince != null && String(rawSince).trim()) {
    since = new Date(String(rawSince));

    if (Number.isNaN(since.getTime())) {
      return "Invalid 'since' format";
    }
  } else {
    since = new Date(Date.now() - 6 * 3_600_000);
  }

  const until =
    rawUntil != null && String(rawUntil).trim()
      ? new Date(String(rawUntil))
      : new Date();

  if (Number.isNaN(until.getTime())) {
    return "Invalid 'until' format";
  }

  if (until.getTime() < since.getTime()) {
    return "'until' must be greater than or equal to 'since'";
  }

  const maxSessionMinutes =
    rawMaxSessionMinutes == null || rawMaxSessionMinutes === ""
      ? 30
      : Number(rawMaxSessionMinutes);

  if (
    !Number.isFinite(maxSessionMinutes) ||
    maxSessionMinutes <= 0 ||
    maxSessionMinutes > 1440
  ) {
    return "Invalid 'maxSessionMinutes'";
  }

  const value =
    rawValue == null || String(rawValue).trim() === ""
      ? undefined
      : String(rawValue);

  return {
    since,
    until,
    value,
    maxSessionMinutes,
  };
}

export async function queryAppUsage(
  query: AppUsageQuery,
  sql: postgres.Sql,
  offsetMinutes: number,
): Promise<AppUsageResult> {
  const rows = await withRetry(() =>
    sql.unsafe(
      `
        SELECT id, type, value, ts
        FROM events
        WHERE ts >= $1
          AND ts <= $2
          AND type IN ('app.open', 'app.close')
          AND value IS NOT NULL
        ORDER BY ts ASC, id ASC
      `,
      [query.since.toISOString(), query.until.toISOString()],
    )
  );

  const usage = new Map<
    string,
    { durationSeconds: number; opens: number }
  >();

  let activeApp: string | null = null;
  let activeSince: number | null = null;
  const maxSessionMs = query.maxSessionMinutes * 60_000;

  function ensureApp(app: string) {
    let item = usage.get(app);

    if (!item) {
      item = {
        durationSeconds: 0,
        opens: 0,
      };

      usage.set(app, item);
    }

    return item;
  }

  function finishSession(endMs: number) {
    if (activeApp == null || activeSince == null) return;

    const durationMs = Math.max(
      0,
      Math.min(endMs - activeSince, maxSessionMs),
    );

    ensureApp(activeApp).durationSeconds += Math.round(
      durationMs / 1000,
    );

    activeApp = null;
    activeSince = null;
  }

  for (const row of rows) {
    const type = String(row.type ?? "");
    const app = row.value == null ? "" : String(row.value);
    const timestamp = new Date(String(row.ts)).getTime();

    if (!app || Number.isNaN(timestamp)) continue;

    if (type === "app.open") {
      // 打开任何新 App，都视为上一个前台 App 已结束。
      finishSession(timestamp);

      const item = ensureApp(app);
      item.opens += 1;

      activeApp = app;
      activeSince = timestamp;
      continue;
    }

    if (
      type === "app.close" &&
      activeApp === app &&
      activeSince != null
    ) {
      finishSession(timestamp);
    }
  }

  finishSession(query.until.getTime());

  let apps = Array.from(usage.entries()).map(([app, item]) => ({
    app,
    durationSeconds: item.durationSeconds,
    opens: item.opens,
  }));

  if (query.value) {
    apps = apps.filter((item) => item.app === query.value);
  }

  apps.sort(
    (a, b) =>
      b.durationSeconds - a.durationSeconds ||
      b.opens - a.opens ||
      a.app.localeCompare(b.app),
  );

  return {
    since: formatWithOffset(query.since, offsetMinutes),
    until: formatWithOffset(query.until, offsetMinutes),
    totalSeconds: apps.reduce(
      (sum, item) => sum + item.durationSeconds,
      0,
    ),
    apps,
  };
}

export function buildAppUsageSummaryText(
  result: AppUsageResult,
): string {
  if (!result.apps.length) {
    return "No app usage found in this time range.";
  }

  const formatDuration = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  };

  return [
    `Estimated total app usage: ${formatDuration(result.totalSeconds)}.`,
    ...result.apps.map(
      (item) =>
        `- ${item.app}: ${formatDuration(item.durationSeconds)} (${item.opens} open(s))`,
    ),
  ].join("\n");
}

