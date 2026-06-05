const { parseExpression, evaluateExpression, StructuredError } = require('./expression-parser');
const { runSandbox } = require('./sandbox-engine');

const MAX_RULES = 50;
const MAX_HISTORY = 20;
const DEFAULT_COOLDOWN = 60;

class RuleEngine {
  constructor() {
    this.rules = new Map();
    this.ruleIdCounter = 0;
    this.wsManager = null;
    this.namespaceManager = null;
  }

  setWebSocketManager(wsManager) {
    this.wsManager = wsManager;
  }

  setNamespaceManager(nsManager) {
    this.namespaceManager = nsManager;
  }

  validateConditionExpression(condition, computeGraph) {
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
      throw new Error(`条件表达式无效: ${e.message}`);
    }
  }

  evaluateCondition(rule, computeGraph) {
    try {
      const cellResolver = (refName) => {
        if (refName.includes('::')) return null;
        return computeGraph.cells.get(refName);
      };
      
      const result = evaluateExpression(
        rule.ast,
        cellResolver,
        rule.condition,
        null
      );

      if (result.type === 'number') {
        return result.value !== 0 ? 1 : 0;
      }
      if (result.type === 'string') {
        return result.value !== '' ? 1 : 0;
      }
      return Boolean(result.value) ? 1 : 0;
    } catch (e) {
      return 0;
    }
  }

  createRule(computeGraph, params) {
    const { targetCell, condition, actionType, actionParams, cooldown } = params;

    if (this.rules.size >= MAX_RULES) {
      throw new Error(`最多支持 ${MAX_RULES} 条规则`);
    }

    if (!targetCell || !condition || !actionType) {
      throw new Error('缺少必要参数: targetCell, condition, actionType');
    }

    if (!computeGraph.cells.has(targetCell)) {
      throw new Error(`目标单元格 '${targetCell}' 不存在`);
    }

    if (!['alert', 'sandbox'].includes(actionType)) {
      throw new Error('actionType 必须是 alert 或 sandbox');
    }

    if (actionType === 'alert' && !actionParams?.message) {
      throw new Error('alert 类型需要 message 参数');
    }

    if (actionType === 'sandbox' && !Array.isArray(actionParams?.instructions)) {
      throw new Error('sandbox 类型需要 instructions 数组参数');
    }

    const { ast } = this.validateConditionExpression(condition, computeGraph);

    const ruleId = ++this.ruleIdCounter;
    const rule = {
      id: ruleId,
      targetCell,
      condition,
      ast,
      actionType,
      actionParams,
      cooldown: cooldown ?? DEFAULT_COOLDOWN,
      enabled: true,
      createdAt: Date.now(),
      lastEvaluatedValue: 0,
      lastTriggeredAt: 0,
      triggerCount: 0,
      history: []
    };

    rule.lastEvaluatedValue = this.evaluateCondition(rule, computeGraph);
    this.rules.set(ruleId, rule);

    return this.getRuleInfo(rule);
  }

  getRuleInfo(rule) {
    return {
      id: rule.id,
      targetCell: rule.targetCell,
      condition: rule.condition,
      actionType: rule.actionType,
      actionParams: rule.actionParams,
      cooldown: rule.cooldown,
      enabled: rule.enabled,
      createdAt: rule.createdAt,
      lastTriggeredAt: rule.lastTriggeredAt,
      triggerCount: rule.triggerCount
    };
  }

  getRuleDetail(rule) {
    return {
      ...this.getRuleInfo(rule),
      history: rule.history.slice()
    };
  }

  listRules() {
    return Array.from(this.rules.values()).map(r => this.getRuleInfo(r));
  }

  getRule(id) {
    const rule = this.rules.get(Number(id));
    if (!rule) return null;
    return this.getRuleDetail(rule);
  }

  getRuleHistory(id) {
    const rule = this.rules.get(Number(id));
    if (!rule) return null;
    return rule.history.slice();
  }

  deleteRule(id) {
    const ruleId = Number(id);
    if (!this.rules.has(ruleId)) {
      throw new Error(`规则 ${id} 不存在`);
    }
    this.rules.delete(ruleId);
    return { success: true };
  }

  enableRule(id) {
    const rule = this.rules.get(Number(id));
    if (!rule) {
      throw new Error(`规则 ${id} 不存在`);
    }
    rule.enabled = true;
    return { success: true, enabled: true };
  }

  disableRule(id) {
    const rule = this.rules.get(Number(id));
    if (!rule) {
      throw new Error(`规则 ${id} 不存在`);
    }
    rule.enabled = false;
    return { success: true, enabled: false };
  }

  async executeAction(rule, computeGraph, currentValue, namespace = null) {
    const timestamp = Date.now();
    const targetCell = computeGraph.cells.get(rule.targetCell);
    const cellValue = targetCell?.value?.value;

    let actionResult;

    if (rule.actionType === 'alert') {
      let message = rule.actionParams.message;
      message = message.replace(/\{\{name\}\}/g, rule.targetCell);
      message = message.replace(/\{\{value\}\}/g, String(cellValue ?? 'null'));

      const alertData = {
        type: 'rule_alert',
        ruleId: rule.id,
        cellName: rule.targetCell,
        message,
        currentValue: cellValue,
        timestamp
      };

      if (this.wsManager) {
        if (namespace) {
          this.wsManager.broadcastRuleAlertToNamespace(namespace, alertData);
        } else {
          this.wsManager.broadcastRuleAlert(alertData);
        }
      }
      actionResult = { status: 'pushed', message };
    } else if (rule.actionType === 'sandbox') {
      try {
        const sandboxResult = await runSandbox(computeGraph, rule.actionParams.instructions);
        actionResult = {
          status: 'executed',
          summary: {
            frameCount: sandboxResult.frames.length,
            hasFatalError: !!sandboxResult.fatalError,
            timedOut: sandboxResult.timedOut,
            changed: sandboxResult.diff.added.length + sandboxResult.diff.deleted.length + sandboxResult.diff.modified.length
          }
        };
      } catch (e) {
        actionResult = {
          status: 'error',
          error: e.message
        };
      }
    }

    rule.history.unshift({
      timestamp,
      conditionValue: currentValue,
      actionType: rule.actionType,
      actionResult
    });

    if (rule.history.length > MAX_HISTORY) {
      rule.history = rule.history.slice(0, MAX_HISTORY);
    }

    rule.triggerCount++;
    rule.lastTriggeredAt = timestamp;
  }

  checkRules(computeGraph, namespace = null) {
    const now = Date.now();

    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;

      const currentValue = this.evaluateCondition(rule, computeGraph);
      const previousValue = rule.lastEvaluatedValue;
      rule.lastEvaluatedValue = currentValue;

      if (previousValue === 0 && currentValue === 1) {
        if (rule.cooldown > 0 && now - rule.lastTriggeredAt < rule.cooldown * 1000) {
          continue;
        }

        setImmediate(() => {
          this.executeAction(rule, computeGraph, currentValue, namespace).catch(e => {
            console.error(`规则 ${rule.id} 执行动作失败:`, e.message);
          });
        });
      }
    }
  }

  onCellDeleted(cellName) {
    for (const rule of this.rules.values()) {
      if (rule.targetCell === cellName) {
        rule.enabled = false;
      }
    }
  }

  onCellRenamed(oldName, newName) {
    for (const rule of this.rules.values()) {
      if (rule.targetCell === oldName) {
        rule.targetCell = newName;
      }
    }
  }
}

module.exports = { RuleEngine, MAX_RULES, MAX_HISTORY, DEFAULT_COOLDOWN };
