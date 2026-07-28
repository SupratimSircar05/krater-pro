export class LruCache {
  #values = new Map();
  constructor(capacity) {
    this.capacity = capacity;
  }
  get size() {
    return this.#values.size;
  }
  get(key) {
    return this.#values.get(key);
  }
  set(key, value) {
    this.#values.set(key, value);
    if (this.#values.size > this.capacity) {
      this.#values.delete(this.#values.keys().next().value);
    }
  }
}
