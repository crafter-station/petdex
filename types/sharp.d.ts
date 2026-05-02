declare module "sharp" {
  export type Sharp = {
    composite(input: unknown[]): Sharp;
    resize(width: number, height: number): Sharp;
    png(): Sharp;
    toBuffer(): Promise<Buffer>;
    toFile(path: string): Promise<unknown>;
  };

  export default function sharp(input?: unknown): Sharp;
}
