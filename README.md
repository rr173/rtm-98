# 多人协同表达式求值沙盘

一个交互式的多人协同表达式求值系统，后端维护有向计算图，前端用Canvas展示力导向布局的节点图。

## 功能特性

### 计算图引擎
- 支持常量和表达式两种单元格类型
- 表达式支持: 四则运算、比较运算、条件分支(IF)、内置函数(MIN, MAX, ABS, ROUND, CONCAT)
- 自定义递归下降表达式解析器，不使用eval或外部库
- 循环依赖检测(DFS染色法)，返回具体环路路径
- 拓扑排序增量重算，只更新受影响的下游节点
- 最多支持200个单元格

### 增量更新与WebSocket推送
- 修改常量时只重算下游子图
- 修改表达式时自动解除旧依赖并建立新依赖
- 删除时检查引用关系，阻止删除被引用的单元格
- 批量更新通过WebSocket一次性推送

### 前端节点图
- Canvas绘制力导向布局(自实现弹簧+斥力模型)
- 蓝色边框=常量，绿色边框=表达式，橙色边框=选中，黄色闪烁=刚更新
- 支持拖拽节点(拖拽后位置固定)、双击背景新建、双击节点编辑
- 右侧详情面板显示表达式、结果、上下游依赖、计算耗时

### 多人协同
- WebSocket实时同步所有连接
- 连接时推送完整状态，之后只推增量
- 顶部显示当前在线人数

### 批量操作
- `POST /api/cells/batch` - 原子性批量创建/更新
- `POST /api/cells/import` - JSON文件导入
- `GET /api/cells/export` - JSON文件导出

## 演示数据

启动后自动导入价格计算场景:
- unit_price = 100 (常量)
- quantity = 5 (常量)
- discount_rate = 0.1 (常量)
- subtotal = unit_price * quantity
- discount = subtotal * discount_rate
- total = subtotal - discount
- tax = total * 0.08
- final = total + tax
- status = IF(final > 500, "premium", "standard")

## 快速开始

### Docker Compose (推荐)

```bash
docker-compose up --build
```

打开 http://localhost:8080

### 手动运行

#### 后端
```bash
cd backend
npm install
npm start
```

#### 前端
```bash
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173

## API 接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/cells` | 获取所有单元格 |
| GET | `/api/cells/:name` | 获取单个单元格 |
| POST | `/api/cells` | 创建单元格 |
| PUT | `/api/cells/:name` | 更新单元格 |
| DELETE | `/api/cells/:name` | 删除单元格 |
| POST | `/api/cells/batch` | 批量操作 |
| POST | `/api/cells/import` | 导入计算图 |
| GET | `/api/cells/export` | 导出计算图 |

## WebSocket 消息格式

### 服务端推送

```javascript
// 初始化
{ type: 'init', data: { cells: [...], clientId: 1, onlineCount: 2 } }

// 批量更新
{ type: 'batch', data: { changes: [{ name, oldValue, newValue, computeTimeMs }] } }

// 删除
{ type: 'delete', data: { name } }

// 在线人数
{ type: 'online', data: { count: 3 } }
```

## 技术栈

- **后端**: Node.js + Express + ws
- **前端**: React + Vite + Canvas
- **部署**: Docker + Nginx
