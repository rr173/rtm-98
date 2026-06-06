const { parseExpression, evaluateExpression, compileExpression } = require('./expression-parser');
const { ComputeGraph } = require('./compute-graph');

console.log('=== 测试表达式编译缓存 ===\n');

function assert(cond, msg) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.log(`✗ ${msg}`);
    process.exitCode = 1;
  }
}

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`✓ ${msg}`);
  } else {
    console.log(`✗ ${msg} - 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

console.log('--- 编译函数正确性测试 ---');

const testCases = [
  { expr: '1 + 2 * 3', expected: { type: 'number', value: 7 } },
  { expr: '(1 + 2) * 3', expected: { type: 'number', value: 9 } },
  { expr: '-5 + 3', expected: { type: 'number', value: -2 } },
  { expr: '10 > 5', expected: { type: 'number', value: 1 } },
  { expr: '5 == 5', expected: { type: 'number', value: 1 } },
  { expr: '5 != 3', expected: { type: 'number', value: 1 } },
  { expr: 'IF(1 > 0, "yes", "no")', expected: { type: 'string', value: 'yes' } },
  { expr: 'MIN(3, 1, 2)', expected: { type: 'number', value: 1 } },
  { expr: 'MAX(3, 1, 2)', expected: { type: 'number', value: 3 } },
  { expr: 'ABS(-5)', expected: { type: 'number', value: 5 } },
  { expr: 'ROUND(3.14159, 2)', expected: { type: 'number', value: 3.14 } },
  { expr: 'CONCAT("hello", " ", "world")', expected: { type: 'string', value: 'hello world' } },
];

for (const tc of testCases) {
  const { ast } = parseExpression(tc.expr);
  const compiled = compileExpression(ast, tc.expr);
  const result = compiled(() => null, null);
  assertEq(result, tc.expected, `编译求值: ${tc.expr}`);
}

console.log('\n--- 编译函数带引用测试 ---');
const g1 = new ComputeGraph();
g1.createCell('x', 'constant', 10);
g1.createCell('y', 'constant', 5);
const { ast: astRef } = parseExpression('x + y * 2');
const compiledRef = compileExpression(astRef, 'x + y * 2');
const refResult = compiledRef((name) => g1.cells.get(name), null);
assertEq(refResult, { type: 'number', value: 20 }, '编译求值带引用: x + y * 2');

console.log('\n=== 测试 ComputeGraph 编译缓存 ===\n');

const g2 = new ComputeGraph();
g2.createCell('a', 'constant', 10);
g2.createCell('b', 'constant', 20);
g2.createCell('c', 'formula', 'a + b');

const cCell = g2.cells.get('c');
assert(cCell.compiled === true, '公式单元格创建后已编译');
assert(cCell.cacheHits >= 0, '缓存命中次数已初始化');
assert(cCell.compileTimeMs > 0, '编译耗时已记录');

const status = g2.getCompiledStatus('c');
assert(status.cached === true, 'getCompiledStatus 返回已缓存');
assert(status.cacheHits >= 0, 'getCompiledStatus 返回命中次数');

console.log('\n--- 缓存命中测试 ---');
const beforeHits = g2.cells.get('c').cacheHits;
g2.updateCell('a', 'constant', 100);
const afterHits = g2.cells.get('c').cacheHits;
assert(afterHits > beforeHits, '更新依赖后缓存命中次数增加');

console.log('\n--- 缓存失效测试 ---');
g2.invalidateCellCache(g2.cells.get('c'));
const cCell2 = g2.cells.get('c');
assert(cCell2.compiled === false, '手动失效后缓存已清除');
assert(cCell2.cacheHits === 0, '手动失效后命中次数重置为0');
g2.compileCellFormula(cCell2);
assert(cCell2.compiled === true, '重新编译后缓存恢复');

console.log('\n--- 修改公式后重新编译 ---');
g2.updateCell('c', 'formula', 'a * b');
const cCell3 = g2.cells.get('c');
assert(cCell3.compiled === true, '修改公式后重新编译');
assert(cCell3.cacheHits >= 1, '修改公式后重算会有至少1次命中');

console.log('\n--- 全局缓存统计 ---');
const stats = g2.getCacheStats();
assert(stats.cachedFormulas >= 1, `已缓存公式数: ${stats.cachedFormulas}`);
assert(stats.totalCacheHits >= 0, `总命中次数: ${stats.totalCacheHits}`);
assert(stats.totalCompilations >= 2, `总编译次数: ${stats.totalCompilations}`);
assert(stats.avgCompileTimeMs > 0, `平均编译耗时: ${stats.avgCompileTimeMs}ms`);
console.log(`  缓存统计: cachedFormulas=${stats.cachedFormulas}, hits=${stats.totalCacheHits}, compiles=${stats.totalCompilations}, avg=${stats.avgCompileTimeMs}ms`);

console.log('\n--- 缓存详情 ---');
const details = g2.getAllCacheDetails();
assert(details.length >= 1, '缓存详情列表不为空');
assert(details.find(d => d.name === 'c') !== undefined, '缓存详情包含正确名称');
assert(typeof details[0].cached === 'boolean', 'cached 字段为布尔值');

console.log('\n--- 强制失效缓存 ---');
const invResult = g2.invalidateAllCaches();
assert(invResult.invalidated === true, '缓存已失效');
const cCell4 = g2.cells.get('c');
assert(cCell4.compiled === false, '所有缓存已清除');
assert(g2.getCacheStats().totalRecompilations >= 1, '重编译计数已增加');

console.log('\n--- 基准测试 ---');
g2.updateCell('c', 'formula', 'a + b');
const benchmark = g2.runBenchmark();
assert(benchmark.formulaCount >= 1, `基准测试公式数: ${benchmark.formulaCount}`);
assert(benchmark.withoutCacheMs > 0, `无缓存耗时: ${benchmark.withoutCacheMs}ms`);
assert(benchmark.withCacheMs > 0, `有缓存耗时: ${benchmark.withCacheMs}ms`);
assert(benchmark.speedupX >= 0, `加速比: ${benchmark.speedupX}x`);
console.log(`  基准结果: 无缓存=${benchmark.withoutCacheMs}ms, 有缓存=${benchmark.withCacheMs}ms, 加速=${benchmark.speedupX}x, 提升=${benchmark.improvementPercent}%`);

console.log('\n=== 测试懒求值 ===\n');

const g3 = new ComputeGraph();
g3.createCell('price', 'constant', 100);
g3.createCell('qty', 'constant', 10);

console.log('--- 创建 lazy 公式 ---');
g3.createCell('subtotal', 'formula', 'price * qty', { lazy: true });
const subtotalCell = g3.cells.get('subtotal');
assert(subtotalCell.lazy === true, 'lazy 标记已设置');
assert(subtotalCell.dirty === true, 'lazy 单元格初始为 dirty');
assert(subtotalCell.value === null, 'lazy 单元格初始值为 null');

console.log('\n--- getAllCells 显示 dirty 状态 ---');
const allCells = g3.getAllCells();
const subtotalInList = allCells.find(c => c.name === 'subtotal');
assert(subtotalInList.status === 'dirty', 'getAllCells 返回 lazy 单元格的 dirty 状态');
assert(subtotalInList.value === null, 'getAllCells 中 dirty lazy 单元格 value 为 null');

console.log('\n--- 显式查询 lazy 单元格触发计算 ---');
const subtotalQueried = g3.getCell('subtotal');
assert(subtotalQueried.value.value === 1000, `显式查询后值正确: ${subtotalQueried.value.value}`);
assert(subtotalQueried.dirty === false, '查询后 dirty 标记清除');

console.log('\n--- 上游变化时 lazy 单元格变 dirty 但不计算 ---');
g3.updateCell('price', 'constant', 200);
const subtotalAfter = g3.cells.get('subtotal');
assert(subtotalAfter.dirty === true, '上游变化后 lazy 单元格标记为 dirty');
assert(subtotalAfter.value.value === 1000, '上游变化后 lazy 单元格保留旧值直到查询');

console.log('\n--- 非 lazy 下游引用 lazy 单元格时强制计算 ---');
g3.createCell('discount', 'formula', 'subtotal * 0.1');
const discountCell = g3.getCell('discount');
assert(discountCell.value.value === 200, `非lazy下游引用lazy时lazy被强制计算, discount=${discountCell.value.value}`);
const subtotalAfterDisc = g3.cells.get('subtotal');
assert(subtotalAfterDisc.dirty === false, '被非lazy下游引用后 lazy 单元格不再 dirty');
assert(subtotalAfterDisc.value.value === 2000, `lazy 单元格被正确计算: ${subtotalAfterDisc.value.value}`);

console.log('\n--- dirty 传播: A(lazy) -> B(非lazy) ---');
const g4 = new ComputeGraph();
g4.createCell('base', 'constant', 10);
g4.createCell('A', 'formula', 'base * 2', { lazy: true });
g4.createCell('B', 'formula', 'A + 1');

const B_before = g4.getCell('B');
assertEq(B_before.value.value, 21, '初始 B 值正确');

const g4b = new ComputeGraph();
g4b.createCell('base', 'constant', 10);
g4b.createCell('A', 'formula', 'base * 2', { lazy: true });
const A_before_standalone = g4b.cells.get('A');
assert(A_before_standalone.dirty === true, '独立 lazy A 初始 dirty');
g4b.updateCell('base', 'constant', 20);
const A_after_standalone = g4b.cells.get('A');
assert(A_after_standalone.dirty === true, '无下游时上游变化后 A 保持 dirty');

g4.updateCell('base', 'constant', 20);
const B_after = g4.getCell('B');
assertEq(B_after.value.value, 41, 'B 重算时强制计算 A, 结果正确');
assert(g4.cells.get('A').dirty === false, 'B 计算后 A 的 dirty 标记被清除');

console.log('\n--- 多层 lazy 依赖 ---');
const g5 = new ComputeGraph();
g5.createCell('n', 'constant', 5);
g5.createCell('L1', 'formula', 'n * 2', { lazy: true });
g5.createCell('L2', 'formula', 'L1 + 10', { lazy: true });
g5.createCell('L3', 'formula', 'L2 * 3', { lazy: true });

const allL = g5.getAllCells();
assert(allL.find(c => c.name === 'L1').status === 'dirty', 'L1 初始 dirty');
assert(allL.find(c => c.name === 'L2').status === 'dirty', 'L2 初始 dirty');
assert(allL.find(c => c.name === 'L3').status === 'dirty', 'L3 初始 dirty');

const L3val = g5.getCell('L3');
assertEq(L3val.value.value, 60, `多层 lazy 依赖链式计算: L3=${L3val.value.value}`);
assert(g5.cells.get('L1').dirty === false, 'L1 被级联计算');
assert(g5.cells.get('L2').dirty === false, 'L2 被级联计算');
assert(g5.cells.get('L3').dirty === false, 'L3 被计算');

console.log('\n--- 向下兼容: 不带 lazy 字段行为一致 ---');
const g6 = new ComputeGraph();
g6.createCell('x', 'constant', 5);
g6.createCell('y', 'formula', 'x * 2');
const yCell = g6.cells.get('y');
assert(yCell.lazy === false, '默认 lazy=false');
assert(yCell.dirty === false, '非 lazy 单元格不会 dirty');
assert(yCell.value.value === 10, '非 lazy 单元格立即计算');

g6.updateCell('x', 'constant', 10);
const yCell2 = g6.cells.get('y');
assert(yCell2.value.value === 20, '非 lazy 单元格上游变化后立即重算');

console.log('\n--- 快照/恢复 lazy 标记 ---');
const snap = g3.snapshot();
assert(snap.subtotal.lazy === true, '快照包含 lazy 标记');
assert(snap.discount.lazy === false || snap.discount.lazy === undefined, '非 lazy 单元格快照正确');

const g7 = new ComputeGraph();
g7.restore(snap);
const sCell = g7.cells.get('subtotal');
assert(sCell.lazy === true, '恢复后 lazy 标记保留');
const sVal = g7.getCell('subtotal');
assert(sVal.value.value === 2000, `恢复后查询 lazy 单元格值正确: ${sVal.value.value}`);

const g7b = new ComputeGraph();
const snapOnlyLazy = {
  onlyLazy: { type: 'formula', rawValue: 'n * 3', lazy: true },
  n: { type: 'constant', rawValue: 7 }
};
g7b.restore(snapOnlyLazy);
const onlyLazyCell = g7b.cells.get('onlyLazy');
assert(onlyLazyCell.lazy === true, '纯 lazy 单元格恢复后 lazy 标记保留');
assert(onlyLazyCell.dirty === true, '纯 lazy 单元格恢复后为 dirty');
assert(onlyLazyCell.value === null, '纯 lazy 单元格恢复后值为 null');
const onlyLazyQueried = g7b.getCell('onlyLazy');
assert(onlyLazyQueried.value.value === 21, '纯 lazy 单元格查询后值正确');

console.log('\n--- lazy 单元格 WebSocket 推送格式 ---');
const g8 = new ComputeGraph();
g8.createCell('x', 'constant', 10);
g8.createCell('lazy1', 'formula', 'x * 2', { lazy: true });
g8.createCell('lazy2', 'formula', 'x + 1', { lazy: true });
g8.createCell('normal', 'formula', 'x + 100');
const { changes } = g8.updateCell('x', 'constant', 20);

const { WebSocketManager } = require('./websocket-server');
const wsm = new WebSocketManager(g8);
const sanitized = wsm.sanitizeChangesForBroadcast(changes);
const lazyChanges = sanitized.filter(c => c.status === 'dirty');
assert(lazyChanges.length === 2, `dirty lazy 变更数量正确: ${lazyChanges.length}`);
for (const lc of lazyChanges) {
  assert(lc.name !== undefined, 'dirty 推送包含 name');
  assert(lc.status === 'dirty', 'dirty 推送包含 status: dirty');
  assert(lc.oldValue === undefined, 'dirty 推送不包含旧值');
  assert(lc.newValue === undefined, 'dirty 推送不包含新值');
}
console.log(`  WebSocket dirty 推送: ${JSON.stringify(lazyChanges)}`);

console.log('\n=== 所有新功能测试完成 ===\n');
