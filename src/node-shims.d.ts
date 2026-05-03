declare module "fs/promises" {
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function stat(path: string): Promise<Stats>;

  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export interface Stats {
    size: number;
    mtime: Date;
    isDirectory(): boolean;
    isFile(): boolean;
  }
}

declare module "path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
}

declare module "url" {
  export function fileURLToPath(url: string | URL): string;
}

type BufferEncoding = "utf8" | "utf-8";

declare const process: {
  cwd(): string;
  argv: string[];
  exitCode?: number;
};
