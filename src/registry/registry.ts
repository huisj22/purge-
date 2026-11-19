/**
 * Agent/Host 注册表：统一持有适配器与发现结果。
 *
 * 「磁盘态 / 进程态 / 加载态」的判定全部落在适配器；注册表只做编排、缓存与事件。
 */
import { sha256 } from "../core/atomic.ts";
import type { EventBus } from "../core/events.ts";
import { EVENTS } from "../core/events.ts";
import { purgeError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import type { HostAdapter, HostCandidate, HostFacts } from "../adapters/types.ts";

export interface RegistryOptions {
  logger: Logger;
  bus: EventBus;
  /** 缓存有效期：避免每次请求都扫盘。 */
  cacheTtlMs?: number;
}

interface CachedFacts {
  facts: HostFacts;
  at: number;
}

export class HostRegistry {
  readonly #adapters: HostAdapter[] = [];
  readonly #logger: Logger;
  readonly #bus: EventBus;
  readonly #ttl: number;
  #candidates: HostCandidate[] = [];
  #discoveredAt = 0;
  #facts = new Map<string, CachedFacts>();

  constructor(opts: RegistryOptions) {
    this.#logger = opts.logger;
    this.#bus = opts.bus;
    this.#ttl = opts.cacheTtlMs ?? 5000;
  }

  addAdapter(adapter: HostAdapter): void {
    if (this.#adapters.some((a) => a.id === adapter.id)) {
      throw purgeError("invalid_argument", `adapter already registered: ${adapter.id}`);
    }
    this.#adapters.push(adapter);
  }

  adapters(): HostAdapter[] {
    return [...this.#adapters];
  }

  adapter(id: string): HostAdapter {
    const found = this.#adapters.find((a) => a.id === id);
    if (!found) throw purgeError("not_found", `adapter not registered: ${id}`);
    return found;
  }

  async discover(force = false): Promise<HostCandidate[]> {
    if (!force && this.#candidates.length > 0 && Date.now() - this.#discoveredAt < this.#ttl) {
      return this.#candidates;
    }
    const all: HostCandidate[] = [];
    const errors: Array<{ adapter: string; error: string }> = [];
    for (const adapter of this.#adapters) {
      try {
        const found = await adapter.discover();
        all.push(...found);
      } catch (err) {
        errors.push({ adapter: adapter.id, error: (err as Error).message });
        this.#logger.warn("adapter discover failed", { adapter: adapter.id, error: (err as Error).message });
      }
    }
    // 去重：同一 resources 目录只保留一次（不同适配器可能报同一路径）
    const seen = new Set<string>();
    const unique = all.filter((c) => {
      const key = `${c.resourcesDir ?? c.root}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.#candidates = unique;
    this.#discoveredAt = Date.now();
    this.#bus.emit(EVENTS.hostDiscovered, { count: unique.length, errors });
    if (errors.length > 0) {
      this.#logger.warn("some adapters failed", { errors });
    }
    return unique;
  }

  get(id: string): HostCandidate {
    const found = this.#candidates.find((c) => c.id === id);
    if (!found) throw purgeError("not_found", `host not found: ${id}`, { known: this.#candidates.map((c) => c.id) });
    return found;
  }

  async inspect(id: string, force = false): Promise<HostFacts> {
    const cached = this.#facts.get(id);
    if (!force && cached && Date.now() - cached.at < this.#ttl) return cached.facts;
    const candidate = this.get(id);
    const adapter = this.adapter(candidate.adapterId);
    const facts = await adapter.inspect(candidate);
    this.#facts.set(id, { facts, at: Date.now() });
    return facts;
  }

  invalidate(id?: string): void {
    if (id) this.#facts.delete(id);
    else this.#facts.clear();
  }

  /** 稳定 hostId：同一路径永远得到同一 id（跨重启可用）。 */
  static idFor(adapterId: string, dir: string): string {
    return `${adapterId}@${sha256(dir).slice(0, 10)}`;
  }

  capabilitiesFor(candidate: HostCandidate) {
    return this.adapter(candidate.adapterId).capabilities();
  }
}
