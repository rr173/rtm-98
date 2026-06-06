const TokenType = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  IDENT: 'IDENT',
  PLUS: 'PLUS',
  MINUS: 'MINUS',
  MUL: 'MUL',
  DIV: 'DIV',
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  COMMA: 'COMMA',
  GT: 'GT',
  LT: 'LT',
  GE: 'GE',
  LE: 'LE',
  EQ: 'EQ',
  NE: 'NE',
  COLONCOLON: 'COLONCOLON',
  EOF: 'EOF'
};

class StructuredError extends Error {
  constructor(message, start, end, expression) {
    super(message);
    this.name = 'StructuredError';
    this.position = { start, end };
    if (expression != null) {
      const ctxStart = Math.max(0, start - 5);
      const ctxEnd = Math.min(expression.length, end + 5);
      this.context = expression.slice(ctxStart, ctxEnd);
    } else {
      this.context = null;
    }
  }

  toJSON() {
    return {
      message: this.message,
      position: this.position,
      context: this.context
    };
  }
}

class Tokenizer {
  constructor(input) {
    this.input = input;
    this.pos = 0;
    this.currentChar = this.input[0];
  }

  error() {
    throw new StructuredError(
      `词法错误: 位置 ${this.pos} 的字符无效`,
      this.pos,
      this.pos + 1,
      this.input
    );
  }

  advance() {
    this.pos++;
    if (this.pos > this.input.length - 1) {
      this.currentChar = null;
    } else {
      this.currentChar = this.input[this.pos];
    }
  }

  skipWhitespace() {
    while (this.currentChar !== null && /\s/.test(this.currentChar)) {
      this.advance();
    }
  }

  number() {
    const start = this.pos;
    let result = '';
    while (this.currentChar !== null && /[0-9.]/.test(this.currentChar)) {
      result += this.currentChar;
      this.advance();
    }
    return { type: TokenType.NUMBER, value: parseFloat(result), start, end: this.pos };
  }

  string() {
    const start = this.pos;
    this.advance();
    let result = '';
    while (this.currentChar !== null && this.currentChar !== '"') {
      result += this.currentChar;
      this.advance();
    }
    if (this.currentChar === null) {
      throw new StructuredError('词法错误: 字符串未闭合', start, this.pos, this.input);
    }
    this.advance();
    return { type: TokenType.STRING, value: result, start, end: this.pos };
  }

  identifier() {
    const start = this.pos;
    let result = '';
    while (this.currentChar !== null && /[a-zA-Z0-9_]/.test(this.currentChar)) {
      result += this.currentChar;
      this.advance();
    }

    if (this.currentChar === '-' || this.currentChar === ':') {
      const savedPos = this.pos;
      const savedChar = this.currentChar;
      let peekPos = this.pos;
      let peekResult = result;
      let peekChar = this.currentChar;
      let isValidCrossRef = false;

      while (peekChar === '-' && peekPos + 1 < this.input.length && /[a-zA-Z0-9_]/.test(this.input[peekPos + 1])) {
        peekResult += '-';
        peekPos++;
        peekChar = this.input[peekPos];
        while (peekPos < this.input.length && /[a-zA-Z0-9_]/.test(peekChar)) {
          peekResult += peekChar;
          peekPos++;
          peekChar = peekPos < this.input.length ? this.input[peekPos] : null;
        }
      }

      if (peekChar === ':' && peekPos + 1 < this.input.length && this.input[peekPos + 1] === ':') {
        peekPos += 2;
        peekChar = peekPos < this.input.length ? this.input[peekPos] : null;

        if (peekChar !== null && /[a-zA-Z_]/.test(peekChar)) {
          peekResult += '::';
          while (peekPos < this.input.length && /[a-zA-Z0-9_]/.test(peekChar)) {
            peekResult += peekChar;
            peekPos++;
            peekChar = peekPos < this.input.length ? this.input[peekPos] : null;
          }
          isValidCrossRef = true;
        }
      }

      if (isValidCrossRef) {
        this.pos = peekPos;
        this.currentChar = peekChar;
        return { type: TokenType.IDENT, value: peekResult, start, end: this.pos };
      }
    }

    return { type: TokenType.IDENT, value: result, start, end: this.pos };
  }

