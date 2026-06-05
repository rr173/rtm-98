const { ComputeGraph } = require('./compute-graph');
const { parseExpression, evaluateExpression, StructuredError } = require('./expression-parser');

const MAX_CONCURRENT_SANDBOXES = 3;
const MAX_EXECUTION_TIME_MS = 5000;
const MAX_INSTRUCTIONS = 100;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      resolve();
    } else {
      this.current--;
    }
  }

  getAvailable() {
    return this.max - this.current;
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT_SANDBOXES);

function deepCloneAST(node) {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(deepCloneAST);
  const cloned = {};
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      cloned[key] = deepCloneAST(node[key]);
    }
  }
  return cloned;
}

function deepCloneCell(cell) {
  return {
    name: cell.name,
    type: cell.type,
    rawValue: cell.rawValue,
    dependencies: cell.dependencies ? [...cell.dependencies] : [],
    ast: deepCloneAST(cell.ast),
    value: cell.value ? { ...cell.value } : null,
    error: cell.error,
    structuredError: cell.structuredError ? { ...cell.structuredError } : null,
    computeTimeMs: cell.computeTimeMs,
    createdAt: cell.createdAt,
    updatedAt: cell.updatedAt
  };
}

function cloneGraphState(computeGraph) {
  const clonedCells = new Map();
  for (const [name, cell] of computeGraph.cells.entries()) {
    clonedCells.set(name, deepCloneCell(cell));
  }
  return clonedCells;
}

function createSandboxCrossNamespaceResolver() {
  return function sandboxCrossNamespaceResolver(namespace, cellName) {
    throw new Error(`沙箱不支持跨命名空间引用: ${namespace}::${cellName}`);
  };
}

class Sandbox {
  constructor(originalGraph) {
    this.cells = cloneGraphState(originalGraph);
    this.maxCells = originalGraph.maxCells;
    this.crossNamespaceResolver = createSandboxCrossNamespaceResolver();
    this.frames = [];
    this.stepCounter = 0;
    this.fatalError = null;
    this.timedOut = false;
  }

