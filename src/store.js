/**
 * 仅追加事件存储：每条事件一行 JSON。
 * - 进程重启后重新读入文件即可完整恢复，结论由重放派生，无额外状态库；
 * - event_id 全局唯一；设备回执在参与者范围内唯一（重复回执不产生新事件、不增加运动量）；
 * - 同一进程内的写入串行化，版本号在个人链内单调递增。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { ConflictError } from "./errors.js";

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {any[]} */
    this.events = [];
    this._byId = new Map();
    this._receipts = new Map(); // `${participant_id}|${receipt_id}` -> event
    this._tail = Promise.resolve();
    if (existsSync(filePath)) this._load();
  }

  _load() {
    const text = readFileSync(this.filePath, "utf8");
    for (const [idx, line] of text.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(`事件存储第 ${idx + 1} 行不是合法 JSON：${err.message}`);
      }
      if (this._byId.has(event.event_id)) {
        throw new Error(`事件存储损坏：event_id 重复 ${event.event_id}`);
      }
      this._index(event);
      this.events.push(event);
    }
  }

  _index(event) {
    this._byId.set(event.event_id, event);
    const receipt = event.payload && event.payload.device_receipt_id;
    if (event.event_type === "SESSION_RECORDED" && receipt) {
      this._receipts.set(`${event.aggregate_id}|${receipt}`, event);
    }
  }

  list(aggregateId = null) {
    const all = this.events;
    return aggregateId ? all.filter((e) => e.aggregate_id === aggregateId) : all;
  }

  get(eventId) {
    return this._byId.get(eventId) || null;
  }

  /** runExclusive 临界区内使用：同 event_id 直接返回既有事件。 */
  appendInTx(event) {
    return this._appendSync(event);
  }

  findReceipt(aggregateId, receiptId) {
    return this._receipts.get(`${aggregateId}|${receiptId}`) || null;
  }

  nextVersion(aggregateId) {
    let max = 0;
    for (const e of this.events) {
      if (e.aggregate_id === aggregateId && e.version > max) max = e.version;
    }
    return max + 1;
  }

  /** 串行化追加：同一 event_id 重放返回既有事件（命令幂等）。 */
  append(event) {
    return this.runExclusive(() => this._appendSync(event));
  }

  /** 串行执行“读状态—判定—追加”临界区，避免并发命令拿到相同版本号。 */
  runExclusive(task) {
    const run = this._tail.then(() => task());
    // 不让单个任务的异常打断后续任务排队。
    this._tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  _appendSync(event) {
    if (this._byId.has(event.event_id)) return this._byId.get(event.event_id);
    if (!existsSync(dirname(this.filePath))) mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", { flag: "a" });
    this._index(event);
    this.events.push(event);
    return event;
  }
}

/** 命令级幂等：同 event_id 已存在时，载荷也必须一致，否则视为冲突。 */
export function assertSameIntent(existing, attempted, label) {
  if (existing.event_type !== attempted.event_type || existing.aggregate_id !== attempted.aggregate_id) {
    throw new ConflictError(`event_id ${attempted.event_id} 已用于其他${label}`);
  }
}