  getNextToken() {
    while (this.currentChar !== null) {
      if (/\s/.test(this.currentChar)) {
        this.skipWhitespace();
        continue;
      }

      if (/[0-9]/.test(this.currentChar)) {
        return this.number();
      }

      if (this.currentChar === '"') {
        return this.string();
      }

      if (/[a-zA-Z_]/.test(this.currentChar)) {
        return this.identifier();
      }

      if (this.currentChar === '+') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.PLUS, value: '+', start, end: this.pos };
      }

      if (this.currentChar === '-') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.MINUS, value: '-', start, end: this.pos };
      }

      if (this.currentChar === '*') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.MUL, value: '*', start, end: this.pos };
      }

      if (this.currentChar === '/') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.DIV, value: '/', start, end: this.pos };
      }

      if (this.currentChar === '(') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.LPAREN, value: '(', start, end: this.pos };
      }

      if (this.currentChar === ')') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.RPAREN, value: ')', start, end: this.pos };
      }

      if (this.currentChar === ',') {
        const start = this.pos;
        this.advance();
        return { type: TokenType.COMMA, value: ',', start, end: this.pos };
      }

      if (this.currentChar === '>') {
        const start = this.pos;
        this.advance();
        if (this.currentChar === '=') {
          this.advance();
          return { type: TokenType.GE, value: '>=', start, end: this.pos };
        }
        return { type: TokenType.GT, value: '>', start, end: this.pos };
      }

      if (this.currentChar === '<') {
        const start = this.pos;
        this.advance();
        if (this.currentChar === '=') {
          this.advance();
          return { type: TokenType.LE, value: '<=', start, end: this.pos };
        }
        return { type: TokenType.LT, value: '<', start, end: this.pos };
      }

      if (this.currentChar === '=') {
        const start = this.pos;
        this.advance();
        if (this.currentChar === '=') {
          this.advance();
          return { type: TokenType.EQ, value: '==', start, end: this.pos };
        }
        throw new StructuredError('词法错误: 意外的 \'=\'', start, this.pos, this.input);
      }

      if (this.currentChar === '!') {
        const start = this.pos;
        this.advance();
        if (this.currentChar === '=') {
          this.advance();
          return { type: TokenType.NE, value: '!=', start, end: this.pos };
        }
        throw new StructuredError('词法错误: 意外的 \'!\'', start, this.pos, this.input);
      }

      if (this.currentChar === ':') {
        const start = this.pos;
        this.advance();
        if (this.currentChar === ':') {
          this.advance();
          return { type: TokenType.COLONCOLON, value: '::', start, end: this.pos };
        }
        throw new StructuredError('词法错误: 意外的 \':\'', start, this.pos, this.input);
      }

      this.error();
    }

    return { type: TokenType.EOF, value: null, start: this.pos, end: this.pos };
  }
}

class ASTNode {
  constructor(type, value = null, start = 0, end = 0) {
    this.type = type;
    this.value = value;
    this.children = [];
    this.start = start;
    this.end = end;
  }
}

class Parser {
  constructor(expression) {
    this.expression = expression;
    this.tokenizer = new Tokenizer(expression);
    this.currentToken = this.tokenizer.getNextToken();
    this.dependencies = new Set();
  }

  error(msg = '语法错误', start, end) {
    const s = start != null ? start : this.currentToken.start;
    const e = end != null ? end : this.currentToken.end;
    throw new StructuredError(msg, s, e, this.expression);
  }

  eat(tokenType) {
    if (this.currentToken.type === tokenType) {
      const token = this.currentToken;
      this.currentToken = this.tokenizer.getNextToken();
      return token;
    } else {
      this.error(`期望 ${tokenType}, 但得到 ${this.currentToken.type}`);
    }
  }

