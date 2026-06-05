const { ComputeGraph } = require('./compute-graph');
const { parseExpression, evaluateExpression, StructuredError } = require('./expression-parser');

const MAX_CONCURRENT_SANDBOXES = 3;
const MAX_EXECUTION_TIME_MS = 5000;
const MAX_INSTRUCTIONS = 100;
const MAX_EXPRESSION_RECURSION_DEPTH = 50;
const MAX_CELL_COMPUTE_COUNT = 10000;

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  tryAcquire() {
    if (this.current < this.max) {
      this.current++;
      return true;
    }
    return false;
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

class ExecutionTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExecutionTimeoutError';
  }
}

class SandboxEvaluator {
  constructor(cellResolver, expression, crossNamespaceResolver, timeoutChecker) {
    this.cellResolver = cellResolver;
    this.expression = expression;
    this.crossNamespaceResolver = crossNamespaceResolver;
    this.timeoutChecker = timeoutChecker;
    this.recursionDepth = 0;
    this.evalCount = 0;
  }

  checkTimeout() {
    this.evalCount++;
    if (this.evalCount % 100 === 0) {
      this.timeoutChecker.check();
    }
    if (this.recursionDepth > MAX_EXPRESSION_RECURSION_DEPTH) {
      throw new ExecutionTimeoutError(`表达式递归深度超过限制 (${MAX_EXPRESSION_RECURSION_DEPTH})`);
    }
  }

  evaluate(node) {
    this.recursionDepth++;
    try {
      this.checkTimeout();
      return this.evaluateNode(node);
    } finally {
      this.recursionDepth--;
    }
  }

  evaluateNode(node) {
    switch (node.type) {
      case 'Number':
        return { type: 'number', value: node.value };

      case 'String':
        return { type: 'string', value: node.value };

      case 'CellRef': {
        const cell = this.cellResolver(node.value);
        if (!cell) {
          throw new StructuredError(
            `引用的单元格 '${node.value}' 不存在`,
            node.start,
            node.end,
            this.expression
          );
        }
        return cell.value;
      }

      case 'CrossRef': {
        if (!this.crossNamespaceResolver) {
          throw new StructuredError(
            `跨命名空间引用 '${node.value}' 不可用`,
            node.start,
            node.end,
            this.expression
          );
        }
        const result = this.crossNamespaceResolver(node.namespace, node.cellName);
        if (!result) {
          throw new StructuredError(
            `跨命名空间引用 '${node.value}' 无法解析`,
            node.start,
            node.end,
            this.expression
          );
        }
        if (result.error) {
          throw new StructuredError(
            result.error,
            node.start,
            node.end,
            this.expression
          );
        }
        return result.value;
      }

      case 'UnaryOp': {
        const operand = this.evaluate(node.children[0]);
        if (operand.type !== 'number') {
          throw new StructuredError(
            `一元运算符 '${node.value}' 只能用于数值类型`,
            node.start,
            node.end,
            this.expression
          );
        }
        if (node.value === '+') {
          return { type: 'number', value: operand.value };
        } else {
          return { type: 'number', value: -operand.value };
        }
      }

      case 'BinOp': {
        const left = this.evaluate(node.children[0]);
        const right = this.evaluate(node.children[1]);

        if (['+', '-', '*', '/'].includes(node.value)) {
          if (left.type !== 'number' || right.type !== 'number') {
            throw new StructuredError(
              `算术运算符 '${node.value}' 需要两个数值类型`,
              node.opStart,
              node.opEnd,
              this.expression
            );
          }
          switch (node.value) {
            case '+': return { type: 'number', value: left.value + right.value };
            case '-': return { type: 'number', value: left.value - right.value };
            case '*': return { type: 'number', value: left.value * right.value };
            case '/':
              if (right.value === 0) {
                throw new StructuredError(
                  '除数不能为零',
                  node.opStart,
                  node.opEnd,
                  this.expression
                );
              }
              return { type: 'number', value: left.value / right.value };
          }
        }

        if (['>', '<', '>=', '<=', '==', '!='].includes(node.value)) {
          if (left.type !== right.type) {
            throw new StructuredError(
              `比较运算符 '${node.value}' 需要两个相同类型的操作数`,
              node.opStart,
              node.opEnd,
              this.expression
            );
          }
          let result;
          switch (node.value) {
            case '>': result = left.value > right.value; break;
            case '<': result = left.value < right.value; break;
            case '>=': result = left.value >= right.value; break;
            case '<=': result = left.value <= right.value; break;
            case '==': result = left.value === right.value; break;
            case '!=': result = left.value !== right.value; break;
          }
          return { type: 'number', value: result ? 1 : 0 };
        }

        throw new StructuredError(
          `未知的二元运算符: ${node.value}`,
          node.opStart,
          node.opEnd,
          this.expression
        );
      }

      case 'Function': {
        return this.evaluateFunction(node);
      }

      default:
        throw new StructuredError(
          `未知的AST节点类型: ${node.type}`,
          node.start,
          node.end,
          this.expression
        );
    }
  }

