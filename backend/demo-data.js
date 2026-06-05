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

const demoNamespaces = [
  {
    name: 'team-alpha',
    cells: [
      { name: 'cost', type: 'constant', value: 200 },
      { name: 'quantity', type: 'constant', value: 10 },
      { name: 'adjusted_cost', type: 'formula', value: 'team-beta::price * quantity' }
    ],
    publishedCells: []
  },
  {
    name: 'team-beta',
    cells: [
      { name: 'price', type: 'constant', value: 50 },
      { name: 'margin', type: 'constant', value: 0.2 },
      { name: 'selling_price', type: 'formula', value: 'price * (1 + margin)' }
    ],
    publishedCells: ['price']
  }
];

const demoSandboxScript = {
  description: '沙箱演示脚本: 修改单价→观察下游联动→删除折扣→观察错误传播',
  instructions: [
    {
      op: 'update',
      name: 'unit_price',
      type: 'constant',
      value: 150,
      comment: '将单价从100改为150，观察小计、折扣、总价等的变化'
    },
    {
      op: 'update',
      name: 'quantity',
      type: 'constant',
      value: 10,
      condition: 'unit_price > 120',
      comment: '条件执行: 只有当unit_price > 120时，才将数量改为10'
    },
    {
      op: 'delete',
      name: 'discount_rate',
      comment: '删除折扣率，观察依赖它的单元格会报错'
    },
    {
      op: 'create',
      name: 'shipping_fee',
      type: 'constant',
      value: 20,
      comment: '新增运费单元格'
    },
    {
      op: 'create',
      name: 'grand_total',
      type: 'formula',
      value: 'final + shipping_fee',
      comment: '新增总计公式: final + shipping_fee'
    }
  ]
};

module.exports = { demoCells, demoNamespaces, demoSandboxScript };