  parse() {
    const node = this.expr();
    if (this.currentToken.type !== TokenType.EOF) {
      this.error('表达式未完整解析');
    }
    return { ast: node, dependencies: Array.from(this.dependencies) };
  }

  expr() {
    let node = this.comparison();

    while ([TokenType.PLUS, TokenType.MINUS].includes(this.currentToken.type)) {
      const token = this.currentToken;
      this.eat(token.type);
      const right = this.comparison();
      const opNode = new ASTNode('BinOp', token.value, node.start, right.end);
      opNode.children = [node, right];
      opNode.opStart = token.start;
      opNode.opEnd = token.end;
      node = opNode;
    }

    return node;
  }

  comparison() {
    let node = this.term();

    while ([TokenType.GT, TokenType.LT, TokenType.GE, TokenType.LE, TokenType.EQ, TokenType.NE].includes(this.currentToken.type)) {
      const token = this.currentToken;
      this.eat(token.type);
      const right = this.term();
      const opNode = new ASTNode('BinOp', token.value, node.start, right.end);
      opNode.children = [node, right];
      opNode.opStart = token.start;
      opNode.opEnd = token.end;
      node = opNode;
    }

    return node;
  }

  term() {
    let node = this.factor();

    while ([TokenType.MUL, TokenType.DIV].includes(this.currentToken.type)) {
      const token = this.currentToken;
      this.eat(token.type);
      const right = this.factor();
      const opNode = new ASTNode('BinOp', token.value, node.start, right.end);
      opNode.children = [node, right];
      opNode.opStart = token.start;
      opNode.opEnd = token.end;
      node = opNode;
    }

    return node;
  }

  factor() {
    const token = this.currentToken;

    if (token.type === TokenType.PLUS) {
      this.eat(TokenType.PLUS);
      const operand = this.factor();
      const node = new ASTNode('UnaryOp', '+', token.start, operand.end);
      node.children = [operand];
      return node;
    }

    if (token.type === TokenType.MINUS) {
      this.eat(TokenType.MINUS);
      const operand = this.factor();
      const node = new ASTNode('UnaryOp', '-', token.start, operand.end);
      node.children = [operand];
      return node;
    }

    if (token.type === TokenType.NUMBER) {
      this.eat(TokenType.NUMBER);
      return new ASTNode('Number', token.value, token.start, token.end);
    }

    if (token.type === TokenType.STRING) {
      this.eat(TokenType.STRING);
      return new ASTNode('String', token.value, token.start, token.end);
    }

    if (token.type === TokenType.LPAREN) {
      const lparen = this.eat(TokenType.LPAREN);
      const node = this.expr();
      const rparen = this.eat(TokenType.RPAREN);
      node.start = lparen.start;
      node.end = rparen.end;
      return node;
    }

    if (token.type === TokenType.IDENT) {
      const funcName = token.value.toUpperCase();
      if (['IF', 'MIN', 'MAX', 'ABS', 'ROUND', 'CONCAT'].includes(funcName)) {
        return this.functionCall(funcName);
      }
      this.eat(TokenType.IDENT);

      if (token.value.includes('::')) {
        const parts = token.value.split('::');
        const crossRef = token.value;
        this.dependencies.add(crossRef);
        const node = new ASTNode('CrossRef', crossRef, token.start, token.end);
        node.namespace = parts[0];
        node.cellName = parts[1];
        return node;
      }

      if (this.currentToken.type === TokenType.COLONCOLON) {
        const nsToken = token;
        this.eat(TokenType.COLONCOLON);
        if (this.currentToken.type !== TokenType.IDENT) {
          this.error('跨命名空间引用 :: 后需要单元格名称');
        }
        const cellToken = this.currentToken;
        this.eat(TokenType.IDENT);
        const crossRef = `${nsToken.value}::${cellToken.value}`;
        this.dependencies.add(crossRef);
        const node = new ASTNode('CrossRef', crossRef, nsToken.start, cellToken.end);
        node.namespace = nsToken.value;
        node.cellName = cellToken.value;
        return node;
      }

      this.dependencies.add(token.value);
      return new ASTNode('CellRef', token.value, token.start, token.end);
    }

    this.error();
  }