  evaluateFunction(node) {
    const funcName = node.value;

    switch (funcName) {
      case 'IF': {
        const cond = this.evaluate(node.children[0]);
        if (cond.type !== 'number') {
          throw new StructuredError(
            'IF的条件必须是数值类型',
            node.nameStart,
            node.nameEnd,
            this.expression
          );
        }
        const branch = cond.value !== 0 ? node.children[1] : node.children[2];
        const branchResult = this.evaluate(branch);
        return branchResult;
      }

      default: {
        const args = node.children.map(c => this.evaluate(c));

        let result;
        switch (funcName) {
          case 'MIN': {
            args.forEach((a, i) => {
              if (a.type !== 'number') {
                throw new StructuredError(
                  `MIN的第 ${i + 1} 个参数必须是数值类型`,
                  node.nameStart,
                  node.nameEnd,
                  this.expression
                );
              }
            });
            result = { type: 'number', value: Math.min(...args.map(a => a.value)) };
            break;
          }
          case 'MAX': {
            args.forEach((a, i) => {
              if (a.type !== 'number') {
                throw new StructuredError(
                  `MAX的第 ${i + 1} 个参数必须是数值类型`,
                  node.nameStart,
                  node.nameEnd,
                  this.expression
                );
              }
            });
            result = { type: 'number', value: Math.max(...args.map(a => a.value)) };
            break;
          }
          case 'ABS': {
            if (args[0].type !== 'number') {
              throw new StructuredError(
                'ABS的参数必须是数值类型',
                node.nameStart,
                node.nameEnd,
                this.expression
              );
            }
            result = { type: 'number', value: Math.abs(args[0].value) };
            break;
          }
          case 'ROUND': {
            if (args[0].type !== 'number') {
              throw new StructuredError(
                'ROUND的第一个参数必须是数值类型',
                node.nameStart,
                node.nameEnd,
                this.expression
              );
            }
            if (args[1].type !== 'number') {
              throw new StructuredError(
                'ROUND的第二个参数必须是数值类型',
                node.nameStart,
                node.nameEnd,
                this.expression
              );
            }
            const factor = Math.pow(10, Math.round(args[1].value));
            result = { type: 'number', value: Math.round(args[0].value * factor) / factor };
            break;
          }
          case 'CONCAT': {
            const strs = args.map(a => a.value.toString());
            result = { type: 'string', value: strs.join('') };
            break;
          }
          default:
            throw new StructuredError(
              `未知的函数: ${funcName}`,
              node.nameStart,
              node.nameEnd,
              this.expression
            );
        }

        return result;
      }
    }
  }
}

class TimeoutChecker {
  constructor(timeoutMs) {
    this.startTime = Date.now();
    this.timeoutMs = timeoutMs;
    this.timedOut = false;
  }

