/** The part of `polar-math` this plugin calls. The package ships no types. */
declare module 'polar-math' {
  interface Result<T> {
    value: T | null;
    state: Record<string, unknown>;
  }
  export class Polar {
    static fromTable(table: unknown): Polar;
    speedAt(options: { tws: number; twa: number }): Result<number>;
    rangeAt(options: { tws: number }): Result<{ minTwa: number; maxTwa: number }>;
  }
}