  functionCall(funcName) {
    const nameToken = this.currentToken;
    this.eat(TokenType.IDENT);
    const lparen = this.eat(TokenType.LPAREN);

    const args = [];
    if (this.currentToken.type !== TokenType.RPAREN) {
      args.push(this.expr());
      while (this.currentToken.type === TokenType.COMMA) {
        this.eat(TokenType.COMMA);
        args.push(this.expr());
      }
    }

    const rparen = this.eat(TokenType.RPAREN);

    if (funcName === 'IF' && args.length !== 3) {
      throw new StructuredError(
        `IF函数需要3个参数, 但提供了 ${args.length} 个`,
        nameToken.start,
        rparen.end,
        this.expression
      );
    }
    if (funcName === 'ABS' && args.length !== 1) {
      throw new StructuredError(
        `ABS函数需要1个参数, 但提供了 ${args.length} 个`,
        nameToken.start,
        rparen.end,
        this.expression
      );
    }
    if (funcName === 'ROUND' && args.length !== 2) {
      throw new StructuredError(
        `ROUND函数需要2个参数, 但提供了 ${args.length} 个`,
        nameToken.start,
        rparen.end,
        this.expression
      );
    }
    if (funcName === 'CONCAT' && args.length < 2) {
      throw new StructuredError(
        `CONCAT函数至少需要2个参数, 但提供了 ${args.length} 个`,
        nameToken.start,
        rparen.end,
        this.expression
      );
    }
    if (['MIN', 'MAX'].includes(funcName) && args.length < 2) {
      throw new StructuredError(
        `${funcName}函数至少需要2个参数, 但提供了 ${args.length} 个`,
        nameToken.start,
        rparen.end,
        this.expression
      );
    }

    const node = new ASTNode('Function', funcName, nameToken.start, rparen.end);
    node.children = args;
    node.nameStart = nameToken.start;
    node.nameEnd = nameToken.end;
    return node;
  }
}

class Evaluator {
  constructor(cellResolver, expression) {
    this.cellResolver = cellResolver;
    this.expression = expression;
  }

  evaluate(node) {
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
    const args = node.children.map(c => this.evaluate(c));

    switch (funcName) {
      case 'IF': {
        const cond = args[0];
        if (cond.type !== 'number') {
          throw new StructuredError(
            'IF的条件必须是数值类型',
            node.nameStart,
            node.nameEnd,
            this.expression
          );
        }
        return cond.value !== 0 ? args[1] : args[2];
      }

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
        return { type: 'number', value: Math.min(...args.map(a => a.value)) };
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
        return { type: 'number', value: Math.max(...args.map(a => a.value)) };
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
        return { type: 'number', value: Math.abs(args[0].value) };
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
        return { type: 'number', value: Math.round(args[0].value * factor) / factor };
      }

      case 'CONCAT': {
        const strs = args.map(a => a.value.toString());
        return { type: 'string', value: strs.join('') };
      }

      default:
        throw new StructuredError(
          `未知的函数: ${funcName}`,
          node.nameStart,
          node.nameEnd,
          this.expression
        );
    }
  }
}

class TracingEvaluator {
  constructor(cellResolver, expression) {
    this.cellResolver = cellResolver;
    this.expression = expression;
    this.steps = [];
    this.stepCounter = 0;
  }

  trace(node) {
    switch (node.type) {
      case 'Number': {
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: node.value,
          type: 'literal'
        });
        return { type: 'number', value: node.value };
      }

