#!/usr/bin/env node
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const API_KEY = process.env.CLICKUP_API_KEY;
const API_BASE = 'https://api.clickup.com/api/v2';

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function writeToolResult(id, text) {
  writeResponse(id, { content: [{ type: 'text', text }] });
}

async function clickupRequest(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: API_KEY,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ClickUp API error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function resolveCustomFieldValue(field) {
  if (!field) return null;
  if (field.type === 'drop_down' && field.value !== null && field.value !== undefined) {
    const option = field.type_config?.options?.find((o) => o.orderindex === field.value);
    return option?.name ?? field.value;
  }
  return field.value ?? null;
}

function summarizeTask(task) {
  return {
    id: task.id,
    name: task.name,
    status: task.status?.status,
    url: task.url,
    due_date: task.due_date ? new Date(Number(task.due_date)).toISOString() : null,
    date_updated: task.date_updated ? new Date(Number(task.date_updated)).toISOString() : null,
    assignees: (task.assignees ?? []).map((a) => a.username),
    custom_fields: (task.custom_fields ?? [])
      .map((f) => ({ id: f.id, name: f.name, value: resolveCustomFieldValue(f) }))
      .filter((f) => f.value !== null)
  };
}

const TOOLS = [
  {
    name: 'attachTaskFile',
    description: 'Upload a local file as an attachment to a ClickUp task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The ClickUp task ID (6-9 chars, e.g. 86agx42zw)' },
        file_path: { type: 'string', description: 'Absolute path to the local file to upload' }
      },
      required: ['task_id', 'file_path']
    }
  },
  {
    name: 'getTask',
    description: 'Fetch a ClickUp task: name, status, due date, assignees, custom fields, last activity.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The ClickUp task ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'updateTask',
    description: 'Update a ClickUp task status, name, and/or due date.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', description: 'Status name exactly as configured in the ClickUp space' },
        name: { type: 'string' },
        due_date: { type: 'string', description: 'ISO date/time string, or omit to leave unchanged' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'setCustomField',
    description: 'Set a custom field value on a task. For dropdown fields, pass the option label as it appears in ClickUp.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        field_id: { type: 'string' },
        value: { description: 'Option label (dropdown) or raw value (text/number fields)' }
      },
      required: ['task_id', 'field_id', 'value']
    }
  },
  {
    name: 'createComment',
    description: 'Add a plain-text comment to a ClickUp task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        comment_text: { type: 'string' }
      },
      required: ['task_id', 'comment_text']
    }
  }
];

