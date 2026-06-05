class CronParser {
  constructor() {
    this.fieldConfigs = [
      { name: 'second', min: 0, max: 59 },
      { name: 'minute', min: 0, max: 59 },
      { name: 'hour', min: 0, max: 23 },
      { name: 'dayOfMonth', min: 1, max: 31 },
      { name: 'month', min: 1, max: 12 },
      { name: 'dayOfWeek', min: 0, max: 6 }
    ];
  }

  parseField(fieldExpr, min, max) {
    if (fieldExpr === '*') {
      return this.range(min, max, 1);
    }

    const result = new Set();
    const parts = fieldExpr.split(',');

    for (const part of parts) {
      if (part.includes('/')) {
        const [rangePart, stepPart] = part.split('/');
        const step = parseInt(stepPart, 10);
        if (isNaN(step) || step <= 0) {
          throw new Error(`无效的步进值: ${stepPart}`);
        }

        let start, end;
        if (rangePart === '*') {
          start = min;
          end = max;
        } else if (rangePart.includes('-')) {
          const [s, e] = rangePart.split('-').map(x => parseInt(x, 10));
          start = s;
          end = e;
        } else {
          start = parseInt(rangePart, 10);
          end = max;
        }

        if (isNaN(start) || isNaN(end)) {
          throw new Error(`无效的范围: ${rangePart}`);
        }

        for (let i = start; i <= end; i += step) {
          result.add(i);
        }
      } else if (part.includes('-')) {
        const [start, end] = part.split('-').map(x => parseInt(x, 10));
        if (isNaN(start) || isNaN(end)) {
          throw new Error(`无效的范围: ${part}`);
        }
        for (let i = start; i <= end; i++) {
          result.add(i);
        }
      } else {
        const value = parseInt(part, 10);
        if (isNaN(value)) {
          throw new Error(`无效的值: ${part}`);
        }
        result.add(value);
      }
    }

    const values = Array.from(result).sort((a, b) => a - b);
    for (const v of values) {
      if (v < min || v > max) {
        throw new Error(`值 ${v} 超出范围 [${min}, ${max}]`);
      }
    }

    return values;
  }

  range(start, end, step) {
    const result = [];
    for (let i = start; i <= end; i += step) {
      result.push(i);
    }
    return result;
  }

  parse(expression) {
    const fields = expression.trim().split(/\s+/);
    
    if (fields.length !== 6) {
      throw new Error('cron表达式必须包含6个字段: 秒 分 时 日 月 周');
    }

    const schedule = {};

    for (let i = 0; i < this.fieldConfigs.length; i++) {
      const config = this.fieldConfigs[i];
      schedule[config.name] = this.parseField(fields[i], config.min, config.max);
    }

    return schedule;
  }

  getNextExecution(schedule, fromDate = new Date()) {
    const now = new Date(fromDate.getTime() + 1000);
    now.setMilliseconds(0);

    for (let attempt = 0; attempt < 60 * 60 * 24 * 366; attempt++) {
      const second = now.getSeconds();
      const minute = now.getMinutes();
      const hour = now.getHours();
      const dayOfMonth = now.getDate();
      const month = now.getMonth() + 1;
      const dayOfWeek = now.getDay();

      const secondMatch = schedule.second.includes(second);
      const minuteMatch = schedule.minute.includes(minute);
      const hourMatch = schedule.hour.includes(hour);
      const dayMatch = schedule.dayOfMonth.includes(dayOfMonth);
      const monthMatch = schedule.month.includes(month);
      const dowMatch = schedule.dayOfWeek.includes(dayOfWeek);

      if (secondMatch && minuteMatch && hourMatch && dayMatch && monthMatch && dowMatch) {
        return new Date(now);
      }

      now.setSeconds(now.getSeconds() + 1);
    }

    throw new Error('无法找到下一次执行时间（超过一年）');
  }

  shouldExecute(schedule, date = new Date()) {
    const second = date.getSeconds();
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    return (
      schedule.second.includes(second) &&
      schedule.minute.includes(minute) &&
      schedule.hour.includes(hour) &&
      schedule.dayOfMonth.includes(dayOfMonth) &&
      schedule.month.includes(month) &&
      schedule.dayOfWeek.includes(dayOfWeek)
    );
  }

  validate(expression) {
    try {
      this.parse(expression);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}

module.exports = { CronParser };
