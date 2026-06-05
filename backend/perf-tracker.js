const MAX_RECORDS = 200;
const HEATMAP_RECORDS = 20;
const DEFAULT_THRESHOLD_MS = 200;

class PerfTracker {
  constructor() {
    this.records = [];
    this.cellStats = new Map();
    this.thresholdMs = Number(process.env.PERF_THRESHOLD_MS) || DEFAULT_THRESHOLD_MS;
    this.onAlertCallback = null;
  }

  setOnAlertCallback(callback) {
    this.onAlertCallback = callback;
  }

  setThreshold(ms) {
    this.thresholdMs = Math.max(1, Number(ms) || DEFAULT_THRESHOLD_MS);
  }

  getThreshold() {
    return this.thresholdMs;
  }

  nsToMs(ns) {
    return Number((Number(ns) / 1_000_000).toFixed(2));
  }

  startRecalculation(triggerSource) {
    return {
      id: Date.now() + Math.random(),
      trigger: triggerSource,
      startTime: process.hrtime.bigint(),
      nodeTimings: new Map(),
      nodeCount: 0
    };
  }

  recordNodeTiming(recalcData, nodeName, durationNs) {
    const existing = recalcData.nodeTimings.get(nodeName) || 0n;
    recalcData.nodeTimings.set(nodeName, existing + durationNs);
    recalcData.nodeCount++;
  }

  endRecalculation(recalcData) {
    const totalDurationNs = process.hrtime.bigint() - recalcData.startTime;
    const totalMs = this.nsToMs(totalDurationNs);

    const nodeTimings = [];
    for (const [name, durationNs] of recalcData.nodeTimings.entries()) {
      const durationMs = this.nsToMs(durationNs);
      nodeTimings.push({ name, durationMs });
      
      this.updateCellStats(name, durationMs);
    }

    nodeTimings.sort((a, b) => b.durationMs - a.durationMs);
    const slowest = nodeTimings.slice(0, 3).map(n => ({ name: n.name, durationMs: n.durationMs }));

    const record = {
      id: recalcData.id,
      timestamp: Date.now(),
      trigger: recalcData.trigger,
      nodeCount: recalcData.nodeCount,
      totalMs,
      nodeTimings,
      slowest
    };

    this.records.unshift(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.pop();
    }

    if (totalMs > this.thresholdMs) {
      this.triggerAlert(record);
    }

    return record;
  }

  updateCellStats(name, durationMs) {
    const stats = this.cellStats.get(name) || {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      lastTimestamp: 0
    };

    stats.count++;
    stats.totalMs += durationMs;
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    stats.lastTimestamp = Date.now();

    this.cellStats.set(name, stats);
  }

  triggerAlert(record) {
    if (this.onAlertCallback) {
      try {
        this.onAlertCallback({
          type: 'perf_alert',
          totalMs: record.totalMs,
          trigger: record.trigger,
          slowest: record.slowest,
          nodeCount: record.nodeCount,
          timestamp: record.timestamp
        });
      } catch (e) {
        console.error('[PerfTracker] 告警回调失败:', e.message);
      }
    }
  }

  getRecentRecords(limit = 50) {
    return this.records.slice(0, limit).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      trigger: r.trigger,
      nodeCount: r.nodeCount,
      totalMs: r.totalMs,
      slowest: r.slowest
    }));
  }

  getCellStats() {
    const result = [];
    for (const [name, stats] of this.cellStats.entries()) {
      result.push({
        name,
        avgMs: Number((stats.totalMs / stats.count).toFixed(2)),
        maxMs: stats.maxMs,
        count: stats.count,
        lastTimestamp: stats.lastTimestamp
      });
    }
    result.sort((a, b) => b.avgMs - a.avgMs);
    return result;
  }

  getHeatmapData() {
    const recentRecords = this.records.slice(0, HEATMAP_RECORDS).reverse();
    
    const allCells = new Set();
    for (const r of recentRecords) {
      for (const t of r.nodeTimings) {
        allCells.add(t.name);
      }
    }
    
    const cellNames = Array.from(allCells);
    const matrix = recentRecords.map(r => {
      const timingMap = new Map(r.nodeTimings.map(t => [t.name, t.durationMs]));
      return cellNames.map(name => {
        const val = timingMap.get(name);
        return val !== undefined ? val : null;
      });
    });

    return {
      cellNames,
      recordCount: recentRecords.length,
      matrix
    };
  }

  clearAll() {
    this.records = [];
    this.cellStats.clear();
  }
}

const globalPerfTracker = new PerfTracker();

module.exports = { PerfTracker, globalPerfTracker };