async function handleAttachTaskFile(id, { task_id, file_path } = {}) {
  if (!API_KEY) return writeError(id, -32000, 'CLICKUP_API_KEY not set');
  if (!task_id || !file_path) return writeError(id, -32602, 'task_id and file_path are required');

  let fileBuffer;
  try {
    fileBuffer = await readFile(file_path);
  } catch (e) {
    return writeError(id, -32000, `Cannot read file: ${e.message}`);
  }

  const fileName = basename(file_path);
  const boundary = `----ClickUpBoundary${Date.now()}`;
  const CRLF = '\r\n';
  const head = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="attachment"; filename="${fileName}"`,
    `Content-Type: application/octet-stream`,
    '',
    ''
  ].join(CRLF);
  const tail = `${CRLF}--${boundary}--${CRLF}`;
  const body = Buffer.concat([Buffer.from(head), fileBuffer, Buffer.from(tail)]);

  let res, json;
  try {
    res = await fetch(`${API_BASE}/task/${task_id}/attachment`, {
      method: 'POST',
      headers: { Authorization: API_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    json = await res.json();
  } catch (e) {
    return writeError(id, -32000, `Request failed: ${e.message}`);
  }
  if (!res.ok) return writeError(id, -32000, `ClickUp API error ${res.status}: ${JSON.stringify(json)}`);

  writeToolResult(id, JSON.stringify({
    status: 'ok',
    attachment: { id: json.id, title: json.title ?? fileName, url: json.url }
  }, null, 2));
}

async function handleGetTask(id, { task_id } = {}) {
  if (!API_KEY) return writeError(id, -32000, 'CLICKUP_API_KEY not set');
  if (!task_id) return writeError(id, -32602, 'task_id is required');

  try {
    const task = await clickupRequest('GET', `/task/${task_id}`);
    writeToolResult(id, JSON.stringify(summarizeTask(task), null, 2));
  } catch (e) {
    writeError(id, -32000, e.message);
  }
}

async function handleUpdateTask(id, { task_id, status, name, due_date } = {}) {
  if (!API_KEY) return writeError(id, -32000, 'CLICKUP_API_KEY not set');
  if (!task_id) return writeError(id, -32602, 'task_id is required');

  const body = {};
  if (status !== undefined) body.status = status;
  if (name !== undefined) body.name = name;
  if (due_date !== undefined) body.due_date = new Date(due_date).getTime();

  if (Object.keys(body).length === 0) {
    return writeError(id, -32602, 'Provide at least one of: status, name, due_date');
  }

  try {
    const task = await clickupRequest('PUT', `/task/${task_id}`, body);
    writeToolResult(id, JSON.stringify(summarizeTask(task), null, 2));
  } catch (e) {
    writeError(id, -32000, e.message);
  }
}

async function handleSetCustomField(id, { task_id, field_id, value } = {}) {
  if (!API_KEY) return writeError(id, -32000, 'CLICKUP_API_KEY not set');
  if (!task_id || !field_id || value === undefined) {
    return writeError(id, -32602, 'task_id, field_id and value are required');
  }

  let resolvedValue = value;
  if (typeof value === 'string' && Number.isNaN(Number(value))) {
    // Dropdown fields take the option's orderindex, not its label — resolve by label.
    try {
      const task = await clickupRequest('GET', `/task/${task_id}`);
      const field = (task.custom_fields ?? []).find((f) => f.id === field_id);
      const option = field?.type_config?.options?.find(
        (o) => o.name.toLowerCase() === value.toLowerCase()
      );
      if (option) resolvedValue = option.orderindex;
    } catch (e) {
      return writeError(id, -32000, `Could not resolve dropdown option: ${e.message}`);
    }
  }

  try {
    await clickupRequest('POST', `/task/${task_id}/field/${field_id}`, { value: resolvedValue });
    writeToolResult(id, JSON.stringify({ status: 'ok', task_id, field_id, value: resolvedValue }, null, 2));
  } catch (e) {
    writeError(id, -32000, e.message);
  }
}

async function handleCreateComment(id, { task_id, comment_text } = {}) {
  if (!API_KEY) return writeError(id, -32000, 'CLICKUP_API_KEY not set');
  if (!task_id || !comment_text) return writeError(id, -32602, 'task_id and comment_text are required');

  try {
    const comment = await clickupRequest('POST', `/task/${task_id}/comment`, { comment_text });
    writeToolResult(id, JSON.stringify({ status: 'ok', id: comment.id }, null, 2));
  } catch (e) {
    writeError(id, -32000, e.message);
  }
}

const HANDLERS = {
  attachTaskFile: handleAttachTaskFile,
  getTask: handleGetTask,
  updateTask: handleUpdateTask,
  setCustomField: handleSetCustomField,
  createComment: handleCreateComment
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let req;
  try { req = JSON.parse(trimmed); } catch { continue; }

  const { id, method, params } = req;
  if (id === undefined) continue;

  if (method === 'initialize') {
    writeResponse(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      serverInfo: { name: 'clickup', version: '1.0.0' },
      capabilities: { tools: {} }
    });
  } else if (method === 'tools/list') {
    writeResponse(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    const handler = HANDLERS[name];
    if (handler) {
      await handler(id, args);
    } else {
      writeError(id, -32601, `Unknown tool: ${name}`);
    }
  } else {
    writeResponse(id, {});
  }
}
