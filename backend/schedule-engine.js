const { CronParser } = require('./cron-parser');
const { runSandbox } = require('./sandbox-engine');

const MAX_SCHEDULES = 20;
const MAX_HISTORY = 30;

class ScheduleEngine {
  constructor() {
    this.schedules = new Map();
    this.nextId = 1;
    this.cronParser = new CronParser();
    this.timer = null;
    this.running = false;
    this.wsManager = null;
    this.contextProviders = new Map();
    this.sequenceCounters = new Map();
  }

  setWebSocketManager(wsManager) {
    this.wsManager = wsManager;
  }

  setContextProvider(namespace, provider) {
    this.contextProviders.set(namespace || 'global', provider);
  }

  getContext(namespace) {
    const provider = this.contextProviders.get(namespace || 'global');
    if (provider) {
      return provider();
    }
    return null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  tick() {
    if (!this.running) return;

    const now = new Date();
    now.setMilliseconds(0);

    for (const [id, schedule] of this.schedules.entries()) {
      if (schedule.paused) continue;
      if (this.cronParser.shouldExecute(schedule.parsedCron, now)) {
        this.executeSchedule(id).catch(e => {
          console.error(`调度任务 ${id} 执行失败:`, e.message);
        });
      }
    }

    const nextSecond = new Date(now.getTime() + 1000);
    const delay = nextSecond.getTime() - Date.now();

    this.timer = setTimeout(() => this.tick(), Math.max(delay, 100));
  }

  resolveDynamicValue(valueSpec, scheduleId) {
    if (valueSpec === null || valueSpec === undefined) {
      return valueSpec;
    }

    if (typeof valueSpec !== 'object') {
      return valueSpec;
    }

    if (valueSpec.random === true) {
      const min = valueSpec.min ?? 0;
      const max = valueSpec.max ?? 100;
      return min + Math.random() * (max - min);
    }

    if (Array.isArray(valueSpec.sequence)) {
      const sequence = valueSpec.sequence;
      const loop = valueSpec.loop ?? true;
      const counter = this.sequenceCounters.get(scheduleId) || 0;
      
      if (counter >= sequence.length) {
        if (loop) {
          this.sequenceCounters.set(scheduleId, 1);
          return sequence[0];
        } else {
          return sequence[sequence.length - 1];
        }
      }
      
      this.sequenceCounters.set(scheduleId, counter + 1);
      return sequence[counter];
    }

    return valueSpec;
  }

  replacePlaceholders(template, timestamp, index) {
    if (typeof template !== 'string') return template;
    return template
      .replace(/\$\{timestamp\}/g, timestamp)
      .replace(/\$\{index\}/g, index.toString());
  }

  async executeSetValue(action, context, scheduleId) {
    const { computeGraph, wsManager, namespace } = context;
    const { cell, value } = action;

    if (!cell) {
      throw new Error('缺少 cell 参数');
    }

    const existingCell = computeGraph.cells.get(cell);
    if (!existingCell) {
      throw new Error(`单元格 '${cell}' 不存在`);
    }

    const resolvedValue = this.resolveDynamicValue(value, scheduleId);
    const cellType = existingCell.type;

    const { cell: updatedCell, changes } = computeGraph.updateCell(cell, cellType, resolvedValue);

    if (namespace) {
      wsManager.broadcastChangesToNamespace(namespace, changes);
    } else {
      wsManager.broadcastChanges(changes);
    }

    return {
      success: true,
      cell,
      newValue: resolvedValue,
      changes: changes.length
    };
  }

  async executeSnapshot(action, context) {
    const { computeGraph, snapshotManager } = context;
    const { label } = action;

    const timestamp = Date.now();
    const index = snapshotManager.snapshots.length + 1;
    const resolvedLabel = this.replacePlaceholders(label || 'auto-${timestamp}', timestamp, index);

    const snapshotInfo = snapshotManager.createSnapshot(computeGraph, resolvedLabel);

    return {
      success: true,
      snapshotId: snapshotInfo.id,
      label: snapshotInfo.label,
      cellCount: snapshotInfo.cellCount
    };
  }

  async executeCheckBaseline(action, context) {
    const { computeGraph, baselineEngine } = context;
    const { baselineId, tolerance } = action;

    if (!baselineId) {
      throw new Error('缺少 baselineId 参数');
    }

    const result = baselineEngine.checkBaseline(
      baselineId,
      computeGraph,
      tolerance !== undefined ? Number(tolerance) : undefined
    );

    return {
      success: true,
      passed: result.passed,
      baselineId,
      summary: result.summary,
      diffCount: result.details.length
    };
  }

  async executeRunSandbox(action, context) {
    const { computeGraph } = context;
    const { instructions } = action;

    if (!Array.isArray(instructions)) {
      throw new Error('instructions 必须是数组');
    }

    const result = await runSandbox(computeGraph, instructions);

    return {
      success: true,
      frameCount: result.frames.length,
      fatalError: result.fatalError,
      timedOut: result.timedOut,
      diff: result.diff
    };
  }

  async executeAction(action, context, scheduleId) {
    try {
      let result;

      switch (action.type) {
        case 'set_value':
          result = await this.executeSetValue(action, context, scheduleId);
          break;
        case 'snapshot':
          result = await this.executeSnapshot(action, context);
          break;
        case 'check_baseline':
          result = await this.executeCheckBaseline(action, context);
          break;
        case 'run_sandbox':
          result = await this.executeRunSandbox(action, context);
          break;
        default:
          throw new Error(`未知的操作类型: ${action.type}`);
      }

      return {
        type: action.type,
        status: 'success',
        detail: result
      };
    } catch (e) {
      return {
        type: action.type,
        status: 'failed',
        detail: { error: e.message }
      };
    }
  }

  async executeSchedule(id) {
    const schedule = this.schedules.get(id);
    if (!schedule) return;

    const context = this.getContext(schedule.namespace);
    if (!context) {
      console.error(`调度任务 ${id} 找不到执行上下文`);
      return;
    }

    const executionTime = Date.now();
    const actionResults = [];
    let hasFailed = false;
    let hasPartial = false;

    for (const action of schedule.actions) {
      const result = await this.executeAction(action, context, id);
      actionResults.push(result);

      if (result.status === 'failed') {
        hasPartial = true;
      }

      if (action.type === 'check_baseline' && result.detail.passed === false) {
        hasFailed = true;
        if (this.wsManager) {
          const alert = {
            type: 'schedule_alert',
            scheduleId: id,
            name: schedule.name,
            message: '回归检测未通过',
            baselineId: action.baselineId,
            diff: result.detail.summary,
            timestamp: executionTime
          };
          if (schedule.namespace) {
            this.wsManager.broadcastScheduleAlertToNamespace(schedule.namespace, alert);
          } else {
            this.wsManager.broadcastScheduleAlert(alert);
          }
        }
      }
    }

    let overallStatus = 'success';
    if (hasFailed) {
      overallStatus = 'failed';
    } else if (hasPartial) {
      overallStatus = 'partial_success';
    }

    const record = {
      timestamp: executionTime,
      actionResults,
      status: overallStatus
    };

    schedule.executionHistory.unshift(record);
    if (schedule.executionHistory.length > MAX_HISTORY) {
      schedule.executionHistory.pop();
    }

    schedule.lastExecution = executionTime;

    if (this.wsManager) {
      const broadcastMsg = {
        type: 'schedule_executed',
        scheduleId: id,
        name: schedule.name,
        status: overallStatus,
        timestamp: executionTime,
        actionResults: actionResults.map(r => ({
          type: r.type,
          status: r.status,
          detail: r.detail
        }))
      };
      if (schedule.namespace) {
        this.wsManager.broadcastScheduleExecutionToNamespace(schedule.namespace, broadcastMsg);
      } else {
        this.wsManager.broadcastScheduleExecution(broadcastMsg);
      }
    }

    return record;
  }

  createSchedule({ name, cron, enabled = true, actions = [], namespace = null }) {
    if (this.schedules.size >= MAX_SCHEDULES) {
      throw new Error(`最多支持 ${MAX_SCHEDULES} 个调度任务`);
    }

    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new Error('任务名称不能为空');
    }

    const validation = this.cronParser.validate(cron);
    if (!validation.valid) {
      throw new Error(`cron表达式无效: ${validation.error}`);
    }

    if (!Array.isArray(actions)) {
      throw new Error('actions 必须是数组');
    }

    const parsedCron = this.cronParser.parse(cron);
    const nextExecution = this.cronParser.getNextExecution(parsedCron);

    const schedule = {
      id: this.nextId++,
      name: name.trim(),
      cron,
      parsedCron,
      enabled: Boolean(enabled),
      paused: !enabled,
      actions,
      namespace,
      createdAt: Date.now(),
      lastExecution: null,
      nextExecution: nextExecution.getTime(),
      executionHistory: []
    };

    this.schedules.set(schedule.id, schedule);
    this.sequenceCounters.set(schedule.id, 0);

    return this.sanitizeSchedule(schedule);
  }