      case 'String': {
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: node.value,
          type: 'literal'
        });
        return { type: 'string', value: node.value };
      }

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
        const val = cell.value;
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: val.value,
          type: 'reference'
        });
        return val;
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
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: result.value.value,
          type: 'cross_reference'
        });
        return result.value;
      }

      case 'UnaryOp': {
        const operand = this.trace(node.children[0]);
        if (operand.type !== 'number') {
          throw new StructuredError(
            `一元运算符 '${node.value}' 只能用于数值类型`,
            node.start,
            node.end,
            this.expression
          );
        }
        const result = node.value === '+' ? operand.value : -operand.value;
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: result,
          type: 'unary_op'
        });
        return { type: 'number', value: result };
      }

      case 'BinOp': {
        const left = this.trace(node.children[0]);
        const right = this.trace(node.children[1]);

        if (['+', '-', '*', '/'].includes(node.value)) {
          if (left.type !== 'number' || right.type !== 'number') {
            throw new StructuredError(
              `算术运算符 '${node.value}' 需要两个数值类型`,
              node.opStart,
              node.opEnd,
              this.expression
            );
          }
          let result;
          switch (node.value) {
            case '+': result = left.value + right.value; break;
            case '-': result = left.value - right.value; break;
            case '*': result = left.value * right.value; break;
            case '/':
              if (right.value === 0) {
                throw new StructuredError(
                  '除数不能为零',
                  node.opStart,
                  node.opEnd,
                  this.expression
                );
              }
              result = left.value / right.value; break;
          }
          this.steps.push({
            step: ++this.stepCounter,
            expression: this.expression.slice(node.start, node.end),
            resolved: result,
            type: 'binary_op'
          });
          return { type: 'number', value: result };
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
          this.steps.push({
            step: ++this.stepCounter,
            expression: this.expression.slice(node.start, node.end),
            resolved: result ? 1 : 0,
            type: 'binary_op'
          });
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
        return this.traceFunction(node);
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

  traceFunction(node) {
    const funcName = node.value;

    switch (funcName) {
      case 'IF': {
        const cond = this.trace(node.children[0]);
        if (cond.type !== 'number') {
          throw new StructuredError(
            'IF的条件必须是数值类型',
            node.nameStart,
            node.nameEnd,
            this.expression
          );
        }
        const branch = cond.value !== 0 ? node.children[1] : node.children[2];
        const branchResult = this.trace(branch);
        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: branchResult.value,
          type: 'function'
        });
        return branchResult;
      }

      default: {
        const args = node.children.map(c => this.trace(c));

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

        this.steps.push({
          step: ++this.stepCounter,
          expression: this.expression.slice(node.start, node.end),
          resolved: result.value,
          type: 'function'
        });
        return result;
      }
    }
  }
}

function parseExpression(expression) {
  const parser = new Parser(expression);
  return parser.parse();
}

function evaluateExpression(ast, cellResolver, expression, crossNamespaceResolver) {
  const evaluator = new Evaluator(cellResolver, expression || null);
  evaluator.crossNamespaceResolver = crossNamespaceResolver || null;
  return evaluator.evaluate(ast);
}

function traceExpression(ast, cellResolver, expression, crossNamespaceResolver) {
  const tracer = new TracingEvaluator(cellResolver, expression);
  tracer.crossNamespaceResolver = crossNamespaceResolver || null;
  try {
    const result = tracer.trace(ast);
    return { steps: tracer.steps, result, error: null };
  } catch (e) {
    return {
      steps: tracer.steps,
      result: null,
      error: e instanceof StructuredError ? e.toJSON() : { message: e.message, position: null, context: null }
    };
  }
}

function findCellRefPosition(ast, refName) {
  if (!ast) return null;

  if (ast.type === 'CellRef' && ast.value === refName) {
    return { start: ast.start, end: ast.end };
  }

  if (ast.type === 'CrossRef' && ast.value === refName) {
    return { start: ast.start, end: ast.end };
  }

  for (const child of ast.children) {
    const pos = findCellRefPosition(child, refName);
    if (pos) return pos;
  }

  return null;
}

class ExpressionCompiler {
  constructor(expression) {
    this.expression = expression;
  }

