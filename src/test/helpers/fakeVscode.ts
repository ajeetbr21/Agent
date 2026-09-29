import * as fs from "node:fs/promises";
import * as path from "node:path";
import Module = require("node:module");

/**
 * Just enough of the `vscode` API (Uri + workspace.fs over a real temp folder) to exercise the
 * workspace file code in plain Node tests. Call installFakeVscode() before importing modules that
 * `import * as vscode from "vscode"`.
 */

class FakeUri {
  private constructor(readonly fsPath: string) {}

  static file(fsPath: string): FakeUri {
    return new FakeUri(path.resolve(fsPath));
  }

  static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri(path.join(base.fsPath, ...segments));
  }

  get path(): string {
    return this.fsPath.replace(/\\/g, "/");
  }

  toString(): string {
    return `file://${this.path}`;
  }
}

export interface FakeVscode {
  readonly root: string;
  setRoot(root: string): void;
}

let installed: FakeVscode | undefined;

export function installFakeVscode(): FakeVscode {
  if (installed) {
    return installed;
  }
  let root = "";
  const api = {
    Uri: FakeUri,
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    workspace: {
      get workspaceFolders() {
        return root ? [{ uri: FakeUri.file(root), name: "test", index: 0 }] : undefined;
      },
      fs: {
        readFile: async (uri: FakeUri) => new Uint8Array(await fs.readFile(uri.fsPath)),
        writeFile: async (uri: FakeUri, bytes: Uint8Array) => {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        delete: async (uri: FakeUri) => fs.rm(uri.fsPath, { force: false }),
        createDirectory: async (uri: FakeUri) => {
          await fs.mkdir(uri.fsPath, { recursive: true });
        },
        stat: async (uri: FakeUri) => fs.stat(uri.fsPath)
      }
    }
  };

  const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function load(request: string, ...rest: unknown[]) {
    return request === "vscode" ? api : originalLoad.call(this, request, ...rest);
  };

  installed = {
    get root() {
      return root;
    },
    setRoot(next: string) {
      root = next;
    }
  };
  return installed;
}
