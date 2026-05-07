declare module "bun:test" {
  type TestCallback = () => void | Promise<void>;
  type Expectation = {
    not: Expectation;
    toBe(expected: unknown): void;
    toBeDefined(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatch(expected: RegExp): void;
  };

  export const describe: (name: string, callback: TestCallback) => void;
  export const expect: (actual: unknown, message?: string) => Expectation;
  export const it: (name: string, callback: TestCallback) => void;
}