  sanitizeSchedule(schedule, includeHistory = false) {
    const result = {
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      enabled: schedule.enabled,
      paused: schedule.paused,
      actionCount: schedule.actions.length,
      namespace: schedule.namespace,
      createdAt: schedule.createdAt,
      lastExecution: schedule.lastExecution,
      nextExecution: schedule.nextExecution
    };

    if (includeHistory) {
      result.executionHistory = schedule.executionHistory;
      result.actions = schedule.actions;
    }

    return result;
  }

  getSchedules(namespace = null) {
    const result = [];
    for (const schedule of this.schedules.values()) {
      if (namespace === null || schedule.namespace === namespace) {
        result.push(this.sanitizeSchedule(schedule));
      }
    }
    return result;
  }

  getSchedule(id, namespace = null) {
    const schedule = this.schedules.get(Number(id));
    if (!schedule) return null;
    if (namespace !== null && schedule.namespace !== namespace) return null;
    return this.sanitizeSchedule(schedule, true);
  }

  getHistory(id, namespace = null) {
    const schedule = this.schedules.get(Number(id));
    if (!schedule) return null;
    if (namespace !== null && schedule.namespace !== namespace) return null;
    return { history: schedule.executionHistory };
  }

  deleteSchedule(id, namespace = null) {
    const schedule = this.schedules.get(Number(id));
    if (!schedule) return false;
    if (namespace !== null && schedule.namespace !== namespace) return false;
    this.schedules.delete(Number(id));
    this.sequenceCounters.delete(Number(id));
    return true;
  }

  pauseSchedule(id, namespace = null) {
    const schedule = this.schedules.get(Number(id));
    if (!schedule) return null;
    if (namespace !== null && schedule.namespace !== namespace) return null;
    schedule.paused = true;
    return this.sanitizeSchedule(schedule);
  }

  resumeSchedule(id, namespace = null) {
    const schedule = this.schedules.get(Number(id));
    if (!schedule) return null;
    if (namespace !== null && schedule.namespace !== namespace) return null;
    schedule.paused = false;
    schedule.nextExecution = this.cronParser.getNextExecution(schedule.parsedCron).getTime();
    return this.sanitizeSchedule(schedule);
  }

  updateNextExecutions() {
    const now = new Date();
    for (const schedule of this.schedules.values()) {
      if (!schedule.paused) {
        try {
          schedule.nextExecution = this.cronParser.getNextExecution(schedule.parsedCron, now).getTime();
        } catch (e) {
          schedule.nextExecution = null;
        }
      }
    }
  }
}

module.exports = { ScheduleEngine, MAX_SCHEDULES, MAX_HISTORY };
