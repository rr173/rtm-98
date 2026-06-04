const { parseExpression, evaluateExpression } = require('./expression-parser');
const { ComputeGraph } = require('./compute-graph');

console.log('=== 测试表达式解析器 ===');

function testParse(expr, desc) {
  try {
    const result = parseExpression(expr);
    console.log(`✓ ${desc}: "${expr}"`);
    console.log(`  依赖: [${result.dependencies.join(', ')}]`);
    return result;
  } catch (e) {
    console.log(`✗ ${desc}: "${expr}" - ${e.message}`);
    return null;
  }
}

testParse('1 + 2 * 3', '四则运算');
testParse('(1 + 2) * 3', '括号');
testParse('a + b * c', '变量引用');
testParse('IF(a > b, c, d)', '条件分支');
testParse('MIN(a, b, c)', 'MIN函数');
testParse('MAX(a, b)', 'MAX函数');
testParse('ABS(-5)', 'ABS函数');
testParse('ROUND(3.14159, 2)', 'ROUND函数');
testParse('CONCAT("hello", " ", "world")', 'CONCAT函数');
testParse('a > b', '比较运算');
testParse('a == b', '等于');
testParse('a != b', '不等于');
testParse('-a + b', '一元负号');

console.log('\n=== 测试计算图 ===');

const graph = new ComputeGraph();

function testGraph(desc, fn) {
  try {
    const result = fn();
    console.log(`✓ ${desc}`);
    return result;
  } catch (e) {
    console.log(`✗ ${desc}: ${e.message}`);
    return null;
  }
}

testGraph('创建常量 a=10', () => {
  const result = graph.createCell('a', 'constant', 10);
  console.log(`  a = ${result.cell.value.value}`);
  return result;
});

testGraph('创建常量 b=5', () => {
  const result = graph.createCell('b', 'constant', 5);
  console.log(`  b = ${result.cell.value.value}`);
  return result;
});

testGraph('创建表达式 c=a+b', () => {
  const result = graph.createCell('c', 'formula', 'a + b');
  console.log(`  c = ${result.cell.value.value} (依赖: [${result.cell.dependencies.join(', ')}])`);
  return result;
});

testGraph('创建表达式 d=IF(c>10, "big", "small")', () => {
  const result = graph.createCell('d', 'formula', 'IF(c > 10, "big", "small")');
  console.log(`  d = "${result.cell.value.value}" (依赖: [${result.cell.dependencies.join(', ')}])`);
  return result;
});

testGraph('更新 a=20，检查下游联动', () => {
  const result = graph.updateCell('a', 'constant', 20);
  const c = graph.getCell('c');
  const d = graph.getCell('d');
  console.log(`  a = 20, c = ${c.value.value}, d = "${d.value.value}"`);
  console.log(`  变化的单元格: [${result.changes.map(c => c.name).join(', ')}]`);
  return result;
});

testGraph('检测循环依赖', () => {
  try {
    graph.createCell('x', 'constant', 1);
    graph.createCell('y', 'formula', 'x');
    graph.updateCell('x', 'formula', 'y');
    console.log('  应该检测到循环但没有!');
    return null;
  } catch (e) {
    console.log(`  正确检测到: ${e.message}`);
    return true;
  }
});

testGraph('删除被引用的单元格应该失败', () => {
  try {
    graph.deleteCell('a');
    console.log('  应该失败但成功了!');
    return null;
  } catch (e) {
    console.log(`  正确拒绝: ${e.message}`);
    return true;
  }
});

console.log('\n=== 测试演示数据导入 ===');

const graph2 = new ComputeGraph();
const demoCells = [
  { name: 'unit_price', type: 'constant', value: 100 },
  { name: 'quantity', type: 'constant', value: 5 },
  { name: 'discount_rate', type: 'constant', value: 0.1 },
  { name: 'subtotal', type: 'formula', value: 'unit_price * quantity' },
  { name: 'discount', type: 'formula', value: 'subtotal * discount_rate' },
  { name: 'total', type: 'formula', value: 'subtotal - discount' },
  { name: 'tax', type: 'formula', value: 'total * 0.08' },
  { name: 'final', type: 'formula', value: 'total + tax' },
  { name: 'status', type: 'formula', value: 'IF(final > 500, "premium", "standard")' }
];

const result = graph2.importGraph({ cells: demoCells });
console.log(`✓ 导入成功，${result.changes.length} 个值已计算`);
for (const cell of graph2.getAllCells()) {
  const val = cell.value ? (typeof cell.value.value === 'number' ? cell.value.value.toFixed(2) : `"${cell.value.value}"`) : 'null';
  console.log(`  ${cell.name} = ${val}`);
}

console.log('\n=== 测试批量操作 ===');

const graph3 = new ComputeGraph();
const batchResult = graph3.batchCreateOrUpdate([
  { name: 'x', type: 'constant', value: 10 },
  { name: 'y', type: 'constant', value: 20 },
  { name: 'z', type: 'formula', value: 'x + y' }
]);
console.log(`✓ 批量操作成功，${batchResult.changes.length} 个变化`);
const z = graph3.getCell('z');
console.log(`  z = ${z.value.value}`);

console.log('\n=== 测试类型错误 ===');
const graph4 = new ComputeGraph();
graph4.createCell('s', 'constant', 'hello');
graph4.createCell('n', 'constant', 5);
const badResult = graph4.createCell('bad', 'formula', 's + n');
const badCell = graph4.getCell('bad');
if (badCell.error) {
  console.log(`✓ 类型检测正确，错误记录在单元格中: ${badCell.error}`);
} else {
  console.log('✗ 应该检测到类型错误');
}

console.log('\n=== 所有测试完成 ===');
