import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * 追加式事件存储。事件一旦写入不允许原地修改；业务更正只能追加后继事件。
 * 可选地持久化到 JSONL 文件，服务重启后从文件恢复。
 */
export class EventStore {
  constructor(filePath = null) {
    this.filePath = filePath;
    this.events = [];
    this.ids = new Set();
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        const text = line.trim();
        if (!text) continue;
        const event = JSON.parse(text);
        if (!this.ids.has(event.event_id)) {
          this.ids.add(event.event_id);
          this.events.push(event);
        }
      }
    }
  }

  /** 追加单条事件；event_id 已存在时视为重复提交，直接忽略。 */
  append(event) {
    return this.appendBatch([event]);
  }

  /**
   * 原子追加一批事件：任一条与现有事件冲突（event_id 重复）则整批不写入。
   * 场地交接等需要多事件同时生效的场景必须使用批量追加。
   */
  appendBatch(batch) {
    if (batch.length === 0) return { appended: true, events: [] };
    for (const event of batch) {
      if (this.ids.has(event.event_id)) {
        return { appended: false, duplicate: true, events: [] };
      }
    }
    for (const event of batch) {
      event.version = this._nextVersion(event.aggregate_id);
      this.ids.add(event.event_id);
      this.events.push(event);
    }
    if (this.filePath) {
      appendFileSync(this.filePath, batch.map((event) => JSON.stringify(event)).join("\n") + "\n");
    }
    return { appended: true, events: batch };
  }

  _nextVersion(aggregateId) {
    let max = 0;
    for (const event of this.events) {
      if (event.aggregate_id === aggregateId && event.version > max) max = event.version;
    }
    return max + 1;
  }
}
