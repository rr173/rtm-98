const http = require('http');
const https = require('https');
const { URL } = require('url');
const { parseExpression, evaluateExpression, StructuredError } = require('./expression-parser');

const MAX_WEBHOOKS = 50;
const MAX_HISTORY = 50;
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT = 5;
const BATCH_WINDOW_MS = 100;
const INITIAL_BACKOFF_MS = 1000;

class WebhookEngine {
  constructor() {
    this.webhooks = new Map();
    this.webhookIdCounter = 0;
    this.pendingBatches = new Map();
  }

  validateTargetCell(cellName) {
    if (!cellName) {
      throw new Error('缺少必要参数: cell');
    }
    if (cellName !== '*' && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(cellName)) {
      throw new Error('目标单元格名称无效（或以字母开头，由字母、数字和下划线组成，或使用 * 匹配全部）');
    }
  }

  validateUrl(url) {
    if (!url) {
      throw new Error('缺少必要参数: url');
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('URL 协议必须是 http 或 https');
      }
    } catch (e) {
      throw new Error(`URL 格式无效: ${e.message}`);
    }
  }

  validateHeaders(headers) {
    if (headers === undefined || headers === null) return;
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw new Error('headers 必须是对象');
    }
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k !== 'string' || (typeof v !== 'string' && typeof v !== 'number')) {
        throw new Error('headers 的键值必须是字符串或数字');
      }
    }
  }

  validateCondition(condition, computeGraph) {
    if (condition === undefined || condition === null || condition === '') return;
    if (typeof condition !== 'string') {
      throw new Error('condition 必须是表达式字符串');
    }
    try {
      const { ast, dependencies } = parseExpression(condition);
      for (const dep of dependencies) {
        if (dep.includes('::')) continue;
        if (!computeGraph.cells.has(dep)) {
          throw new Error(`条件表达式引用的单元格 '${dep}' 不存在`);
        }
      }
      return { ast, dependencies };
    } catch (e) {
      if (e instanceof StructuredError) {
        throw new Error(`条件表达式无效: ${e.message}`);
      }
      throw new Error(`条件表达式无效: ${e.message}`);
    }
  }

  matchCell(webhookCell, changedCell) {
    if (webhookCell === '*') return true;
    return webhookCell === changedCell;
  }

  evaluateCondition(webhook, computeGraph) {
    if (!webhook.ast) return true;
    try {
      const cellResolver = (refName) => {
        if (refName.includes('::')) return null;
        return computeGraph.cells.get(refName);
      };
      const result = evaluateExpression(
        webhook.ast,
        cellResolver,
        webhook.condition,
        null
      );
      if (result.type === 'number') return result.value !== 0;
      if (result.type === 'string') return result.value !== '';
      return Boolean(result.value);
    } catch (e) {
      return false;
    }
  }

  getCellSnapshot(computeGraph, cellName) {
    const cell = computeGraph.cells.get(cellName);
    if (!cell) return null;
    return {
      name: cell.name,
      type: cell.type,
      value: cell.value ? cell.value.value : null,
      valueType: cell.value ? cell.value.type : null,
      error: cell.error || null
    };
  }

  buildGraphSnapshot(computeGraph, cellName) {
    const snapshot = {};
    snapshot[cellName] = this.getCellSnapshot(computeGraph, cellName);

    const cell = computeGraph.cells.get(cellName);
    if (cell) {
      const localDeps = (cell.dependencies || []).filter(d => !d.includes('::'));
      for (const dep of localDeps) {
        if (!snapshot[dep]) {
          snapshot[dep] = this.getCellSnapshot(computeGraph, dep);
        }
      }
      const downstream = computeGraph.getDownstream(cellName);
      for (const ds of downstream) {
        if (!snapshot[ds]) {
          snapshot[ds] = this.getCellSnapshot(computeGraph, ds);
        }
      }
    }
    return snapshot;
  }

  createWebhook(computeGraph, params) {
    const { cell, condition, url, headers, retries, timeout } = params;

    if (this.webhooks.size >= MAX_WEBHOOKS) {
      throw new Error(`最多支持 ${MAX_WEBHOOKS} 个 webhook 订阅`);
    }

    this.validateTargetCell(cell);
    this.validateUrl(url);
    this.validateHeaders(headers);

    let parsedCondition = null;
    if (condition !== undefined && condition !== null && condition !== '') {
      parsedCondition = this.validateCondition(condition, computeGraph);
    }

    const id = ++this.webhookIdCounter;
    const webhook = {
      id,
      cell,
      condition: condition || null,
      ast: parsedCondition ? parsedCondition.ast : null,
      url,
      headers: headers && typeof headers === 'object' && !Array.isArray(headers)
        ? Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]))
        : {},
      retries: retries !== undefined ? Math.max(0, Math.min(10, Number(retries))) : DEFAULT_RETRIES,
      timeout: timeout !== undefined ? Math.max(1, Math.min(60, Number(timeout))) : DEFAULT_TIMEOUT,
      enabled: true,
      paused: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      successCount: 0,
      failureCount: 0,
      lastTriggeredAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      history: []
    };

    this.webhooks.set(id, webhook);
    return this.getWebhookInfo(webhook);
  }

  getWebhookInfo(webhook) {
    return {
      id: webhook.id,
      cell: webhook.cell,
      condition: webhook.condition,
      url: webhook.url,
      headers: Object.keys(webhook.headers).length > 0 ? { ...webhook.headers } : undefined,
      retries: webhook.retries,
      timeout: webhook.timeout,
      enabled: webhook.enabled,
      paused: webhook.paused,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
      successCount: webhook.successCount,
      failureCount: webhook.failureCount,
      lastTriggeredAt: webhook.lastTriggeredAt,
      lastSuccessAt: webhook.lastSuccessAt,
      lastFailureAt: webhook.lastFailureAt
    };
  }

  getWebhookDetail(webhook) {
    return {
      ...this.getWebhookInfo(webhook),
      history: webhook.history.slice()
    };
  }

  listWebhooks() {
    return Array.from(this.webhooks.values()).map(w => this.getWebhookInfo(w));
  }

  getWebhook(id) {
    const webhook = this.webhooks.get(Number(id));
    if (!webhook) return null;
    return this.getWebhookDetail(webhook);
  }

  deleteWebhook(id) {
    const webhookId = Number(id);
    if (!this.webhooks.has(webhookId)) {
      throw new Error(`webhook ${id} 不存在`);
    }
    if (this.pendingBatches.has(webhookId)) {
      clearTimeout(this.pendingBatches.get(webhookId).timer);
      this.pendingBatches.delete(webhookId);
    }
    this.webhooks.delete(webhookId);
    return { success: true };
  }

  pauseWebhook(id) {
    const webhook = this.webhooks.get(Number(id));
    if (!webhook) {
      throw new Error(`webhook ${id} 不存在`);
    }
    webhook.paused = true;
    webhook.updatedAt = Date.now();
    return { success: true, paused: true };
  }

  resumeWebhook(id) {
    const webhook = this.webhooks.get(Number(id));
    if (!webhook) {
      throw new Error(`webhook ${id} 不存在`);
    }
    webhook.paused = false;
    webhook.updatedAt = Date.now();
    return { success: true, paused: false };
  }

  sendHttpRequest(url, headers, body, timeoutSec) {
    return new Promise((resolve, reject) => {
      try {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const module = isHttps ? https : http;

        const postData = JSON.stringify(body);

        const options = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            ...headers
          },
          timeout: timeoutSec * 1000
        };

        const req = module.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ statusCode: res.statusCode, body: data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
            }
          });
        });

        req.on('timeout', () => {
          req.destroy(new Error(`请求超时 (${timeoutSec}s)`));
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.write(postData);
        req.end();
      } catch (e) {
        reject(e);
      }
    });
  }

  async executePushWithRetry(webhook, body) {
    const historyEntry = {
      id: Math.random().toString(36).slice(2, 10),
      timestamp: Date.now(),
      status: 'pending',
      attempts: 0,
      events: body.events ? body.events.length : 1,
      error: null,
      responseBody: null,
      statusCode: null
    };

    webhook.history.unshift(historyEntry);
    if (webhook.history.length > MAX_HISTORY) {
      webhook.history = webhook.history.slice(0, MAX_HISTORY);
    }

    let attempt = 0;
    const maxAttempts = webhook.retries + 1;

    while (attempt < maxAttempts) {
      attempt++;
      historyEntry.attempts = attempt;

      try {
        const result = await this.sendHttpRequest(
          webhook.url,
          webhook.headers,
          body,
          webhook.timeout
        );
        historyEntry.status = 'success';
        historyEntry.statusCode = result.statusCode;
        historyEntry.responseBody = result.body ? String(result.body).slice(0, 1000) : null;
        historyEntry.error = null;
        webhook.successCount++;
        webhook.lastSuccessAt = Date.now();
        webhook.lastTriggeredAt = Date.now();
        return;
      } catch (e) {
        historyEntry.error = e.message;
        if (attempt >= maxAttempts) {
          historyEntry.status = 'failed';
          webhook.failureCount++;
          webhook.lastFailureAt = Date.now();
          webhook.lastTriggeredAt = Date.now();
          return;
        }
        const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  buildSingleEvent(computeGraph, change) {
    return {
      event: 'cell_changed',
      cell: change.name,
      oldValue: change.oldValue,
      newValue: change.newValue,
      timestamp: Date.now(),
      graphSnapshot: this.buildGraphSnapshot(computeGraph, change.name)
    };
  }

  flushBatch(webhookId, computeGraph) {
    const batch = this.pendingBatches.get(webhookId);
    if (!batch) return;
    this.pendingBatches.delete(webhookId);

    const webhook = this.webhooks.get(webhookId);
    if (!webhook || webhook.paused || !webhook.enabled) {
      return;
    }

    const events = [];
    for (const [, event] of batch.events) {
      events.push(event);
    }
    if (events.length === 0) return;

    const body = events.length === 1
      ? events[0]
      : {
          event: 'batch_cell_changed',
          events,
          timestamp: Date.now()
        };

    setImmediate(() => {
      this.executePushWithRetry(webhook, body).catch(err => {
        console.error(`[WebhookEngine] webhook ${webhookId} 推送执行失败:`, err.message);
      });
    });
  }

  enqueueChange(webhookId, computeGraph, event) {
    let batch = this.pendingBatches.get(webhookId);
    if (!batch) {
      batch = {
        events: new Map(),
        timer: setTimeout(() => {
          this.flushBatch(webhookId, computeGraph);
        }, BATCH_WINDOW_MS)
      };
      this.pendingBatches.set(webhookId, batch);
    } else {
      batch.events.set(event.cell, event);
      return;
    }
    batch.events.set(event.cell, event);
  }

  processChanges(computeGraph, changes) {
    if (!changes || changes.length === 0) return;

    const validChanges = changes.filter(c => c.newValue !== undefined || c.oldValue !== undefined);
    if (validChanges.length === 0) return;

    for (const webhook of this.webhooks.values()) {
      if (!webhook.enabled || webhook.paused) continue;

      const matchedEvents = [];
      for (const change of validChanges) {
        if (!this.matchCell(webhook.cell, change.name)) continue;
        matchedEvents.push(change);
      }

      if (matchedEvents.length === 0) continue;

      if (webhook.ast && !this.evaluateCondition(webhook, computeGraph)) {
        continue;
      }

      for (const change of matchedEvents) {
        const event = this.buildSingleEvent(computeGraph, change);
        this.enqueueChange(webhook.id, computeGraph, event);
      }
    }
  }

  onCellDeleted(cellName) {
    for (const webhook of this.webhooks.values()) {
      if (webhook.cell === cellName) {
        webhook.enabled = false;
        webhook.updatedAt = Date.now();
      }
    }
  }

  onCellRenamed(oldName, newName) {
    for (const webhook of this.webhooks.values()) {
      if (webhook.cell === oldName) {
        webhook.cell = newName;
        webhook.updatedAt = Date.now();
      }
    }
  }
}

module.exports = { WebhookEngine, MAX_WEBHOOKS, MAX_HISTORY, DEFAULT_RETRIES, DEFAULT_TIMEOUT };