  getLocalDependencies(dependencies) {
    return (dependencies || []).filter(d => !d.includes('::'));
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
    if (allAffected.length === 0) return { changes: [], errors: [], affected: [] };
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
    return { changes, errors, affected: sorted };
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

  validateDependencies(dependencies, ast, rawValue) {
    const localDeps = this.getLocalDependencies(dependencies);
    const crossDeps = dependencies.filter(d => d.includes('::'));
    for (const dep of localDeps) {
      if (!this.cells.has(dep)) {
        throw new Error(`依赖的单元格 '${dep}' 不存在`);
      }
    }
    if (crossDeps.length > 0) {
      throw new Error(`沙箱不支持跨命名空间引用: ${crossDeps.join(', ')}`);
    }
  }

  evaluateCondition(condition) {
    if (!condition || typeof condition !== 'string') {
      return true;
    }
    try {
      const { ast } = parseExpression(condition);
      const result = evaluateExpression(
        ast,
        (refName) => this.cells.get(refName),
        condition,
        this.crossNamespaceResolver
      );
      if (result.type === 'number') {
        return result.value !== 0;
      }
      if (result.type === 'string') {
        return result.value !== '';
      }
      return Boolean(result.value);
    } catch (e) {
      throw new Error(`条件表达式求值失败: ${e.message}`);
    }
  }

  createCell(name, cellType, rawValue) {
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

  deleteCell(name) {
    if (!this.cells.has(name)) {
      throw new Error(`单元格 '${name}' 不存在`);
    }
    const downstream = this.getDownstream(name);
    if (downstream.length > 0) {
      for (const d of downstream) {
        const cell = this.cells.get(d);
        if (cell) {
          cell.error = `依赖的单元格 '${name}' 已被删除`;
          cell.value = null;
        }
      }
    }
    this.cells.delete(name);
    return { changes: [], errors: [], affected: downstream };
  }

  getAffectedCellValues(cellNames) {
    const result = [];
    for (const name of cellNames) {
      const cell = this.cells.get(name);
      if (cell) {
        result.push({
          name,
          value: cell.value ? cell.value.value : null,
          type: cell.value ? cell.value.type : null,
          error: cell.error
        });
      }
    }
    return result;
  }

  recordFrame(step, op, targetCell, result, affectedCells) {
    const frame = {
      step,
      op,
      targetCell,
      result,
      affectedCells: this.getAffectedCellValues(affectedCells)
    };
    this.frames.push(frame);
    return frame;
  }

  executeInstruction(instruction) {
    this.stepCounter++;
    const step = this.stepCounter;
    const { op, name, type, value, condition } = instruction;
    try {
      if (condition !== undefined) {
        const condResult = this.evaluateCondition(condition);
        if (!condResult) {
          return this.recordFrame(step, op, name, { status: 'skipped', reason: '条件不满足' }, []);
        }
      }
    } catch (e) {
      this.fatalError = e.message;
      return this.recordFrame(step, op, name, { status: 'error', error: e.message, fatal: true }, []);
    }
    try {
      let result;
      let affected = [];
      switch (op) {
        case 'create':
          if (!type || value === undefined) {
            throw new Error('create 操作需要 type 和 value 参数');
          }
          result = this.createCell(name, type, value);
          affected = result.changes.map(c => c.name);
          if (!affected.includes(name)) affected.unshift(name);
          break;
        case 'update':
          if (!type || value === undefined) {
            throw new Error('update 操作需要 type 和 value 参数');
          }
          result = this.updateCell(name, type, value);
          affected = result.changes.map(c => c.name);
          if (!affected.includes(name)) affected.unshift(name);
          break;
        case 'delete':
          result = this.deleteCell(name);
          affected = result.affected || [];
          break;
        default:
          throw new Error(`未知操作: ${op}`);
      }
      return this.recordFrame(step, op, name, { status: 'success' }, affected);
    } catch (e) {
      const isFatal = e.message.includes('循环依赖');
      if (isFatal) {
        this.fatalError = e.message;
      }
      return this.recordFrame(step, op, name, { status: 'error', error: e.message, fatal: isFatal }, []);
    }
  }

  execute(instructions) {
    if (!Array.isArray(instructions)) {
      throw new Error('instructions 必须是数组');
    }
    if (instructions.length > MAX_INSTRUCTIONS) {
      throw new Error(`最多支持 ${MAX_INSTRUCTIONS} 条指令`);
    }
    for (const instr of instructions) {
      if (this.fatalError || this.timedOut) {
        break;
      }
      this.executeInstruction(instr);
    }
    return {
      frames: this.frames,
      fatalError: this.fatalError,
      timedOut: this.timedOut
    };
  }

  getFinalState() {
    const cells = {};
    for (const [name, cell] of this.cells.entries()) {
      cells[name] = {
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null,
        error: cell.error
      };
    }
    return { cells };
  }
}

function compareStates(originalState, sandboxState) {
  const cellsA = originalState.cells;
  const cellsB = sandboxState.cells;
  const added = [];
  const deleted = [];
  const modified = [];
  const allNames = new Set([...Object.keys(cellsA), ...Object.keys(cellsB)]);
  for (const name of allNames) {
    const inA = name in cellsA;
    const inB = name in cellsB;
    if (inA && !inB) {
      deleted.push(name);
    } else if (!inA && inB) {
      const cellB = cellsB[name];
      added.push({
        name,
        value: cellB.value ? cellB.value.value : null,
        type: cellB.value ? cellB.value.type : null
      });
    } else {
      const cellA = cellsA[name];
      const cellB = cellsB[name];
      const valueA = cellA.value;
      const valueB = cellB.value;
      const valueChanged =
        (valueA === null && valueB !== null) ||
        (valueA !== null && valueB === null) ||
        (valueA && valueB && (valueA.value !== valueB.value || valueA.type !== valueB.type));
      if (valueChanged || cellA.type !== cellB.type || cellA.rawValue !== cellB.rawValue) {
        modified.push({
          name,
          oldValue: valueA ? valueA.value : null,
          newValue: valueB ? valueB.value : null,
          oldType: valueA ? valueA.type : null,
          newType: valueB ? valueB.type : null
        });
      }
    }
  }
  return { added, deleted, modified };
}

function getOriginalState(computeGraph) {
  const cells = {};
  for (const [name, cell] of computeGraph.cells.entries()) {
    cells[name] = {
      type: cell.type,
      rawValue: cell.rawValue,
      value: cell.value ? { ...cell.value } : null,
      error: cell.error
    };
  }
  return { cells };
}

async function runSandbox(originalGraph, instructions) {
  if (semaphore.getAvailable() <= 0) {
    const error = new Error('沙箱并发数已达上限，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
  await semaphore.acquire();
  const sandbox = new Sandbox(originalGraph);
  const originalState = getOriginalState(originalGraph);
  let timeoutId = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        sandbox.timedOut = true;
        reject(new Error('沙箱执行超时'));
      }, MAX_EXECUTION_TIME_MS);
    });
    const executionPromise = Promise.resolve(sandbox.execute(instructions));
    let result;
    try {
      result = await Promise.race([executionPromise, timeoutPromise]);
    } catch (e) {
      if (sandbox.timedOut) {
        result = {
          frames: sandbox.frames,
          fatalError: null,
          timedOut: true
        };
      } else {
        throw e;
      }
    } finally {
      clearTimeout(timeoutId);
    }
    const finalState = sandbox.getFinalState();
    const diff = compareStates(originalState, finalState);
    return {
      frames: result.frames,
      fatalError: result.fatalError,
      timedOut: result.timedOut,
      diff,
      finalState: finalState.cells
    };
  } finally {
    semaphore.release();
  }
}

function getAvailableSlots() {
  return semaphore.getAvailable();
}

module.exports = {
  Sandbox,
  runSandbox,
  getAvailableSlots,
  MAX_CONCURRENT_SANDBOXES,
  MAX_EXECUTION_TIME_MS,
  MAX_INSTRUCTIONS
};
