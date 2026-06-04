const { parseExpression, evaluateExpression, traceExpression, StructuredError, findCellRefPosition } = require('./expression-parser');

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

  computeCell(name) {
    const cell = this.cells.get(name);
    if (!cell) throw new Error(`单元格 '${name}' 不存在`);

    const startTime = Date.now();

    if (cell.type === 'constant') {
      cell.computeTimeMs = Date.now() - startTime;
      return cell.value;
    }

    if (cell.type === 'formula') {
      try {
        const result = evaluateExpression(
          cell.ast,
          (refName) => this.cells.get(refName),
          cell.rawValue,
          this.crossNamespaceResolver
        );
        cell.value = result;
        cell.error = null;
        cell.structuredError = null;
        cell.computeTimeMs = Date.now() - startTime;
        return result;
      } catch (e) {
        cell.error = e.message;
        cell.structuredError = e instanceof StructuredError ? e.toJSON() : null;
        cell.computeTimeMs = Date.now() - startTime;
        throw e;
      }
    }
  }

  recalculate(changedNames) {
    const downstream = this.getDownstreamSubgraph(changedNames);
    const allAffected = Array.from(new Set([...changedNames, ...downstream]));
    const sorted = this.topologicalSort(allAffected);

    const changes = [];
    const errors = [];

    for (const name of sorted) {
      const cell = this.cells.get(name);
      const oldValue = cell.value ? { ...cell.value } : null;

      try {
        this.computeCell(name);
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
        errors.push({ name, error: e.message });
      }
    }

    return { changes, errors };
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

  createCell(name, cellType, rawValue) {
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
      computeTimeMs: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    if (cellType === 'constant') {
      cell.value = parsed;
    }

    this.cells.set(name, cell);

    const { changes, errors } = this.recalculate([name]);

    return { cell, changes, errors };
  }

  updateCell(name, cellType, rawValue) {
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

    if (cellType === 'constant') {
      existingCell.value = parsed;
    }

    const { changes, errors } = this.recalculate([name]);

    return { cell: existingCell, changes, errors };
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

    return { cell, changes: [], errors: [] };
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

  getCell(name) {
    const cell = this.cells.get(name);
    if (!cell) return null;
    return {
      name: cell.name,
      type: cell.type,
      rawValue: cell.rawValue,
      dependencies: cell.dependencies,
      value: cell.value,
      error: cell.error,
      structuredError: cell.structuredError,
      computeTimeMs: cell.computeTimeMs,
      downstream: this.getDownstream(name)
    };
  }

  getAllCells() {
    const result = [];
    for (const [name] of this.cells.entries()) {
      const cell = this.getCell(name);
      if (cell) {
        result.push(cell);
      } else {
        console.warn(`[getAllCells] 单元格 ${name} 存在于 this.cells 但 getCell 返回 null`);
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

      for (const { name, type, value, renameTo } of cells) {
        if (renameTo) {
          const { changes, errors } = this.renameCell(name, renameTo);
          allChanges.push(...changes);
          allErrors.push(...errors);
          changedNames.push(renameTo);
        } else if (this.cells.has(name)) {
          const { changes, errors } = this.updateCell(name, type, value);
          allChanges.push(...changes);
          allErrors.push(...errors);
          changedNames.push(name);
        } else {
          const { changes, errors } = this.createCell(name, type, value);
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
      if (!map.has(change.name) || map.get(change.name).computeTimeMs < change.computeTimeMs) {
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
        rawValue: cell.rawValue
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
        value: data.rawValue
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
          computeTimeMs: 0,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        if (cell.type === 'constant') {
          newCell.value = parsed;
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
        value: cell.rawValue
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
        rawValue: cell.value
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
        if (cell.value && !cell.error) {
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
    const downstream = this.getDownstreamSubgraph(changedNames);
    const allAffected = Array.from(new Set([...changedNames, ...downstream]));
    if (allAffected.length === 0) return { changes: [], errors: [] };

    const sorted = this.topologicalSort(allAffected);

    const changes = [];
    const errors = [];

    for (const name of sorted) {
      const cell = this.cells.get(name);
      if (!cell) continue;
      const oldValue = cell.value ? { ...cell.value } : null;

      try {
        this.computeCell(name);
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
        errors.push({ name, error: e.message });
      }
    }

    return { changes, errors };
  }
}

module.exports = { ComputeGraph };
