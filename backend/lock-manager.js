const crypto = require('crypto');

const LOCK_DURATION_MS = 5 * 60 * 1000;
const SCAN_INTERVAL_MS = 10 * 1000;

class LockManager {
  constructor() {
    this.locks = new Map();
    this.onLock = null;
    this.onUnlock = null;
    this.onExpire = null;
    this.interval = setInterval(() => this._scanExpired(), SCAN_INTERVAL_MS);
  }

  setCallbacks(onLock, onUnlock, onExpire) {
    this.onLock = onLock;
    this.onUnlock = onUnlock;
    this.onExpire = onExpire;
  }

  _generateToken() {
    return crypto.randomBytes(16).toString('hex');
  }

  _now() {
    return Date.now();
  }

  isLocked(cellName) {
    const lock = this.locks.get(cellName);
    if (!lock) return false;
    if (lock.expiresAt <= this._now()) {
      this._removeLock(cellName, 'expire');
      return false;
    }
    return true;
  }

  getLockInfo(cellName) {
    const lock = this.locks.get(cellName);
    if (!lock) return null;
    if (lock.expiresAt <= this._now()) {
      this._removeLock(cellName, 'expire');
      return null;
    }
    return {
      token: lock.token,
      lockedBy: lock.lockedBy,
      lockedAt: lock.lockedAt,
      expiresAt: lock.expiresAt
    };
  }

  getAllLocks() {
    const now = this._now();
    const result = [];
    const expired = [];
    for (const [name, lock] of this.locks.entries()) {
      if (lock.expiresAt <= now) {
        expired.push(name);
        continue;
      }
      result.push({
        name,
        operator: lock.lockedBy,
        lockedAt: lock.lockedAt,
        expiresAt: lock.expiresAt,
        remainingSeconds: Math.max(0, Math.ceil((lock.expiresAt - now) / 1000))
      });
    }
    for (const name of expired) {
      this._removeLock(name, 'expire');
    }
    return result;
  }

  checkAccess(cellName, token, isAdmin) {
    if (isAdmin) return true;
    const lock = this.locks.get(cellName);
    if (!lock) return true;
    if (lock.expiresAt <= this._now()) {
      this._removeLock(cellName, 'expire');
      return true;
    }
    return token === lock.token;
  }

  getLockedNames(names, token, isAdmin) {
    if (isAdmin) return [];
    const now = this._now();
    const locked = [];
    const expired = [];
    for (const name of names) {
      const lock = this.locks.get(name);
      if (!lock) continue;
      if (lock.expiresAt <= now) {
        expired.push(name);
        continue;
      }
      if (token !== lock.token) {
        locked.push({
          name,
          lockedBy: lock.lockedBy,
          expiresAt: lock.expiresAt
        });
      }
    }
    for (const name of expired) {
      this._removeLock(name, 'expire');
    }
    return locked;
  }

  lock(cellName, operator) {
    if (this.isLocked(cellName)) {
      const err = new Error(`单元格 '${cellName}' 已被锁定`);
      err.statusCode = 409;
      throw err;
    }
    const token = this._generateToken();
    const now = this._now();
    const expiresAt = now + LOCK_DURATION_MS;
    this.locks.set(cellName, {
      token,
      lockedBy: operator,
      lockedAt: now,
      expiresAt
    });
    if (this.onLock) {
      this.onLock(cellName, operator, expiresAt);
    }
    return { lockToken: token, expiresAt };
  }

  unlock(cellName, token, isAdmin) {
    const lock = this.locks.get(cellName);
    if (!lock) {
      return { success: true, unlocked: false, reason: 'not_locked' };
    }
    if (!isAdmin && token !== lock.token) {
      const err = new Error('锁令牌不匹配');
      err.statusCode = 403;
      throw err;
    }
    this._removeLock(cellName, 'unlock');
    return { success: true, unlocked: true };
  }

  renew(cellName, token, isAdmin) {
    const lock = this.locks.get(cellName);
    if (!lock) {
      const err = new Error(`单元格 '${cellName}' 未被锁定`);
      err.statusCode = 404;
      throw err;
    }
    if (!isAdmin && token !== lock.token) {
      const err = new Error('锁令牌不匹配');
      err.statusCode = 403;
      throw err;
    }
    const expiresAt = this._now() + LOCK_DURATION_MS;
    lock.expiresAt = expiresAt;
    return { expiresAt };
  }

  _removeLock(cellName, reason) {
    const lock = this.locks.get(cellName);
    if (!lock) return;
    this.locks.delete(cellName);
    if (reason === 'expire' && this.onExpire) {
      this.onExpire(cellName);
    } else if (reason === 'unlock' && this.onUnlock) {
      this.onUnlock(cellName);
    }
  }

  _scanExpired() {
    const now = this._now();
    const expired = [];
    for (const [name, lock] of this.locks.entries()) {
      if (lock.expiresAt <= now) {
        expired.push(name);
      }
    }
    for (const name of expired) {
      this._removeLock(name, 'expire');
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = { LockManager, LOCK_DURATION_MS };