  check() {
    if (this.timedOut) {
      throw new ExecutionTimeoutError('沙箱执行超时');
    }
    if (Date.now() - this.startTime > this.timeoutMs) {
      this.timedOut = true;
      throw new ExecutionTimeoutError('沙箱执行超时');
    }
  }
}

class Sandbox {
  constructor(originalGraph, timeoutMs = MAX_EXECUTION_TIME_MS) {
    this.cells = cloneGraphState(originalGraph);
    this.maxCells = originalGraph.maxCells;
    this.crossNamespaceResolver = createSandboxCrossNamespaceResolver();
    this.frames = [];
    this.stepCounter = 0;
    this.fatalError = null;
    this.timedOut = false;
    this.timeoutChecker = new TimeoutChecker(timeoutMs);
    this.cellComputeCount = 0;
  }

  checkTimeout() {
    this.timeoutChecker.check();
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
    this.cellComputeCount++;
    if (this.cellComputeCount > MAX_CELL_COMPUTE_COUNT) {
      throw new ExecutionTimeoutError(`单元格计算次数超过限制 (${MAX_CELL_COMPUTE_COUNT})`);
    }

    this.checkTimeout();

    const cell = this.cells.get(name);
    if (!cell) throw new Error(`单元格 '${name}' 不存在`);
    const startTime = Date.now();
    if (cell.type === 'constant') {
      cell.computeTimeMs = Date.now() - startTime;
      return cell.value;
    }
    if (cell.type === 'formula') {
      try {
        const evaluator = new SandboxEvaluator(
          (refName) => this.cells.get(refName),
          cell.rawValue,
          this.crossNamespaceResolver,
          this.timeoutChecker
        );
        const result = evaluator.evaluate(cell.ast);
        cell.value = result;
        cell.error = null;
        cell.structuredError = null;
        cell.computeTimeMs = Date.now() - startTime;
        return result;
      } catch (e) {
        if (e instanceof ExecutionTimeoutError) {
          throw e;
        }
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
      this.checkTimeout();
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
        if (e instanceof ExecutionTimeoutError) {
          throw e;
        }
        errors.push({ name, error: e.message });
      }
    }
    return { changes, errors, affected: sorted };
  }

  parseValue(cellType, rawValue) {
    this.checkTimeout();
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
      this.checkTimeout();
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
      const evaluator = new SandboxEvaluator(
        (refName) => this.cells.get(refName),
        condition,
        this.crossNamespaceResolver,
        this.timeoutChecker
      );
      const result = evaluator.evaluate(ast);
      if (result.type === 'number') {
        return result.value !== 0;
      }
      if (result.type === 'string') {
        return result.value !== '';
      }
      return Boolean(result.value);
    } catch (e) {
      if (e instanceof ExecutionTimeoutError) {
        throw e;
      }
      throw new Error(`条件表达式求值失败: ${e.message}`);
    }
  }

  createCell(name, cellType, rawValue) {
    this.checkTimeout();
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
    this.checkTimeout();
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
    this.checkTimeout();
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
    this.checkTimeout();
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
      if (e instanceof ExecutionTimeoutError) {
        this.timedOut = true;
        this.fatalError = e.message;
        return this.recordFrame(step, op, name, { status: 'timeout', error: e.message, fatal: true }, []);
      }
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
      if (e instanceof ExecutionTimeoutError) {
        this.timedOut = true;
        this.fatalError = e.message;
        return this.recordFrame(step, op, name, { status: 'timeout', error: e.message, fatal: true }, []);
      }
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
  await Promise.resolve();
  
  if (!semaphore.tryAcquire()) {
    const error = new Error('沙箱并发数已达上限，请稍后再试');
    error.statusCode = 429;
    throw error;
  }

  let result;
  const originalState = getOriginalState(originalGraph);
  
  try {
    const sandbox = new Sandbox(originalGraph, MAX_EXECUTION_TIME_MS);
    result = sandbox.execute(instructions);
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
  MAX_INSTRUCTIONS,
  ExecutionTimeoutError
};
