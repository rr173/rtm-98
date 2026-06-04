const { ComputeGraph } = require('./compute-graph');
const { parseExpression, evaluateExpression } = require('./expression-parser');

class AuditEngine {
  constructor() {
    this.logs = [];
    this.nextSeq = 1;
  }

  append(type, operator, cellName, oldDef, newDef) {
    const entry = {
      seq: this.nextSeq++,
      timestamp: Date.now(),
      type,
      operator,
      cellName,
      oldDef: oldDef ? { type: oldDef.type, rawValue: oldDef.rawValue } : null,
      newDef: newDef ? { type: newDef.type, rawValue: newDef.rawValue } : null,
    };
    this.logs.push(entry);
    return entry;
  }

  query({ from, to, cell, operator, limit = 50, offset = 0 } = {}) {
    let filtered = this.logs;

    if (from !== undefined) {
      const fromMs = Number(from);
      if (!isNaN(fromMs)) filtered = filtered.filter(l => l.timestamp >= fromMs);
    }
    if (to !== undefined) {
      const toMs = Number(to);
      if (!isNaN(toMs)) filtered = filtered.filter(l => l.timestamp <= toMs);
    }
    if (cell) {
      const cellLower = cell.toLowerCase();
      filtered = filtered.filter(l => l.cellName.toLowerCase() === cellLower);
    }
    if (operator) {
      const opLower = operator.toLowerCase();
      filtered = filtered.filter(l => l.operator.toLowerCase() === opLower);
    }

    const sorted = [...filtered].sort((a, b) => b.seq - a.seq);
    const total = sorted.length;
    const items = sorted.slice(offset, offset + limit);

    return { total, offset, limit, items };
  }

  getBySeq(seq) {
    const n = Number(seq);
    if (isNaN(n)) return null;
    return this.logs.find(l => l.seq === n) || null;
  }

  getStats() {
    const total = this.logs.length;
    const typeCounts = {};
    const operatorSet = new Set();
    const minuteBuckets = {};

    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const log of this.logs) {
      typeCounts[log.type] = (typeCounts[log.type] || 0) + 1;
      operatorSet.add(log.operator);

      if (log.timestamp >= oneHourAgo) {
        const minuteKey = Math.floor(log.timestamp / 60000);
        minuteBuckets[minuteKey] = (minuteBuckets[minuteKey] || 0) + 1;
      }
    }

    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const frequency = [];
    for (let i = 59; i >= 0; i--) {
      const minute = currentMinute - i;
      const minuteDate = new Date(minute * 60000);
      const label = minuteDate.toISOString().slice(0, 16).replace('T', ' ');
      frequency.push({
        minute: label,
        count: minuteBuckets[minute] || 0,
      });
    }

    return {
      total,
      typeCounts,
      operators: Array.from(operatorSet),
      recentHourFrequency: frequency,
    };
  }

  replay(target) {
    let targetSeq;
    if (target.seq !== undefined) {
      targetSeq = Number(target.seq);
    } else if (target.timestamp !== undefined) {
      const ts = Number(target.timestamp);
      targetSeq = 0;
      for (const log of this.logs) {
        if (log.timestamp <= ts) {
          targetSeq = Math.max(targetSeq, log.seq);
        }
      }
      if (targetSeq === 0 && this.logs.length > 0) {
        return {
          targetTimestamp: ts,
          targetSeq: 0,
          cells: [],
          cellCount: 0,
        };
      }
    } else {
      throw new Error('必须提供 timestamp 或 seq 参数');
    }

    if (targetSeq < 1 || targetSeq > this.logs.length) {
      if (targetSeq === 0) {
        return {
          targetSeq: 0,
          cells: [],
          cellCount: 0,
        };
      }
      throw new Error(`无效的 seq: ${targetSeq}，当前范围 1-${this.logs.length}`);
    }

    const defMap = {};
    for (let i = 0; i < targetSeq; i++) {
      const log = this.logs[i];
      if (log.newDef) {
        defMap[log.cellName] = { type: log.newDef.type, rawValue: log.newDef.rawValue };
      } else {
        delete defMap[log.cellName];
      }
    }

    const tempGraph = new ComputeGraph();
    const constantNames = [];
    const formulaNames = [];

    for (const name of Object.keys(defMap)) {
      if (defMap[name].type === 'constant') {
        constantNames.push(name);
      } else {
        formulaNames.push(name);
      }
    }

    for (const name of constantNames) {
      try {
        tempGraph.createCell(name, 'constant', defMap[name].rawValue);
      } catch (e) {
        // skip
      }
    }

    for (const name of formulaNames) {
      const def = defMap[name];
      let parsed = null;
      let dependencies = [];
      let ast = null;

      try {
        parsed = parseExpression(def.rawValue);
        dependencies = parsed.dependencies;
        ast = parsed.ast;
      } catch (e) {
        tempGraph.cells.set(name, {
          name,
          type: 'formula',
          rawValue: def.rawValue,
          dependencies: [],
          ast: null,
          value: null,
          error: e.message,
          structuredError: null,
          computeTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        continue;
      }

      const missingDeps = dependencies.filter(d => !tempGraph.cells.has(d) && d !== name);
      if (missingDeps.length > 0) {
        tempGraph.cells.set(name, {
          name,
          type: 'formula',
          rawValue: def.rawValue,
          dependencies,
          ast,
          value: null,
          error: `引用的单元格 '${missingDeps[0]}' 不存在`,
          structuredError: null,
          computeTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        continue;
      }

      const cycle = tempGraph.detectCycle(name, dependencies);
      if (cycle) {
        tempGraph.cells.set(name, {
          name,
          type: 'formula',
          rawValue: def.rawValue,
          dependencies,
          ast,
          value: null,
          error: `检测到循环依赖: ${cycle.join(' -> ')}`,
          structuredError: null,
          computeTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        continue;
      }

      const cell = {
        name,
        type: 'formula',
        rawValue: def.rawValue,
        dependencies,
        ast,
        value: null,
        error: null,
        structuredError: null,
        computeTimeMs: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tempGraph.cells.set(name, cell);

      try {
        const result = evaluateExpression(cell.ast, (refName) => tempGraph.cells.get(refName), cell.rawValue);
        cell.value = result;
      } catch (e) {
        cell.error = e.message;
      }
    }

    const cells = [];
    for (const [name, cell] of tempGraph.cells.entries()) {
      cells.push({
        name,
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value,
        error: cell.error || null,
      });
    }

    return {
      targetSeq,
      targetTimestamp: this.logs[targetSeq - 1].timestamp,
      cells,
      cellCount: cells.length,
    };
  }
}

module.exports = { AuditEngine };
