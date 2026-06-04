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

module.exports = { demoCells, demoNamespaces };
