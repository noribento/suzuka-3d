/** Small seeded PRNG (mulberry32) so a race can be replayed deterministically. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next()
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** Approximately normal (sum of uniforms), mean 0, sd 1. */
  gauss(): number {
    let s = 0
    for (let i = 0; i < 6; i++) s += this.next()
    return (s - 3) / Math.sqrt(0.5)
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T
  }
}
