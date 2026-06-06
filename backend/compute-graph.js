const { parseExpression, evaluateExpression, traceExpression, compileExpression, StructuredError, findCellRefPosition } = require('./expression-parser');
const { PerfTracker } = require('./perf-tracker');

const MAX_CELLS = 200;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function isCrossNamespaceRef(dep) {
  return dep.includes('::');
}

class ComputeGraph {
  constructor(maxCells) {
    this.cells = new Map();
    this.maxCells = maxCells || MAX_CELLS;
    this.crossNamespaceResolver = null;
    this.crossDepValidator = null;
    this.perfTracker = new PerfTracker();

    this.cacheStats = {
      totalCompilations: 0,
      totalCacheHits: 0,
      totalRecompilations: 0,
      totalCompileTimeNs: 0n
    };
  }

  getPerfTracker() {
    return this.perfTracker;
  }

  setCrossNamespaceResolver(resolver) {
    this.crossNamespaceResolver = resolver;
  }

  setCrossDepValidator(validator) {
    this.crossDepValidator = validator;
  }

  validateName(name) {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`单元格名称 '${name}' 无效，必须以字母开头，由字母、数字和下划线组成`);
    }
  }

  parseValue(cellType, rawValue) {
    if (cellType === 'constant') {
      if (typeof rawValue === 'number') {
        return { type: 'number', value: rawValue };
      } else if (typeof rawValue === 'string') {
        return { type: 'string', value: rawValue };
      } else {
        throw new Error('常量值必须是数值或字符串');
      }
    } else if (cellType === 'formula') {
      if (typeof rawValue !== 'string') {
        throw new Error('表达式必须是字符串');
      }
      return parseExpression(rawValue);
    } else {
      throw new Error(`未知的单元格类型: ${cellType}`);
    }
  }

  compileCellFormula(cell) {
    if (cell.type !== 'formula' || !cell.ast) return;

    const startTime = process.hrtime.bigint();
    cell.compiledFn = compileExpression(cell.ast, cell.rawValue);
    const durationNs = process.hrtime.bigint() - startTime;

    cell.compiled = true;
    cell.compileTimeNs = durationNs;
    cell.compileTimeMs = Number((Number(durationNs) / 1_000_000).toFixed(4));
    cell.lastCompileTime = Date.now();

    this.cacheStats.totalCompilations++;
    this.cacheStats.totalCompileTimeNs += durationNs;
  }

  invalidateCellCache(cell) {
    if (cell.compiledFn) {
      cell.compiledFn = null;
      cell.compiled = false;
      cell.cacheHits = 0;
      cell.lastHitTime = null;
      this.cacheStats.totalRecompilations++;
    }
  }

  invalidateAllCaches() {
    for (const cell of this.cells.values()) {
      this.invalidateCellCache(cell);
    }
    return { invalidated: true };
  }

  getCacheStats() {
    let cachedCount = 0;
    for (const cell of this.cells.values()) {
      if (cell.type === 'formula' && cell.compiled) cachedCount++;
    }
    const totalCompileTimeMs = Number((Number(this.cacheStats.totalCompileTimeNs) / 1_000_000).toFixed(4));
    const avgCompileTimeMs = this.cacheStats.totalCompilations > 0
      ? Number((totalCompileTimeMs / this.cacheStats.totalCompilations).toFixed(4))
      : 0;

    return {
      cachedFormulas: cachedCount,
      totalFormulas: Array.from(this.cells.values()).filter(c => c.type === 'formula').length,
      totalCacheHits: this.cacheStats.totalCacheHits,
      totalCompilations: this.cacheStats.totalCompilations,
      totalRecompilations: this.cacheStats.totalRecompilations,
      totalCompileTimeMs,
      avgCompileTimeMs
    };
  }

  getAllCacheDetails() {
    const details = [];
    for (const [name, cell] of this.cells.entries()) {
      if (cell.type === 'formula') {
        details.push({
          name,
          cached: !!cell.compiled,
          cacheHits: cell.cacheHits || 0,
          compileTimeMs: cell.compileTimeMs || 0,
          lastHitTime: cell.lastHitTime || null,
          lastCompileTime: cell.lastCompileTime || null
        });
      }
    }
    return details;
  }

  getCompiledStatus(name) {
    const cell = this.cells.get(name);
    if (!cell) return null;
    if (cell.type !== 'formula') {
      return { name, type: 'constant', cached: false };
    }
    return {
      name,
      cached: !!cell.compiled,
      compileTimeMs: cell.compileTimeMs || 0,
      cacheHits: cell.cacheHits || 0,
      lastHitTime: cell.lastHitTime || null,
      lastCompileTime: cell.lastCompileTime || null
    };
  }

  getLocalDependencies(dependencies) {
    return (dependencies || []).filter(d => !isCrossNamespaceRef(d));
  }

  getCrossDependencies(dependencies) {
    return (dependencies || []).filter(d => isCrossNamespaceRef(d));
  }

  detectCycle(startName, dependencies) {
    const localDeps = this.getLocalDependencies(dependencies);
    const visited = new Map();

    const dfs = (name, path) => {
      if (visited.get(name) === 1) {
        const cycleStart = path.indexOf(name);
        return path.slice(cycleStart).concat(name);
      }
      if (visited.get(name) === 2) {
        return null;
      }

      visited.set(name, 1);
      const newPath = path.concat(name);

      const deps = name === startName ? localDeps : this.getLocalDependencies(this.getDependencies(name));
      for (const dep of deps) {
        const cycle = dfs(dep, newPath);
        if (cycle) return cycle;
      }

      visited.set(name, 2);
      return null;
    };

    return dfs(startName, []);
  }

  getDependencies(name) {
    const cell = this.cells.get(name);
    if (!cell) return [];
    return cell.dependencies || [];
  }

  getDownstream(name) {
    const downstream = [];
    for (const [cellName, cell] of this.cells.entries()) {
      const localDeps = this.getLocalDependencies(cell.dependencies);
      if (localDeps.includes(name)) {
        downstream.push(cellName);
      }
    }
    return downstream;
  }

  getDownstreamSubgraph(startNames) {
    const visited = new Set();
    const result = new Set();

    const bfs = (start) => {
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        result.add(current);

        const downstream = this.getDownstream(current);
        for (const d of downstream) {
          if (!visited.has(d)) {
            queue.push(d);
          }
        }
      }
    };

    for (const name of startNames) {
      bfs(name);
    }

    return Array.from(result);
  }

  markDirtyDownstream(startNames, changedBy) {
    const visited = new Set();
    const bfs = (start) => {
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        const cell = this.cells.get(current);
        if (cell) {
          cell.dirty = true;
        }
        const downstream = this.getDownstream(current);
        for (const d of downstream) {
          if (!visited.has(d)) {
            queue.push(d);
          }
        }
      }
    };
    for (const name of startNames) {
      bfs(name);
    }
  }

  ensureLazyComputed(name) {
    const cell = this.cells.get(name);
    if (!cell) return;
    if (cell.type !== 'formula') return;
    if (!cell.lazy) return;
    if (!cell.dirty) return;

    const localDeps = this.getLocalDependencies(cell.dependencies);
    for (const dep of localDeps) {
      this.ensureLazyComputed(dep);
    }

    this.computeCell(name, true);
    cell.dirty = false;
  }

  topologicalSort(names) {
    const nameSet = new Set(names);
    const inDegree = new Map();
    const adj = new Map();

    for (const name of names) {
      inDegree.set(name, 0);
      adj.set(name, []);
    }

    for (const name of names) {
      const localDeps = this.getLocalDependencies(this.getDependencies(name));
      for (const dep of localDeps) {
        if (nameSet.has(dep)) {
          adj.get(dep).push(name);
          inDegree.set(name, inDegree.get(name) + 1);
        }
      }
    }

    const queue = [];
    for (const name of names) {
      if (inDegree.get(name) === 0) {
        queue.push(name);
      }
    }

    const result = [];
    while (queue.length > 0) {
      const current = queue.shift();
      result.push(current);

      for (const next of adj.get(current)) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) {
          queue.push(next);
        }
      }
    }

    if (result.length !== names.length) {
      throw new Error('拓扑排序失败，存在环');
    }

    return result;
  }

  computeCell(name, forceLazy = false) {
    const cell = this.cells.get(name);
    if (!cell) throw new Error(`单元格 '${name}' 不存在`);

    const startTime = process.hrtime.bigint();

    if (cell.type === 'constant') {
      const durationNs = process.hrtime.bigint() - startTime;
      cell.computeTimeNs = durationNs;
      cell.computeTimeMs = Number((Number(durationNs) / 1_000_000).toFixed(2));
      return cell.value;
    }

    if (cell.type === 'formula') {
      try {
        const localDeps = this.getLocalDependencies(cell.dependencies);
        for (const dep of localDeps) {
          this.ensureLazyComputed(dep);
        }

        let result;
        if (cell.compiledFn) {
          cell.cacheHits = (cell.cacheHits || 0) + 1;
          cell.lastHitTime = Date.now();
          this.cacheStats.totalCacheHits++;
          result = cell.compiledFn(
            (refName) => this.cells.get(refName),
            this.crossNamespaceResolver
          );
        } else {
          result = evaluateExpression(
            cell.ast,
            (refName) => this.cells.get(refName),
            cell.rawValue,
            this.crossNamespaceResolver
          );
        }
        cell.value = result;
        cell.error = null;
        cell.structuredError = null;
        cell.dirty = false;
        const durationNs = process.hrtime.bigint() - startTime;
        cell.computeTimeNs = durationNs;
        cell.computeTimeMs = Number((Number(durationNs) / 1_000_000).toFixed(2));
        return result;
      } catch (e) {
        cell.error = e.message;
        cell.structuredError = e instanceof StructuredError ? e.toJSON() : null;
        const durationNs = process.hrtime.bigint() - startTime;
        cell.computeTimeNs = durationNs;
        cell.computeTimeMs = Number((Number(durationNs) / 1_000_000).toFixed(2));
        throw e;
      }
    }
  }

  recalculate(changedNames) {
    const triggerSource = changedNames.length > 0 ? changedNames.join(',') : 'unknown';
    const perfData = this.perfTracker.startRecalculation(triggerSource);

    this.markDirtyDownstream(changedNames, changedNames);

    const downstream = this.getDownstreamSubgraph(changedNames);
    const allAffected = Array.from(new Set([...changedNames, ...downstream]));
    const sorted = this.topologicalSort(allAffected);

    const changes = [];
    const errors = [];

    for (const name of sorted) {
      const cell = this.cells.get(name);
      if (!cell) continue;

      if (cell.type === 'formula' && cell.lazy) {
        cell.dirty = true;
        const lazyChange = {
          name,
          status: 'dirty',
          oldValue: cell.value ? cell.value.value : null,
          newValue: null,
          lazy: true,
          computeTimeMs: 0
        };
        changes.push(lazyChange);
        continue;
      }

      const oldValue = cell.value ? { ...cell.value } : null;

      try {
        this.computeCell(name);
        this.perfTracker.recordNodeTiming(perfData, name, cell.computeTimeNs);
        const newValue = cell.value;
        if (!oldValue || oldValue.value !== newValue.value || oldValue.type !== newValue.type) {
          changes.push({
            name,
            oldValue: oldValue ? oldValue.value : null,
            newValue: newValue.value,
            computeTimeMs: cell.computeTimeMs
          });
        }
      } catch (e) {
        this.perfTracker.recordNodeTiming(perfData, name, cell.computeTimeNs);
        errors.push({ name, error: e.message });
      }
    }

    this.perfTracker.endRecalculation(perfData);

    return { changes, errors };
  }

  runBenchmark() {
    const formulaNames = [];
    for (const [name, cell] of this.cells.entries()) {
      if (cell.type === 'formula') formulaNames.push(name);
    }
    if (formulaNames.length === 0) {
      return { error: '没有公式单元格可用于基准测试' };
    }

    const sortedNames = this.topologicalSort(formulaNames);

    this.invalidateAllCaches();

    const noCacheStart = process.hrtime.bigint();
    for (const name of sortedNames) {
      const cell = this.cells.get(name);
      try {
        evaluateExpression(
          cell.ast,
          (refName) => this.cells.get(refName),
          cell.rawValue,
          this.crossNamespaceResolver
        );
      } catch (e) {}
    }
    const noCacheDurationNs = process.hrtime.bigint() - noCacheStart;
    const noCacheMs = Number((Number(noCacheDurationNs) / 1_000_000).toFixed(4));

    for (const name of sortedNames) {
      const cell = this.cells.get(name);
      this.compileCellFormula(cell);
    }

    const withCacheStart = process.hrtime.bigint();
    for (const name of sortedNames) {
      const cell = this.cells.get(name);
      try {
        cell.compiledFn(
          (refName) => this.cells.get(refName),
          this.crossNamespaceResolver
        );
      } catch (e) {}
    }
    const withCacheDurationNs = process.hrtime.bigint() - withCacheStart;
    const withCacheMs = Number((Number(withCacheDurationNs) / 1_000_000).toFixed(4));

    const speedup = withCacheMs > 0 ? Number((noCacheMs / withCacheMs).toFixed(2)) : 0;
    const improvement = noCacheMs > 0 ? Number(((noCacheMs - withCacheMs) / noCacheMs * 100).toFixed(2)) : 0;

    return {
      formulaCount: sortedNames.length,
      withoutCacheMs: noCacheMs,
      withCacheMs: withCacheMs,
      speedupX: speedup,
      improvementPercent: improvement
    };
  }

  validateDependencies(dependencies, ast, rawValue) {
    const localDeps = this.getLocalDependencies(dependencies);
    const crossDeps = this.getCrossDependencies(dependencies);

    for (const dep of localDeps) {
      if (!this.cells.has(dep) && dep !== rawValue) {
        const pos = findCellRefPosition(ast, dep);
        if (pos) {
          throw new StructuredError(
            `引用的单元格 '${dep}' 不存在`,
            pos.start,
            pos.end,
            rawValue
          );
        }
        throw new Error(`依赖的单元格 '${dep}' 不存在`);
      }
    }

    if (crossDeps.length > 0 && this.crossDepValidator) {
      for (const dep of crossDeps) {
        const validation = this.crossDepValidator(dep);
        if (!validation.valid) {
          const pos = findCellRefPosition(ast, dep);
          if (pos) {
            throw new StructuredError(
              validation.error || `跨命名空间引用 '${dep}' 无效`,
              pos.start,
              pos.end,
              rawValue
            );
          }
          throw new Error(validation.error || `跨命名空间引用 '${dep}' 无效`);
        }
      }
    }
  }

  createCell(name, cellType, rawValue, options = {}) {
    this.validateName(name);

    if (this.cells.size >= this.maxCells) {
      throw new Error(`最多支持 ${this.maxCells} 个单元格`);
    }

    if (this.cells.has(name)) {
      throw new Error(`单元格 '${name}' 已存在`);
    }

    const parsed = this.parseValue(cellType, rawValue);

    let dependencies = [];
    let ast = null;

    if (cellType === 'formula') {
      dependencies = parsed.dependencies;
      ast = parsed.ast;

      this.validateDependencies(dependencies, ast, rawValue);

      const cycle = this.detectCycle(name, dependencies);
      if (cycle) {
        throw new Error(`检测到循环依赖: ${cycle.join(' -> ')}`);
      }
    }

    const cell = {
      name,
      type: cellType,
      rawValue,
      dependencies,
      ast,
      value: null,
      error: null,
      computeTimeNs: 0n,
      computeTimeMs: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lazy: cellType === 'formula' ? !!options.lazy : false,
      dirty: false,
      compiled: false,
      compiledFn: null,
      compileTimeNs: 0n,
      compileTimeMs: 0,
      cacheHits: 0,
      lastHitTime: null,
      lastCompileTime: null
    };

    const oldConstantValue = null;

    if (cellType === 'constant') {
      cell.value = parsed;
    }

    if (cellType === 'formula' && ast) {
      this.compileCellFormula(cell);
    }

    this.cells.set(name, cell);

    const { changes, errors } = this.recalculate([name]);

    if (cellType === 'constant') {
      if (!changes.find(c => c.name === name)) {
        changes.unshift({
          name,
          oldValue: oldConstantValue,
          newValue: parsed.value,
          computeTimeMs: cell.computeTimeMs
        });
      }
    }

    return { cell: this.getCell(name, { skipLazy: true }), changes, errors };
  }

  updateCell(name, cellType, rawValue, options = {}) {
    this.validateName(name);

    const existingCell = this.cells.get(name);
    if (!existingCell) {
      throw new Error(`单元格 '${name}' 不存在`);
    }

    const parsed = this.parseValue(cellType, rawValue);

    let newDependencies = [];
    let newAst = null;

    if (cellType === 'formula') {
      newDependencies = parsed.dependencies;
      newAst = parsed.ast;

      this.validateDependencies(newDependencies, newAst, rawValue);

      const cycle = this.detectCycle(name, newDependencies);
      if (cycle) {
        throw new Error(`检测到循环依赖: ${cycle.join(' -> ')}`);
      }
    }

    existingCell.type = cellType;
    existingCell.rawValue = rawValue;
    existingCell.dependencies = newDependencies;
    existingCell.ast = newAst;
    existingCell.updatedAt = Date.now();

    if (options.lazy !== undefined) {
      existingCell.lazy = cellType === 'formula' ? !!options.lazy : false;
    }

    this.invalidateCellCache(existingCell);

    const oldConstantValue = cellType === 'constant' && existingCell.value
      ? existingCell.value.value
      : null;

    if (cellType === 'constant') {
      existingCell.value = parsed;
    }

    if (cellType === 'formula' && newAst) {
      this.compileCellFormula(existingCell);
    }

    const { changes, errors } = this.recalculate([name]);

    if (cellType === 'constant') {
      if (!changes.find(c => c.name === name)) {
        changes.unshift({
          name,
          oldValue: oldConstantValue,
          newValue: parsed.value,
          computeTimeMs: existingCell.computeTimeMs
        });
      }
    }

    return { cell: this.getCell(name, { skipLazy: true }), changes, errors };
  }

  renameCell(oldName, newName) {
    this.validateName(newName);

    if (oldName === newName) return;

    if (!this.cells.has(oldName)) {
      throw new Error(`单元格 '${oldName}' 不存在`);
    }

    if (this.cells.has(newName)) {
      throw new Error(`单元格 '${newName}' 已存在`);
    }

    const downstream = this.getDownstream(oldName);
    if (downstream.length > 0) {
      throw new Error(`无法重命名，以下单元格仍在引用它: ${downstream.join(', ')}`);
    }

    const cell = this.cells.get(oldName);
    cell.name = newName;
    this.cells.set(newName, cell);
    this.cells.delete(oldName);

    return { cell: this.getCell(newName), changes: [], errors: [] };
  }

  deleteCell(name) {
    if (!this.cells.has(name)) {
      throw new Error(`单元格 '${name}' 不存在`);
    }

    const downstream = this.getDownstream(name);
    if (downstream.length > 0) {
      throw new Error(`无法删除，以下单元格仍在引用它: ${downstream.join(', ')}`);
    }

    this.cells.delete(name);

    return { changes: [], errors: [] };
  }

  traceCell(name) {
    const cell = this.cells.get(name);
    if (!cell) throw new Error(`单元格 '${name}' 不存在`);

    if (cell.type === 'constant') {
      const val = cell.value;
      return {
        steps: [{
          step: 1,
          expression: typeof cell.rawValue === 'string' ? `"${cell.rawValue}"` : String(cell.rawValue),
          resolved: val.value,
          type: 'literal'
        }],
        error: null
      };
    }

    if (cell.type === 'formula') {
      if (!cell.ast) {
        return {
          steps: [],
          error: cell.structuredError || { message: cell.error, position: null, context: null }
        };
      }

      const localDeps = this.getLocalDependencies(cell.dependencies);
      for (const dep of localDeps) {
        this.ensureLazyComputed(dep);
      }

      const traceResult = traceExpression(
        cell.ast,
        (refName) => this.cells.get(refName),
        cell.rawValue,
        this.crossNamespaceResolver
      );
      return {
        steps: traceResult.steps,
        error: traceResult.error || (cell.error ? (cell.structuredError || { message: cell.error, position: null, context: null }) : null)
      };
    }
  }

  getCell(name, options = {}) {
    const cell = this.cells.get(name);
    if (!cell) return null;

    if (!options.skipLazy && cell.type === 'formula' && cell.lazy && cell.dirty) {
      this.ensureLazyComputed(name);
    }

    return {
      name: cell.name,
      type: cell.type,
      rawValue: cell.rawValue,
      dependencies: cell.dependencies,
      value: cell.value,
      error: cell.error,
      structuredError: cell.structuredError,
      computeTimeMs: cell.computeTimeMs,
      downstream: this.getDownstream(name),
      lazy: cell.lazy || false,
      dirty: cell.dirty || false
    };
  }

  getAllCells() {
    const result = [];
    for (const [name] of this.cells.entries()) {
      const cell = this.cells.get(name);
      if (!cell) {
        console.warn(`[getAllCells] 单元格 ${name} 存在于 this.cells 但 getCell 返回 null`);
        continue;
      }

      if (cell.type === 'formula' && cell.lazy && cell.dirty) {
        result.push({
          name: cell.name,
          type: cell.type,
          rawValue: cell.rawValue,
          dependencies: cell.dependencies,
          value: null,
          error: null,
          structuredError: null,
          computeTimeMs: cell.computeTimeMs,
          downstream: this.getDownstream(name),
          lazy: true,
          dirty: true,
          status: 'dirty'
        });
      } else {
        result.push({
          name: cell.name,
          type: cell.type,
          rawValue: cell.rawValue,
          dependencies: cell.dependencies,
          value: cell.value,
          error: cell.error,
          structuredError: cell.structuredError,
          computeTimeMs: cell.computeTimeMs,
          downstream: this.getDownstream(name),
          lazy: cell.lazy || false,
          dirty: cell.dirty || false
        });
      }
    }
    return result;
  }

  batchCreateOrUpdate(cells) {
    const snapshot = this.snapshot();

    try {
      const allChanges = [];
      const allErrors = [];
      const changedNames = [];

      for (const { name, type, value, renameTo, lazy } of cells) {
        if (renameTo) {
          const { changes, errors } = this.renameCell(name, renameTo);
          allChanges.push(...changes);
          allErrors.push(...errors);
          changedNames.push(renameTo);
        } else if (this.cells.has(name)) {
          const { changes, errors } = this.updateCell(name, type, value, { lazy });
          allChanges.push(...changes);
          allErrors.push(...errors);
          changedNames.push(name);
        } else {
          const { changes, errors } = this.createCell(name, type, value, { lazy });
          allChanges.push(...changes);
          allErrors.push(...errors);
          changedNames.push(name);
        }
      }

      const uniqueChanges = this.mergeChanges(allChanges);
      return { success: true, changes: uniqueChanges, errors: allErrors };
    } catch (e) {
      this.restore(snapshot);
      throw e;
    }
  }

  mergeChanges(changes) {
    const map = new Map();
    for (const change of changes) {
      if (!map.has(change.name) || (map.get(change.name).computeTimeMs || 0) < (change.computeTimeMs || 0)) {
        map.set(change.name, change);
      }
    }
    return Array.from(map.values());
  }

  snapshot() {
    const data = {};
    for (const [name, cell] of this.cells.entries()) {
      data[name] = {
        type: cell.type,
        rawValue: cell.rawValue,
        lazy: cell.lazy || false
      };
    }
    return data;
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('snapshot 必须是非数组对象');
    }

    const entries = Object.entries(snapshot);
    if (entries.length === 0) {
      console.warn('[restore] snapshot 为空，将清空所有单元格');
      this.cells.clear();
      return { total: 0, restored: 0, failed: 0, skipped: [] };
    }

    const restoredNames = [];
    const failedNames = [];

    this.cells.clear();

    const cellsToImport = entries.map(([name, data]) => {
      if (!data || typeof data !== 'object') {
        console.warn(`[restore] 单元格 ${name} 的数据格式无效，跳过`);
        failedNames.push(name);
        return null;
      }
      if (!data.type || data.rawValue === undefined || data.rawValue === null) {
        console.warn(`[restore] 单元格 ${name} 缺少 type 或 rawValue，跳过`);
        failedNames.push(name);
        return null;
      }
      return {
        name,
        type: data.type,
        value: data.rawValue,
        lazy: data.lazy || false
      };
    }).filter(Boolean);

    const sortedCells = this.sortCellsByDependency(cellsToImport);

    for (const cell of sortedCells) {
      try {
        const parsed = this.parseValue(cell.type, cell.value);

        let dependencies = [];
        let ast = null;

        if (cell.type === 'formula') {
          dependencies = parsed.dependencies;
          ast = parsed.ast;

          const localDeps = this.getLocalDependencies(dependencies);
          for (const dep of localDeps) {
            if (dep !== cell.name && !this.cells.has(dep) && !cellsToImport.find(c => c.name === dep)) {
              const pos = findCellRefPosition(ast, dep);
              if (pos) {
                throw new StructuredError(
                  `引用的单元格 '${dep}' 不存在`,
                  pos.start,
                  pos.end,
                  cell.value
                );
              }
              throw new Error(`依赖的单元格 '${dep}' 不存在`);
            }
          }

          const cycle = this.detectCycle(cell.name, dependencies);
          if (cycle) {
            throw new Error(`检测到循环依赖: ${cycle.join(' -> ')}`);
          }
        }

        const newCell = {
          name: cell.name,
          type: cell.type,
          rawValue: cell.value,
          dependencies,
          ast,
          value: null,
          error: null,
          structuredError: null,
          computeTimeNs: 0n,
          computeTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lazy: cell.type === 'formula' ? !!cell.lazy : false,
          dirty: false,
          compiled: false,
          compiledFn: null,
          compileTimeNs: 0n,
          compileTimeMs: 0,
          cacheHits: 0,
          lastHitTime: null,
          lastCompileTime: null
        };

        if (cell.type === 'constant') {
          newCell.value = parsed;
        }

        if (cell.type === 'formula' && ast) {
          this.compileCellFormula(newCell);
        }

        this.cells.set(cell.name, newCell);
        restoredNames.push(cell.name);
      } catch (e) {
        console.warn(`[restore] 第一阶段创建单元格 ${cell.name} 失败:`, e.message);
        failedNames.push(cell.name);
      }
    }

    const formulaNames = sortedCells
      .map(c => c.name)
      .filter(name => {
        const cell = this.cells.get(name);
        return cell && cell.type === 'formula';
      });

    const sortedFormulas = this.topologicalSort(formulaNames);

    for (const name of sortedFormulas) {
      const cell = this.cells.get(name);
      if (cell && cell.lazy) {
        cell.dirty = true;
        continue;
      }
      try {
        this.computeCell(name);
      } catch (e) {
        console.warn(`[restore] 第二阶段计算单元格 ${name} 失败:`, e.message);
      }
    }

    return {
      total: entries.length,
      restored: restoredNames.length,
      failed: failedNames.length,
      failedNames
    };
  }

  exportGraph() {
    const cells = [];
    for (const [name, cell] of this.cells.entries()) {
      cells.push({
        name,
        type: cell.type,
        value: cell.rawValue,
        lazy: cell.lazy || false
      });
    }
    return { cells, exportedAt: Date.now() };
  }

  importGraph(data) {
    if (!data || !Array.isArray(data.cells)) {
      throw new Error('导入数据格式无效');
    }

    const snapshot = {};
    for (const cell of data.cells) {
      snapshot[cell.name] = {
        type: cell.type,
        rawValue: cell.value,
        lazy: cell.lazy || false
      };
    }

    const originalSnapshot = this.snapshot();

    try {
      const result = this.restore(snapshot);

      const allChanges = [];
      const allErrors = [];

      for (const name of result.failedNames) {
        allErrors.push({ name, error: '导入失败' });
      }

      for (const [name, cell] of this.cells.entries()) {
        if (cell.lazy && cell.dirty) {
          allChanges.push({
            name,
            status: 'dirty',
            lazy: true,
            computeTimeMs: 0
          });
        } else if (cell.value && !cell.error) {
          allChanges.push({
            name,
            oldValue: null,
            newValue: cell.value.value,
            computeTimeMs: cell.computeTimeMs
          });
        }
        if (cell.error) {
          allErrors.push({ name, error: cell.error });
        }
      }

      return { success: true, changes: allChanges, errors: allErrors };
    } catch (e) {
      this.restore(originalSnapshot);
      throw e;
    }
  }

  sortCellsByDependency(cells) {
    const cellMap = new Map(cells.map(c => [c.name, c]));
    const inDegree = new Map();
    const adj = new Map();

    for (const cell of cells) {
      inDegree.set(cell.name, 0);
      adj.set(cell.name, []);
    }

    for (const cell of cells) {
      if (cell.type === 'formula') {
        try {
          const { dependencies } = parseExpression(cell.value);
          const localDeps = this.getLocalDependencies(dependencies);
          for (const dep of localDeps) {
            if (cellMap.has(dep)) {
              adj.get(dep).push(cell.name);
              inDegree.set(cell.name, inDegree.get(cell.name) + 1);
            }
          }
        } catch (e) {
          console.warn(`[sortCellsByDependency] 解析 ${cell.name} 的公式失败:`, e.message);
        }
      }
    }

    const queue = [];
    for (const cell of cells) {
      if (inDegree.get(cell.name) === 0) {
        queue.push(cell.name);
      }
    }

    const result = [];
    while (queue.length > 0) {
      const current = queue.shift();
      result.push(cellMap.get(current));

      for (const next of adj.get(current)) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) {
          queue.push(next);
        }
      }
    }

    for (const cell of cells) {
      if (!result.find(r => r.name === cell.name)) {
        result.push(cell);
      }
    }

    return result;
  }

  getCrossNamespaceDownstream(namespace, cellName) {
    const crossRef = `${namespace}::${cellName}`;
    const downstream = [];
    for (const [cellNameInGraph, cell] of this.cells.entries()) {
      if (cell.dependencies && cell.dependencies.includes(crossRef)) {
        downstream.push(cellNameInGraph);
      }
    }
    return downstream;
  }

  recalculateWithCrossDeps(changedNames) {
    const triggerSource = changedNames.length > 0 ? changedNames.join(',') : 'cross-namespace';
    const perfData = this.perfTracker.startRecalculation(triggerSource);

    this.markDirtyDownstream(changedNames, changedNames);

    const downstream = this.getDownstreamSubgraph(changedNames);
    const allAffected = Array.from(new Set([...changedNames, ...downstream]));
    if (allAffected.length === 0) {
      this.perfTracker.endRecalculation(perfData);
      return { changes: [], errors: [] };
    }

    const sorted = this.topologicalSort(allAffected);

    const changes = [];
    const errors = [];

    for (const name of sorted) {
      const cell = this.cells.get(name);
      if (!cell) continue;

      if (cell.type === 'formula' && cell.lazy) {
        cell.dirty = true;
        changes.push({
          name,
          status: 'dirty',
          oldValue: cell.value ? cell.value.value : null,
          newValue: null,
          lazy: true,
          computeTimeMs: 0
        });
        continue;
      }

      const oldValue = cell.value ? { ...cell.value } : null;

      try {
        this.computeCell(name);
        this.perfTracker.recordNodeTiming(perfData, name, cell.computeTimeNs);
        const newValue = cell.value;
        if (!oldValue || oldValue.value !== newValue.value || oldValue.type !== newValue.type) {
          changes.push({
            name,
            oldValue: oldValue ? oldValue.value : null,
            newValue: newValue.value,
            computeTimeMs: cell.computeTimeMs
          });
        }
      } catch (e) {
        this.perfTracker.recordNodeTiming(perfData, name, cell.computeTimeNs);
        errors.push({ name, error: e.message });
      }
    }

    this.perfTracker.endRecalculation(perfData);

    return { changes, errors };
  }
}

module.exports = { ComputeGraph };