  compile(node) {
    switch (node.type) {
      case 'Number': {
        const val = node.value;
        return () => ({ type: 'number', value: val });
      }

      case 'String': {
        const val = node.value;
        return () => ({ type: 'string', value: val });
      }

      case 'CellRef': {
        const refName = node.value;
        const start = node.start;
        const end = node.end;
        const expr = this.expression;
        return (cellResolver, crossResolver) => {
          const cell = cellResolver(refName);
          if (!cell) {
            throw new StructuredError(
              `引用的单元格 '${refName}' 不存在`,
              start, end, expr
            );
          }
          return cell.value;
        };
      }

      case 'CrossRef': {
        const refName = node.value;
        const ns = node.namespace;
        const cn = node.cellName;
        const start = node.start;
        const end = node.end;
        const expr = this.expression;
        return (cellResolver, crossResolver) => {
          if (!crossResolver) {
            throw new StructuredError(
              `跨命名空间引用 '${refName}' 不可用`,
              start, end, expr
            );
          }
          const result = crossResolver(ns, cn);
          if (!result) {
            throw new StructuredError(
              `跨命名空间引用 '${refName}' 无法解析`,
              start, end, expr
            );
          }
          if (result.error) {
            throw new StructuredError(result.error, start, end, expr);
          }
          return result.value;
        };
      }

      case 'UnaryOp': {
        const operandFn = this.compile(node.children[0]);
        const op = node.value;
        const start = node.start;
        const end = node.end;
        const expr = this.expression;
        if (op === '+') {
          return (cellResolver, crossResolver) => {
            const operand = operandFn(cellResolver, crossResolver);
            if (operand.type !== 'number') {
              throw new StructuredError(
                `一元运算符 '+' 只能用于数值类型`,
                start, end, expr
              );
            }
            return { type: 'number', value: operand.value };
          };
        } else {
          return (cellResolver, crossResolver) => {
            const operand = operandFn(cellResolver, crossResolver);
            if (operand.type !== 'number') {
              throw new StructuredError(
                `一元运算符 '-' 只能用于数值类型`,
                start, end, expr
              );
            }
            return { type: 'number', value: -operand.value };
          };
        }
      }

      case 'BinOp': {
        const leftFn = this.compile(node.children[0]);
        const rightFn = this.compile(node.children[1]);
        const op = node.value;
        const opStart = node.opStart;
        const opEnd = node.opEnd;
        const start = node.start;
        const end = node.end;
        const expr = this.expression;

        if (op === '+') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== 'number' || right.type !== 'number') {
              throw new StructuredError(
                `算术运算符 '+' 需要两个数值类型`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value + right.value };
          };
        }
        if (op === '-') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== 'number' || right.type !== 'number') {
              throw new StructuredError(
                `算术运算符 '-' 需要两个数值类型`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value - right.value };
          };
        }
        if (op === '*') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== 'number' || right.type !== 'number') {
              throw new StructuredError(
                `算术运算符 '*' 需要两个数值类型`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value * right.value };
          };
        }
        if (op === '/') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== 'number' || right.type !== 'number') {
              throw new StructuredError(
                `算术运算符 '/' 需要两个数值类型`,
                opStart, opEnd, expr
              );
            }
            if (right.value === 0) {
              throw new StructuredError('除数不能为零', opStart, opEnd, expr);
            }
            return { type: 'number', value: left.value / right.value };
          };
        }
        if (op === '>') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '>' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value > right.value ? 1 : 0 };
          };
        }
        if (op === '<') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '<' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value < right.value ? 1 : 0 };
          };
        }
        if (op === '>=') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '>=' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value >= right.value ? 1 : 0 };
          };
        }
        if (op === '<=') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '<=' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value <= right.value ? 1 : 0 };
          };
        }
        if (op === '==') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '==' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value === right.value ? 1 : 0 };
          };
        }
        if (op === '!=') {
          return (cellResolver, crossResolver) => {
            const left = leftFn(cellResolver, crossResolver);
            const right = rightFn(cellResolver, crossResolver);
            if (left.type !== right.type) {
              throw new StructuredError(
                `比较运算符 '!=' 需要两个相同类型的操作数`,
                opStart, opEnd, expr
              );
            }
            return { type: 'number', value: left.value !== right.value ? 1 : 0 };
          };
        }
        throw new StructuredError(`未知的二元运算符: ${op}`, opStart, opEnd, expr);
      }

      case 'Function': {
        return this.compileFunction(node);
      }

      default:
        throw new StructuredError(
          `未知的AST节点类型: ${node.type}`,
          node.start, node.end, this.expression
        );
    }
  }

  compileFunction(node) {
    const funcName = node.value;
    const nameStart = node.nameStart;
    const nameEnd = node.nameEnd;
    const expr = this.expression;
    const argFns = node.children.map(c => this.compile(c));

    switch (funcName) {
      case 'IF': {
        const condFn = argFns[0];
        const trueFn = argFns[1];
        const falseFn = argFns[2];
        return (cellResolver, crossResolver) => {
          const cond = condFn(cellResolver, crossResolver);
          if (cond.type !== 'number') {
            throw new StructuredError('IF的条件必须是数值类型', nameStart, nameEnd, expr);
          }
          return cond.value !== 0
            ? trueFn(cellResolver, crossResolver)
            : falseFn(cellResolver, crossResolver);
        };
      }

      case 'MIN': {
        return (cellResolver, crossResolver) => {
          const args = argFns.map(fn => fn(cellResolver, crossResolver));
          args.forEach((a, i) => {
            if (a.type !== 'number') {
              throw new StructuredError(
                `MIN的第 ${i + 1} 个参数必须是数值类型`,
                nameStart, nameEnd, expr
              );
            }
          });
          return { type: 'number', value: Math.min(...args.map(a => a.value)) };
        };
      }

      case 'MAX': {
        return (cellResolver, crossResolver) => {
          const args = argFns.map(fn => fn(cellResolver, crossResolver));
          args.forEach((a, i) => {
            if (a.type !== 'number') {
              throw new StructuredError(
                `MAX的第 ${i + 1} 个参数必须是数值类型`,
                nameStart, nameEnd, expr
              );
            }
          });
          return { type: 'number', value: Math.max(...args.map(a => a.value)) };
        };
      }

      case 'ABS': {
        const argFn = argFns[0];
        return (cellResolver, crossResolver) => {
          const a = argFn(cellResolver, crossResolver);
          if (a.type !== 'number') {
            throw new StructuredError('ABS的参数必须是数值类型', nameStart, nameEnd, expr);
          }
          return { type: 'number', value: Math.abs(a.value) };
        };
      }

      case 'ROUND': {
        const argFn0 = argFns[0];
        const argFn1 = argFns[1];
        return (cellResolver, crossResolver) => {
          const a0 = argFn0(cellResolver, crossResolver);
          const a1 = argFn1(cellResolver, crossResolver);
          if (a0.type !== 'number') {
            throw new StructuredError('ROUND的第一个参数必须是数值类型', nameStart, nameEnd, expr);
          }
          if (a1.type !== 'number') {
            throw new StructuredError('ROUND的第二个参数必须是数值类型', nameStart, nameEnd, expr);
          }
          const factor = Math.pow(10, Math.round(a1.value));
          return { type: 'number', value: Math.round(a0.value * factor) / factor };
        };
      }

      case 'CONCAT': {
        return (cellResolver, crossResolver) => {
          const args = argFns.map(fn => fn(cellResolver, crossResolver));
          const strs = args.map(a => a.value.toString());
          return { type: 'string', value: strs.join('') };
        };
      }

      default:
        throw new StructuredError(`未知的函数: ${funcName}`, nameStart, nameEnd, expr);
    }
  }
}

function compileExpression(ast, expression) {
  const compiler = new ExpressionCompiler(expression || null);
  return compiler.compile(ast);
}

module.exports = {
  parseExpression,
  evaluateExpression,
  traceExpression,
  compileExpression,
  StructuredError,
  findCellRefPosition
};
